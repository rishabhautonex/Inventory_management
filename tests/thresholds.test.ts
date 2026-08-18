import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getThresholdCoverage } from "../src/db/queries/thresholds";
import { stockThresholds } from "../src/db/schema";
import { recordMovement } from "../src/lib/ledger";
import { createTestDb, makeFixtures } from "./harness";

/**
 * Threshold coverage.
 *
 * The point of this read model is the distinction the rest of the app keeps
 * making and the screens kept hiding: a shelf with no minimum is not healthy, it
 * is unwatched. No low-stock alert can fire for it, so it will empty in silence.
 */

describe("threshold coverage", () => {
  test("a stocked shelf with no minimum is reported as unwatched", async () => {
    const fresh = await createTestDb();
    try {
      const f = await makeFixtures(fresh.db);

      await recordMovement(fresh.db, {
        componentId: f.component.id,
        locationId: f.shelf.id,
        qtyDelta: 12,
        reason: "receipt",
        userId: f.user.id,
      });

      const coverage = await getThresholdCoverage(fresh.db);

      assert.equal(coverage.counts.unwatched, 1);
      assert.equal(coverage.counts.watched, 0);
      assert.equal(coverage.unwatched.length, 1);
      assert.equal(coverage.unwatched[0].componentId, f.component.id);
      assert.equal(coverage.unwatched[0].minQty, null);
      assert.equal(coverage.unwatched[0].onHand, 12);
    } finally {
      await fresh.client.close();
    }
  });

  test("setting a minimum moves the shelf from unwatched to watched", async () => {
    const fresh = await createTestDb();
    try {
      const f = await makeFixtures(fresh.db);

      await recordMovement(fresh.db, {
        componentId: f.component.id,
        locationId: f.shelf.id,
        qtyDelta: 12,
        reason: "receipt",
        userId: f.user.id,
      });

      await fresh.db.insert(stockThresholds).values({
        componentId: f.component.id,
        locationId: f.shelf.id,
        minQty: 4,
      });

      const coverage = await getThresholdCoverage(fresh.db);

      assert.equal(coverage.counts.unwatched, 0);
      assert.equal(coverage.counts.watched, 1);
      assert.equal(coverage.counts.breaching, 0);
      assert.equal(coverage.watched[0].minQty, 4);
    } finally {
      await fresh.client.close();
    }
  });

  test("a minimum whose shelf has never seen a movement is empty, not missing", async () => {
    const fresh = await createTestDb();
    try {
      const f = await makeFixtures(fresh.db);

      // No movements at all: there is no `stock_on_hand` row to join to, and an
      // inner join here would drop exactly the shelf that most needs restocking.
      await fresh.db.insert(stockThresholds).values({
        componentId: f.component.id,
        locationId: f.shelf.id,
        minQty: 3,
      });

      const coverage = await getThresholdCoverage(fresh.db);

      assert.equal(coverage.watched.length, 1);
      assert.equal(coverage.watched[0].onHand, 0);
      assert.equal(coverage.counts.breaching, 1);
    } finally {
      await fresh.client.close();
    }
  });

  test("the worst-off shelf is listed first", async () => {
    const fresh = await createTestDb();
    try {
      const a = await makeFixtures(fresh.db, { componentName: "Nearly gone" });
      const b = await makeFixtures(fresh.db, { componentName: "Comfortable" });

      await recordMovement(fresh.db, {
        componentId: a.component.id,
        locationId: a.shelf.id,
        qtyDelta: 1,
        reason: "receipt",
        userId: a.user.id,
      });
      await recordMovement(fresh.db, {
        componentId: b.component.id,
        locationId: b.shelf.id,
        qtyDelta: 18,
        reason: "receipt",
        userId: b.user.id,
      });

      await fresh.db.insert(stockThresholds).values([
        { componentId: a.component.id, locationId: a.shelf.id, minQty: 10 },
        { componentId: b.component.id, locationId: b.shelf.id, minQty: 20 },
      ]);

      const coverage = await getThresholdCoverage(fresh.db);

      // Ordered by the fraction of the minimum still on the shelf, so 1-of-10
      // outranks 18-of-20 — the shelf actually worth walking to.
      assert.equal(coverage.watched[0].componentName, "Nearly gone");
      assert.equal(coverage.counts.breaching, 2);
    } finally {
      await fresh.client.close();
    }
  });

  test("an inactive location is neither watched nor unwatched", async () => {
    const fresh = await createTestDb();
    try {
      const f = await makeFixtures(fresh.db);

      await recordMovement(fresh.db, {
        componentId: f.component.id,
        locationId: f.shelf.id,
        qtyDelta: 5,
        reason: "receipt",
        userId: f.user.id,
      });

      const { locations } = await import("../src/db/schema");
      const { eq } = await import("drizzle-orm");
      await fresh.db
        .update(locations)
        .set({ isActive: false })
        .where(eq(locations.id, f.cupboard.id));

      const coverage = await getThresholdCoverage(fresh.db);

      // The shelf inherits the cupboard's retirement through location_tree, so
      // a decommissioned cupboard stops nagging.
      assert.equal(coverage.counts.unwatched, 0);
      assert.equal(coverage.unwatched.length, 0);
    } finally {
      await fresh.client.close();
    }
  });
});
