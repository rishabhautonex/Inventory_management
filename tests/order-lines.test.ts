import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { eq } from "drizzle-orm";

import { getOrder } from "../src/db/queries/orders";
import { orderLines, orders } from "../src/db/schema";
import { recordMovement, reverseMovement } from "../src/lib/ledger";
import { createTestDb, errorText, makeFixtures, type TestDb } from "./harness";

/**
 * Correcting an order's lines.
 *
 * An order is an intention, so its lines can be edited — but the ledger is not an
 * intention, and a receipt points at the line it arrived against. These tests pin
 * the boundary between the two: what an edit may change, and what the database
 * refuses to let it change.
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

async function makeOrderWithLine(qty = 5) {
  const f = await makeFixtures(db);

  const [order] = await db
    .insert(orders)
    .values({
      projectId: f.project.id,
      channel: "offline",
      status: "delivered",
      orderDate: new Date(),
      totalAmount: "1000.00",
    })
    .returning();

  const [line] = await db
    .insert(orderLines)
    .values({
      orderId: order.id,
      componentId: f.component.id,
      qty,
      unitPrice: "200.00",
    })
    .returning();

  return { ...f, order, line };
}

describe("what an edit may change", () => {
  test("raising the quantity reopens the line, without touching the ledger", async () => {
    const t = await makeOrderWithLine(5);

    await recordMovement(db, {
      componentId: t.component.id,
      locationId: t.shelf.id,
      qtyDelta: 5,
      reason: "receipt",
      userId: t.user.id,
      orderLineId: t.line.id,
    });

    const complete = await getOrder(db, t.order.id);
    assert.equal(complete?.lines[0].remainingQty, 0);

    // The invoice actually said eight. Correcting the line leaves the five that
    // arrived exactly as they are, and three are outstanding again.
    await db
      .update(orderLines)
      .set({ qty: 8 })
      .where(eq(orderLines.id, t.line.id));

    const reopened = await getOrder(db, t.order.id);
    assert.equal(reopened?.lines[0].qty, 8);
    assert.equal(reopened?.lines[0].shelvedQty, 5);
    assert.equal(reopened?.lines[0].remainingQty, 3);
  });

  test("shelved quantity is derived, so an edit cannot inflate it", async () => {
    const t = await makeOrderWithLine(10);

    await recordMovement(db, {
      componentId: t.component.id,
      locationId: t.shelf.id,
      qtyDelta: 4,
      reason: "receipt",
      userId: t.user.id,
      orderLineId: t.line.id,
    });

    // Lowering the ordered quantity says nothing about what arrived: there is no
    // `shelved_qty` column to fall out of step with the ledger.
    await db
      .update(orderLines)
      .set({ qty: 6 })
      .where(eq(orderLines.id, t.line.id));

    const after = await getOrder(db, t.order.id);
    assert.equal(after?.lines[0].shelvedQty, 4);
    assert.equal(after?.lines[0].remainingQty, 2);
  });

  test("undoing the receipt puts the line back to nothing arrived", async () => {
    const t = await makeOrderWithLine(3);

    const receipt = await recordMovement(db, {
      componentId: t.component.id,
      locationId: t.shelf.id,
      qtyDelta: 3,
      reason: "receipt",
      userId: t.user.id,
      orderLineId: t.line.id,
    });

    await reverseMovement(db, receipt.id, t.user.id);

    const after = await getOrder(db, t.order.id);
    assert.equal(after?.lines[0].shelvedQty, 0);
    assert.equal(after?.lines[0].remainingQty, 3);
  });
});

describe("what the database refuses", () => {
  test("a line with a receipt against it cannot be deleted", async () => {
    const t = await makeOrderWithLine(2);

    await recordMovement(db, {
      componentId: t.component.id,
      locationId: t.shelf.id,
      qtyDelta: 2,
      reason: "receipt",
      userId: t.user.id,
      orderLineId: t.line.id,
    });

    // `stock_movements.order_line_id` is ON DELETE restrict, so the action's
    // guard is backed by the database rather than being the only thing standing
    // between a shelf full of parts and no record of where they came from.
    await assert.rejects(
      () => db.delete(orderLines).where(eq(orderLines.id, t.line.id)),
      (error: unknown) => /violates foreign key|restrict/i.test(errorText(error)),
    );
  });

  test("a line nothing has arrived against can be deleted", async () => {
    const t = await makeOrderWithLine(4);

    await db.delete(orderLines).where(eq(orderLines.id, t.line.id));

    const after = await getOrder(db, t.order.id);
    assert.equal(after?.lines.length, 0);
  });

  test("a zero or negative quantity is refused", async () => {
    const t = await makeOrderWithLine(4);

    await assert.rejects(
      () =>
        db
          .update(orderLines)
          .set({ qty: 0 })
          .where(eq(orderLines.id, t.line.id)),
      (error: unknown) =>
        /order_lines_qty_positive/.test(errorText(error)),
    );
  });
});
