import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { eq } from "drizzle-orm";

import { listVendorsWithSpend } from "../src/db/queries/vendors";
import { orderLines, orders, vendors } from "../src/db/schema";
import { createTestDb, errorText, makeFixtures, type TestDb } from "./harness";

/**
 * Vendors.
 *
 * They are created by name while an invoice is being typed, so duplicates are a
 * matter of when rather than if. What these tests pin is the shape that makes a
 * merge safe — orders move first, because the database will not let a vendor with
 * orders behind it simply disappear — and that spend is counted the same way the
 * project page counts it.
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

async function makeVendor(name: string) {
  const [row] = await db.insert(vendors).values({ name }).returning();
  return row;
}

async function makeOrder(
  vendorId: string,
  componentId: string,
  opts: {
    total?: string | null;
    status?: "ordered" | "delivered" | "cancelled";
    qty?: number;
    unitPrice?: string;
  } = {},
) {
  const [order] = await db
    .insert(orders)
    .values({
      vendorId,
      channel: "online",
      status: opts.status ?? "ordered",
      orderDate: new Date(),
      totalAmount: opts.total === undefined ? "1000.00" : opts.total,
    })
    .returning();

  await db.insert(orderLines).values({
    orderId: order.id,
    componentId,
    qty: opts.qty ?? 2,
    unitPrice: opts.unitPrice ?? "250.00",
  });

  return order;
}

describe("vendor spend", () => {
  test("counts the invoice total, and the lines when there is none", async () => {
    const fresh = await createTestDb();
    try {
      const f = await makeFixtures(fresh.db);

      const [robu] = await fresh.db
        .insert(vendors)
        .values({ name: "Robu" })
        .returning();

      // One order with an invoice total, one without: the total is what was
      // actually charged and outranks the line sum, which is only an estimate of
      // it — shipping and tax live in the difference.
      const [withTotal] = await fresh.db
        .insert(orders)
        .values({
          vendorId: robu.id,
          channel: "online",
          status: "delivered",
          orderDate: new Date(),
          totalAmount: "1180.00",
        })
        .returning();
      await fresh.db.insert(orderLines).values({
        orderId: withTotal.id,
        componentId: f.component.id,
        qty: 4,
        unitPrice: "250.00",
      });

      const [noTotal] = await fresh.db
        .insert(orders)
        .values({
          vendorId: robu.id,
          channel: "online",
          status: "ordered",
          orderDate: new Date(),
          totalAmount: null,
        })
        .returning();
      await fresh.db.insert(orderLines).values({
        orderId: noTotal.id,
        componentId: f.component.id,
        qty: 2,
        unitPrice: "300.00",
      });

      const [row] = await listVendorsWithSpend(fresh.db);

      assert.equal(row.name, "Robu");
      assert.equal(row.orderCount, 2);
      assert.equal(row.spend, 1180 + 600);
    } finally {
      await fresh.client.close();
    }
  });

  test("a cancelled order is not spend, but is still an order", async () => {
    const fresh = await createTestDb();
    try {
      const f = await makeFixtures(fresh.db);
      const [mouser] = await fresh.db
        .insert(vendors)
        .values({ name: "Mouser" })
        .returning();

      const [cancelled] = await fresh.db
        .insert(orders)
        .values({
          vendorId: mouser.id,
          channel: "online",
          status: "cancelled",
          orderDate: new Date(),
          totalAmount: "5000.00",
        })
        .returning();
      await fresh.db.insert(orderLines).values({
        orderId: cancelled.id,
        componentId: f.component.id,
        qty: 1,
        unitPrice: "5000.00",
      });

      const [row] = await listVendorsWithSpend(fresh.db);

      assert.equal(row.orderCount, 1);
      assert.equal(row.spend, 0);
    } finally {
      await fresh.client.close();
    }
  });

  test("a vendor nobody has bought from reads as zero, not as missing", async () => {
    const fresh = await createTestDb();
    try {
      await fresh.db.insert(vendors).values({ name: "Never Used Ltd" });

      const rows = await listVendorsWithSpend(fresh.db);

      assert.equal(rows.length, 1);
      assert.equal(rows[0].orderCount, 0);
      assert.equal(rows[0].spend, 0);
      assert.equal(rows[0].lastOrderAt, null);
    } finally {
      await fresh.client.close();
    }
  });
});

describe("merging a duplicate", () => {
  test("a vendor with orders cannot simply be deleted", async () => {
    const f = await makeFixtures(db);
    const typo = await makeVendor("Robu Indai");
    await makeOrder(typo.id, f.component.id);

    // This is why the merge reassigns before it deletes, and why both halves are
    // in one transaction: the second statement can fail, and if it does the first
    // must not stand.
    await assert.rejects(
      () => db.delete(vendors).where(eq(vendors.id, typo.id)),
      (error: unknown) => /violates foreign key|restrict/i.test(errorText(error)),
    );
  });

  test("moving the orders first lets the duplicate go, and the spend follows", async () => {
    const f = await makeFixtures(db);
    const keep = await makeVendor("Robu");
    const drop = await makeVendor("robu.in");

    await makeOrder(keep.id, f.component.id, { total: "1000.00" });
    await makeOrder(drop.id, f.component.id, { total: "400.00" });
    await makeOrder(drop.id, f.component.id, { total: "600.00" });

    await db.transaction(async (tx) => {
      await tx
        .update(orders)
        .set({ vendorId: keep.id })
        .where(eq(orders.vendorId, drop.id));
      await tx.delete(vendors).where(eq(vendors.id, drop.id));
    });

    const rows = await listVendorsWithSpend(db);
    const survivor = rows.find((r) => r.id === keep.id);

    assert.ok(survivor);
    assert.equal(survivor.orderCount, 3);
    assert.equal(survivor.spend, 2000);
    assert.equal(
      rows.some((r) => r.id === drop.id),
      false,
      "the duplicate should be gone",
    );
  });

  test("an unused duplicate merges away without moving anything", async () => {
    const keep = await makeVendor("Amazon Business");
    const drop = await makeVendor("amazon business ");

    const moved = await db.transaction(async (tx) => {
      const rows = await tx
        .update(orders)
        .set({ vendorId: keep.id })
        .where(eq(orders.vendorId, drop.id))
        .returning({ id: orders.id });
      await tx.delete(vendors).where(eq(vendors.id, drop.id));
      return rows.length;
    });

    assert.equal(moved, 0);

    const rows = await listVendorsWithSpend(db);
    assert.equal(
      rows.some((r) => r.id === drop.id),
      false,
    );
  });
});
