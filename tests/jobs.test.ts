import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { eq } from "drizzle-orm";

import { getWeeklyDigest } from "../src/db/queries/digest";
import { listOverdueOrders } from "../src/db/queries/orders";
import {
  notifications,
  orderLines,
  orders,
  partRequests,
  projectLeads,
  users,
} from "../src/db/schema";
import { issueStock, recordMovement, reverseMovement } from "../src/lib/ledger";
import { sendManagerDigest } from "../src/lib/manager-digest";
import { checkOverdueOrders } from "../src/lib/order-alerts";
import { createTestDb, makeFixtures, type TestDb } from "./harness";

/**
 * The two scheduled jobs.
 *
 * Both are in the spec and neither existed, so what these tests pin is mostly
 * the shape that keeps a job from becoming noise: who hears about a late
 * delivery, that hearing about it once is enough, and that a week in which
 * nothing happened produces no digest at all.
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
      googleSub: `job-sub-${n}`,
      email: `job${n}@autonexai360.com`,
      name: `Job Person ${n}`,
      role,
    })
    .returning();
  return row;
}

/** An order expected `daysAgo` days ago and still on its way. */
async function makeLateOrder(
  on: TestDb,
  projectId: string | null,
  componentId: string,
  opts: { daysAgo?: number; status?: "ordered" | "shipped" | "delivered" } = {},
) {
  const day = 24 * 60 * 60 * 1000;
  const expected = new Date(Date.now() - (opts.daysAgo ?? 3) * day);

  const [order] = await on
    .insert(orders)
    .values({
      projectId,
      channel: "online",
      status: opts.status ?? "ordered",
      orderDate: new Date(expected.getTime() - 7 * day),
      expectedDate: expected,
      totalAmount: "1200.00",
    })
    .returning();

  await on
    .insert(orderLines)
    .values({ orderId: order.id, componentId, qty: 5, unitPrice: "240.00" });

  return order;
}

async function typesFor(on: TestDb, userId: string) {
  const rows = await on
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId));
  return rows.map((r) => r.type);
}

describe("overdue deliveries", () => {
  test("reach admins and that project's heads, never managers", async () => {
    const f = await makeFixtures(db); // the fixture user is an admin
    const head = await makePerson("project_head");
    const otherHead = await makePerson("project_head");
    const manager = await makePerson("manager");
    const engineer = await makePerson("engineer");

    await db
      .insert(projectLeads)
      .values({ projectId: f.project.id, userId: head.id });

    await makeLateOrder(db, f.project.id, f.component.id, { daysAgo: 4 });

    const swept = await checkOverdueOrders(db);
    assert.equal(swept.checked, 1);

    assert.deepEqual(await typesFor(db, f.user.id), ["order_overdue"]);
    assert.deepEqual(await typesFor(db, head.id), ["order_overdue"]);

    // The digest is the manager's channel, and a head of some other project has
    // no standing here at all.
    assert.deepEqual(await typesFor(db, manager.id), []);
    assert.deepEqual(await typesFor(db, otherHead.id), []);
    assert.deepEqual(await typesFor(db, engineer.id), []);
  });

  test("a daily job does not re-notify the same order daily", async () => {
    const f = await makeFixtures(db);
    await makeLateOrder(db, f.project.id, f.component.id, { daysAgo: 9 });

    const first = await checkOverdueOrders(db);
    const second = await checkOverdueOrders(db);

    assert.ok(first.notified > 0, "the first sweep should notify");
    assert.equal(
      second.notified,
      0,
      "an order that is still late is not news a day later",
    );
  });

  // The next two run against their own database. Both assert on what an admin
  // did *not* hear, and an admin hears about every project in the lab — so a
  // late order left behind by an earlier test in this file would answer for it.
  test("an order that arrived is not overdue, however late it was", async () => {
    const fresh = await createTestDb();
    try {
      const f = await makeFixtures(fresh.db);
      await makeLateOrder(fresh.db, f.project.id, f.component.id, {
        daysAgo: 30,
        status: "delivered",
      });

      assert.deepEqual(await listOverdueOrders(fresh.db), []);
    } finally {
      await fresh.client.close();
    }
  });

  test("an order on the general shelf reaches admins, not everybody", async () => {
    const fresh = await createTestDb();
    try {
      const f = await makeFixtures(fresh.db);

      const [head] = await fresh.db
        .insert(users)
        .values({
          id: crypto.randomUUID(),
          googleSub: "shelf-head",
          email: "shelf-head@autonexai360.com",
          name: "Shelf Head",
          role: "project_head",
        })
        .returning();

      await fresh.db
        .insert(projectLeads)
        .values({ projectId: f.project.id, userId: head.id });

      // No project: the general shelf has no head, and a null must not widen
      // into "everybody".
      await makeLateOrder(fresh.db, null, f.component.id, { daysAgo: 2 });

      await checkOverdueOrders(fresh.db);

      assert.deepEqual(await typesFor(fresh.db, f.user.id), ["order_overdue"]);
      assert.deepEqual(await typesFor(fresh.db, head.id), []);
    } finally {
      await fresh.client.close();
    }
  });

  test("lateness is counted in whole days", async () => {
    const f = await makeFixtures(db);
    const order = await makeLateOrder(db, f.project.id, f.component.id, {
      daysAgo: 5,
    });

    const rows = await listOverdueOrders(db);
    const row = rows.find((r) => r.id === order.id);
    assert.ok(row, "the late order should be listed");
    assert.ok(row.daysLate >= 4 && row.daysLate <= 6, `got ${row.daysLate}`);
    assert.equal(row.lineCount, 1);
  });
});

