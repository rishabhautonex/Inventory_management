import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { getOrder, listOrders } from "../src/db/queries/orders";
import { orderLines, orders, vendors } from "../src/db/schema";
import { getOnHand, recordMovement, reverseMovement } from "../src/lib/ledger";
import { candidateLines } from "../src/lib/invoice-match";
import { createTestDb, errorText, makeFixtures, type TestDb } from "./harness";

/**
 * Orders own an *intent* to buy; the ledger owns what is on the shelf. These
 * tests pin the seam between them:
 *
 *   - ordering something moves no stock
 *   - only a receipt does, and it carries `order_line_id`
 *   - "how much of this line has arrived" is derived, so undoing a receipt
 *     reopens the line with no second place to update
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

let vendorCounter = 0;

async function makeOrder(
  f: Awaited<ReturnType<typeof makeFixtures>>,
  opts: { qty?: number; expectedDate?: Date; channel?: "online" | "offline" } = {},
) {
  const [vendor] = await db
    .insert(vendors)
    .values({ name: `Vendor ${++vendorCounter}` })
    .returning();

  const [order] = await db
    .insert(orders)
    .values({
      vendorId: vendor.id,
      projectId: f.project.id,
      channel: opts.channel ?? "online",
      expectedDate: opts.expectedDate ?? null,
      currency: "INR",
      createdBy: f.user.id,
    })
    .returning();

  const [line] = await db
    .insert(orderLines)
    .values({
      orderId: order.id,
      componentId: f.component.id,
      qty: opts.qty ?? 10,
      unitPrice: "42.50",
    })
    .returning();

  return { order, line, vendor };
}

describe("orders keep their distance from the ledger", () => {
  test("recording an order moves no stock", async () => {
    const f = await makeFixtures(db);
    await makeOrder(f, { qty: 25 });

    assert.equal(
      await getOnHand(db, f.component.id, f.shelf.id),
      0,
      "ordering 25 of something does not put 25 on a shelf",
    );

    const detail = await getOrder(db, (await makeOrder(f)).order.id);
    assert.equal(detail?.lines[0].shelvedQty, 0);
    assert.equal(detail?.status, "ordered");
  });

  test("a movement may only carry an order line when it is a receipt", async () => {
    const f = await makeFixtures(db);
    const { line } = await makeOrder(f);

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 5,
      reason: "receipt",
      userId: f.user.id,
      orderLineId: line.id,
    });

    // The database refuses the wrong pairing, so no code path can invent a
    // "return against an order line" and quietly skew the arrived quantity.
    await assert.rejects(
      () =>
        recordMovement(db, {
          componentId: f.component.id,
          locationId: f.shelf.id,
          qtyDelta: 3,
          reason: "return",
          userId: f.user.id,
          orderLineId: line.id,
        }),
      (error: unknown) =>
        /receipt_shape/i.test(errorText(error)) ||
        /violates check constraint/i.test(errorText(error)),
    );
  });
});

describe("shelving, partially and completely", () => {
  test("a partial receipt leaves the rest outstanding", async () => {
    const f = await makeFixtures(db);
    const { order, line } = await makeOrder(f, { qty: 10 });

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 4,
      reason: "receipt",
      userId: f.user.id,
      orderLineId: line.id,
    });

    const detail = await getOrder(db, order.id);
    assert.equal(detail?.lines[0].shelvedQty, 4);
    assert.equal(detail?.lines[0].remainingQty, 6);
    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 4);

    const [listed] = await listOrders(db, {});
    assert.ok(listed, "the order appears in the list");
  });

  test("the arrived quantity is the sum of every receipt on the line", async () => {
    const f = await makeFixtures(db);
    const { order, line } = await makeOrder(f, { qty: 10 });

    for (const qty of [3, 3, 4]) {
      await recordMovement(db, {
        componentId: f.component.id,
        locationId: f.shelf.id,
        qtyDelta: qty,
        reason: "receipt",
        userId: f.user.id,
        orderLineId: line.id,
      });
    }

    const detail = await getOrder(db, order.id);
    assert.equal(detail?.lines[0].shelvedQty, 10);
    assert.equal(detail?.lines[0].remainingQty, 0);
  });

  test("a line can be split across two different shelves", async () => {
    const f = await makeFixtures(db);
    const { order, line } = await makeOrder(f, { qty: 8 });

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 5,
      reason: "receipt",
      userId: f.user.id,
      orderLineId: line.id,
    });
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.cupboard.id,
      qtyDelta: 3,
      reason: "receipt",
      userId: f.user.id,
      orderLineId: line.id,
    });

    const detail = await getOrder(db, order.id);
    assert.equal(detail?.lines[0].shelvedQty, 8, "the line is fully arrived");
    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 5);
    assert.equal(await getOnHand(db, f.component.id, f.cupboard.id), 3);
  });
});

describe("undoing a receipt reopens the line", () => {
  test("because the arrived quantity is derived, not stored", async () => {
    const f = await makeFixtures(db);
    const { order, line } = await makeOrder(f, { qty: 6 });

    const receipt = await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 6,
      reason: "receipt",
      userId: f.user.id,
      orderLineId: line.id,
    });

    let detail = await getOrder(db, order.id);
    assert.equal(detail?.lines[0].remainingQty, 0, "fully arrived");

    await reverseMovement(db, receipt.id, f.user.id);

    detail = await getOrder(db, order.id);
    assert.equal(
      detail?.lines[0].shelvedQty,
      0,
      "the reversed receipt no longer counts as arrived",
    );
    assert.equal(detail?.lines[0].remainingQty, 6, "the line is outstanding again");
    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 0);
  });
});

describe("overdue detection", () => {
  test("an order past its expected date and not yet delivered is flagged", async () => {
    const f = await makeFixtures(db);

    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const { order } = await makeOrder(f, { expectedDate: past });

    const detail = await getOrder(db, order.id);
    assert.equal(detail?.isOverdue, true);

    const rows = await listOrders(db, {});
    assert.equal(
      rows.find((r) => r.id === order.id)?.isOverdue,
      true,
      "and in the list, where it sorts to the top",
    );
  });

  test("an order with no expected date is never overdue", async () => {
    const f = await makeFixtures(db);
    const { order } = await makeOrder(f);

    const detail = await getOrder(db, order.id);
    assert.equal(detail?.isOverdue, false);
  });
});

describe("invoice line candidates", () => {
  test("product lines survive and invoice furniture is dropped", () => {
    const ocr = [
      "ROBU.IN INVOICE",
      "Invoice No: RBU-2026-4471    Date: 12/02/2026",
      "GSTIN: 27ABCDE1234F1Z5",
      "Description                 Qty    Rate      Amount",
      "ESP32 DevKit V1 WROOM       10     420.00    4200.00",
      "SG90 Micro Servo Motor      25     139.00    3475.00",
      "GST 18%                                      1452.78",
      "Grand Total                                  9523.78",
      "Authorised Signatory",
    ].join("\n");

    const lines = candidateLines(ocr);

    assert.ok(
      lines.some((l) => l.startsWith("ESP32 DevKit V1 WROOM")),
      `expected the ESP32 line, got ${JSON.stringify(lines)}`,
    );
    assert.ok(lines.some((l) => l.startsWith("SG90 Micro Servo Motor")));

    for (const noise of ["Grand Total", "GST 18%", "GSTIN", "Authorised"]) {
      assert.ok(
        !lines.some((l) => l.includes(noise)),
        `"${noise}" should not be offered as a product line`,
      );
    }
  });

  test("the numeric columns are stripped off the description", () => {
    const lines = candidateLines("ESP32 DevKit V1 WROOM 10 420.00 4200.00");

    assert.deepEqual(lines, ["ESP32 DevKit V1 WROOM"]);
  });

  test("a description ending in a number keeps its letters", () => {
    // "40pin" must not be mistaken for a quantity column and shaved off.
    const lines = candidateLines("Jumper Wire Set 40pin 4 99.00 396.00");

    assert.deepEqual(lines, ["Jumper Wire Set 40pin"]);
  });

  test("rows of pure figures are not product lines", () => {
    assert.deepEqual(candidateLines("12 4200.00 756.00 4956.00"), []);
  });
});
