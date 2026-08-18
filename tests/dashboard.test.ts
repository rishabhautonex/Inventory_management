import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  HEATMAP_BUCKETS,
  getActivityHeatmap,
  getMovementSeries,
  getStockHealth,
  listTopMovers,
} from "../src/db/queries/dashboard";
import { stockThresholds } from "../src/db/schema";
import { issueStock, recordMovement, reverseMovement } from "../src/lib/ledger";
import { createTestDb, makeFixtures, type TestDb } from "./harness";

/**
 * The dashboard's charts are read models over the same ledger everything else
 * reads, so what these tests defend is that the shapes are right: a day with no
 * movements is a zero rather than a missing point, a reversed movement stops
 * counting, and a shelf with a minimum but no stock reads as empty rather than
 * as healthy.
 */

let db: TestDb;
let client: { close: () => Promise<void> };

before(async () => {
  const created = await createTestDb();
  db = created.db;
  client = created.client;
});

after(async () => {
  await client.close();
});

describe("movement series", () => {
  test("returns one dense point per day, quiet days included", async () => {
    const series = await getMovementSeries(db, 14);

    assert.equal(series.length, 14);
    // A gap would let a chart draw a straight line across a quiet week.
    assert.ok(series.every((day) => Number.isInteger(day.movements)));
    assert.ok(series.every((day) => day.label.length > 0));

    const days = series.map((day) => day.day);
    assert.deepEqual([...days].sort(), days, "days come back in order");
  });

  test("splits today's units into in and out", async () => {
    const f = await makeFixtures(db);

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 12,
      reason: "receipt",
      userId: f.user.id,
    });
    await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 5,
      userId: f.user.id,
    });

    const series = await getMovementSeries(db, 7);
    const today = series[series.length - 1]!;

    assert.equal(today.unitsIn, 12);
    assert.equal(today.unitsOut, 5);
    assert.equal(today.movements, 2);
  });
});

describe("activity heatmap", () => {
  test("is a dense seven-by-twelve grid", async () => {
    const grid = await getActivityHeatmap(db, 28);

    assert.equal(grid.length, 7);
    assert.ok(grid.every((row) => row.length === HEATMAP_BUCKETS));
    assert.ok(grid.flat().every((count) => Number.isInteger(count)));

    // Whatever the other tests in this file inserted has to land somewhere.
    assert.ok(grid.flat().some((count) => count > 0));
  });
});

describe("top movers", () => {
  test("counts units taken out, and stops counting a reversed one", async () => {
    const f = await makeFixtures(db, { componentName: "Consumed Part" });

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 40,
      reason: "receipt",
      userId: f.user.id,
    });
    const issued = await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 9,
      userId: f.user.id,
    });

    const before = await listTopMovers(db, 30, 20);
    const beforeRow = before.find((m) => m.componentId === f.component.id);
    assert.equal(beforeRow?.unitsOut, 9);

    await reverseMovement(db, issued.id, f.user.id);

    const after = await listTopMovers(db, 30, 20);
    const afterRow = after.find((m) => m.componentId === f.component.id);
    // Both sides of the correction drop out: the issue and the reversal.
    assert.equal(afterRow, undefined);
  });
});

describe("stock health", () => {
  test("a watched shelf with nothing on it is empty, not healthy", async () => {
    const f = await makeFixtures(db, { componentName: "Watched Part" });

    await db.insert(stockThresholds).values({
      componentId: f.component.id,
      locationId: f.shelf.id,
      minQty: 5,
    });

    const empty = await getStockHealth(db);
    assert.ok(empty.tracked >= 1);
    assert.ok(empty.out >= 1);

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 5,
      reason: "receipt",
      userId: f.user.id,
    });

    // At the minimum is low, not healthy — the same rule the alerts use.
    const atMinimum = await getStockHealth(db);
    assert.equal(atMinimum.out, empty.out - 1);
    assert.equal(atMinimum.low, empty.low + 1);

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 1,
      reason: "receipt",
      userId: f.user.id,
    });

    const above = await getStockHealth(db);
    assert.equal(above.low, empty.low);
    assert.equal(above.healthy, empty.healthy + 1);
    assert.equal(
      above.healthy + above.low + above.out,
      above.tracked,
      "every watched pair falls into exactly one bucket",
    );
  });
});