describe("the manager digest", () => {
  test("a quiet week sends nothing", async () => {
    const fresh = await createTestDb();
    try {
      const [manager] = await fresh.db
        .insert(users)
        .values({
          id: crypto.randomUUID(),
          googleSub: "quiet-manager",
          email: "quiet@autonexai360.com",
          name: "Quiet Manager",
          role: "manager",
        })
        .returning();

      const result = await sendManagerDigest(fresh.db);

      assert.equal(result.sent, 0);
      assert.equal(result.skipped, "quiet_week");

      const rows = await fresh.db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, manager.id));
      assert.deepEqual(rows, []);
    } finally {
      await fresh.client.close();
    }
  });

  test("reaches managers only, once per week", async () => {
    const f = await makeFixtures(db);
    const manager = await makePerson("manager");
    const engineer = await makePerson("engineer");

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 20,
      reason: "receipt",
      userId: f.user.id,
    });
    await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 6,
      userId: engineer.id,
    });

    const first = await sendManagerDigest(db);
    assert.ok(first.sent >= 1);

    const forManager = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, manager.id));

    assert.equal(forManager.length, 1);
    assert.equal(forManager[0].type, "weekly_digest");
    assert.match(forManager[0].title, /Weekly digest/);
    assert.match(String(forManager[0].body), /this week/);

    // Nobody else is on this list.
    assert.deepEqual(await typesFor(db, engineer.id), []);

    const second = await sendManagerDigest(db);
    assert.equal(second.sent, 0, "one digest per ISO week, retries included");
  });

  test("counts what happened and drops what did not", async () => {
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
      qty: 4,
      userId: f.user.id,
    });

    await db.insert(partRequests).values({
      requestedBy: f.user.id,
      projectId: f.project.id,
      componentId: f.component.id,
      qty: 3,
      reason: "prototype",
      status: "pending",
    });

    const digest = await getWeeklyDigest(db);

    assert.match(digest.weekKey, /^\d{4}-W\d{2}$/);
    assert.ok(digest.unitsOut >= 4);
    assert.ok(digest.unitsIn >= 12);
    assert.ok(digest.pendingRequests >= 1);
    assert.ok(digest.topParts.length > 0);
    assert.ok(digest.topParts.every((p) => p.unitsOut > 0));
  });

  test("a reversed movement is not activity", async () => {
    const fresh = await createTestDb();
    try {
      const f = await makeFixtures(fresh.db);

      const movement = await recordMovement(fresh.db, {
        componentId: f.component.id,
        locationId: f.shelf.id,
        qtyDelta: 9,
        reason: "receipt",
        userId: f.user.id,
      });

      const before = await getWeeklyDigest(fresh.db);
      assert.equal(before.movements, 1);

      await reverseMovement(fresh.db, movement.id, f.user.id);

      const after = await getWeeklyDigest(fresh.db);
      assert.equal(
        after.movements,
        0,
        "a correction is two rows and neither of them is work that happened",
      );
      assert.equal(after.unitsIn, 0);
    } finally {
      await fresh.client.close();
    }
  });
});
