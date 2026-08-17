import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { and, eq } from "drizzle-orm";

import {
  notifications,
  projectLeads,
  stockThresholds,
  users,
} from "../src/db/schema";
import { issueStock, recordMovement } from "../src/lib/ledger";
import { checkStockAlerts } from "../src/lib/stock-alerts";
import { createTestDb, makeFixtures, type TestDb } from "./harness";

/**
 * These tests defend the two rules the spec states about low-stock alerts:
 *
 *   "Admins + heads of that project"
 *   "Managers do not get individually pinged for every low-stock event"
 *
 * and the dedupe window, which is the difference between a useful alert and an
 * inbox nobody reads.
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

let personCounter = 0;

async function makePerson(
  role: "engineer" | "project_head" | "admin" | "manager",
) {
  const n = ++personCounter;
  const [row] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      googleSub: `notify-sub-${n}`,
      email: `notify${n}@autonexai360.com`,
      name: `Notify Person ${n}`,
      role,
    })
    .returning();
  return row;
}

async function notificationsFor(userId: string, type?: string) {
  return db
    .select()
    .from(notifications)
    .where(
      type
        ? and(eq(notifications.userId, userId), eq(notifications.type, type))
        : eq(notifications.userId, userId),
    );
}

describe("low-stock alerts", () => {
  test("reach admins and the project's heads, but not managers", async () => {
    const f = await makeFixtures(db);

    // The fixture user is an admin. Add the other three roles around it.
    const manager = await makePerson("manager");
    const head = await makePerson("project_head");
    const strangerHead = await makePerson("project_head");
    const engineer = await makePerson("engineer");

    await db
      .insert(projectLeads)
      .values({ projectId: f.project.id, userId: head.id });

    // A manager who also heads the project must still be left out: the spec
    // gives managers a weekly digest rather than a ping per shelf.
    await db
      .insert(projectLeads)
      .values({ projectId: f.project.id, userId: manager.id });

    await db.insert(stockThresholds).values({
      componentId: f.component.id,
      locationId: f.shelf.id,
      minQty: 5,
    });

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 10,
      reason: "receipt",
      userId: f.user.id,
    });

    await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 6,
      userId: f.user.id,
    });

    await checkStockAlerts(db, f.component.id, f.shelf.id);

    const forAdmin = await notificationsFor(f.user.id, "low_stock");
    const forHead = await notificationsFor(head.id, "low_stock");

    assert.equal(forAdmin.length, 1, "the admin should be told");
    assert.equal(forHead.length, 1, "the project's head should be told");
    assert.match(forHead[0].title, /running low/);
    assert.match(String(forHead[0].body), /4 left/);

    assert.deepEqual(
      await notificationsFor(manager.id),
      [],
      "managers get a digest, not a per-shelf ping",
    );
    assert.deepEqual(
      await notificationsFor(strangerHead.id),
      [],
      "a head of some other project is not involved",
    );
    assert.deepEqual(
      await notificationsFor(engineer.id),
      [],
      "engineers are not notified about stock levels",
    );
  });

  test("the same condition is not re-notified inside the window", async () => {
    const f = await makeFixtures(db);

    await db.insert(stockThresholds).values({
      componentId: f.component.id,
      locationId: f.shelf.id,
      minQty: 5,
    });

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 6,
      reason: "receipt",
      userId: f.user.id,
    });
    await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 2,
      userId: f.user.id,
    });

    await checkStockAlerts(db, f.component.id, f.shelf.id);
    await checkStockAlerts(db, f.component.id, f.shelf.id);
    await checkStockAlerts(db, f.component.id, f.shelf.id);

    const rows = await notificationsFor(f.user.id, "low_stock");
    assert.equal(rows.length, 1, "three checks, one notification");
  });

  test("an emptied shelf reports being out rather than merely low", async () => {
    const f = await makeFixtures(db);

    await db.insert(stockThresholds).values({
      componentId: f.component.id,
      locationId: f.shelf.id,
      minQty: 5,
    });

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 4,
      reason: "receipt",
      userId: f.user.id,
    });
    await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 4,
      userId: f.user.id,
    });

    await checkStockAlerts(db, f.component.id, f.shelf.id);

    const low = await notificationsFor(f.user.id, "low_stock");
    const out = await notificationsFor(f.user.id, "out_of_stock");

    assert.equal(out.length, 1, "zero on the shelf means out of stock");
    assert.equal(low.length, 0, "one event must not produce two notifications");
    assert.match(String(out[0].body), /Nothing left/);
  });

  test("a shelf that goes low and later empties produces both in turn", async () => {
    const f = await makeFixtures(db);

    await db.insert(stockThresholds).values({
      componentId: f.component.id,
      locationId: f.shelf.id,
      minQty: 5,
    });

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 10,
      reason: "receipt",
      userId: f.user.id,
    });

    await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 7,
      userId: f.user.id,
    });
    await checkStockAlerts(db, f.component.id, f.shelf.id);

    await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 3,
      userId: f.user.id,
    });
    await checkStockAlerts(db, f.component.id, f.shelf.id);

    // Separate dedupe keys, so the second, worse condition still gets through.
    assert.equal((await notificationsFor(f.user.id, "low_stock")).length, 1);
    assert.equal((await notificationsFor(f.user.id, "out_of_stock")).length, 1);
  });

  test("nothing is sent while stock is above the minimum", async () => {
    const f = await makeFixtures(db);

    await db.insert(stockThresholds).values({
      componentId: f.component.id,
      locationId: f.shelf.id,
      minQty: 2,
    });

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 10,
      reason: "receipt",
      userId: f.user.id,
    });

    await checkStockAlerts(db, f.component.id, f.shelf.id);

    assert.deepEqual(await notificationsFor(f.user.id), []);
  });

  test("a shelf with no minimum set still reports hitting zero", async () => {
    const f = await makeFixtures(db);

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 3,
      reason: "receipt",
      userId: f.user.id,
    });
    await checkStockAlerts(db, f.component.id, f.shelf.id);
    assert.deepEqual(
      await notificationsFor(f.user.id),
      [],
      "three in stock and no minimum is not a problem",
    );

    await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 3,
      userId: f.user.id,
    });
    await checkStockAlerts(db, f.component.id, f.shelf.id);

    assert.equal(
      (await notificationsFor(f.user.id, "out_of_stock")).length,
      1,
      "an empty shelf is worth knowing about whether or not a minimum was set",
    );
  });
});
