import { sql } from "drizzle-orm";

import { runQuery } from "@/db/rows";
import { orderLines, orders, vendors } from "@/db/schema";
import type { Database } from "@/db/types";

/**
 * Order creation, shared by the two ways in.
 *
 * The form-first flow and the invoice-first flow build the same row, and having
 * one place that writes it means a column added later cannot be filled in by one
 * path and forgotten by the other.
 */

export type NewOrderLine = {
  componentId: string;
  qty: number;
  unitPrice: number | null;
};

export type NewOrder = {
  vendorId: string | null;
  projectId: string | null;
  channel: "online" | "offline";
  orderDate: Date | null;
  expectedDate: Date | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  totalAmount: number | null;
  createdBy: string;
  invoiceFileUrl?: string | null;
  invoiceMime?: string | null;
  invoiceOcrText?: string | null;
};

/** Reuses a vendor with the same name rather than accumulating duplicates. */
export async function resolveVendorByName(
  db: Database,
  name: string | null | undefined,
): Promise<string | null> {
  const trimmed = name?.trim();
  if (!trimmed) return null;

  const existing = await runQuery<{ id: string }>(
    db,
    sql`SELECT id FROM vendors WHERE lower(name) = lower(${trimmed}) LIMIT 1`,
  );
  if (existing[0]) return existing[0].id;

  const [created] = await db
    .insert(vendors)
    .values({ name: trimmed })
    .returning();
  return created.id;
}

/**
 * Inserts an order and its lines in one transaction.
 *
 * Returns each line's id keyed by component, because the invoice-first flow
 * turns straight around and records receipts against them.
 */
export async function insertOrderWithLines(
  db: Database,
  order: NewOrder,
  lines: NewOrderLine[],
): Promise<{ orderId: string; lineIdByComponent: Map<string, string> }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(orders)
      .values({
        vendorId: order.vendorId,
        projectId: order.projectId,
        channel: order.channel,
        orderDate: order.orderDate ?? new Date(),
        expectedDate: order.expectedDate,
        trackingNumber: order.trackingNumber,
        trackingUrl: order.trackingUrl,
        totalAmount:
          order.totalAmount === null ? null : String(order.totalAmount),
        currency: "INR",
        status: "ordered",
        createdBy: order.createdBy,
        invoiceFileUrl: order.invoiceFileUrl ?? null,
        invoiceMime: order.invoiceMime ?? null,
        invoiceOcrText: order.invoiceOcrText ?? null,
      })
      .returning();

    const inserted = await tx
      .insert(orderLines)
      .values(
        lines.map((line) => ({
          orderId: row.id,
          componentId: line.componentId,
          qty: line.qty,
          unitPrice: line.unitPrice === null ? null : String(line.unitPrice),
        })),
      )
      .returning();

    return {
      orderId: row.id,
      lineIdByComponent: new Map(
        inserted.map((line) => [line.componentId, line.id]),
      ),
    };
  });
}
