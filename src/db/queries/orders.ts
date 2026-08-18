import { sql } from "drizzle-orm";

import { runQuery } from "../rows";
import type { Database } from "../types";

export type OrderStatus =
  | "ordered"
  | "shipped"
  | "delivered"
  | "shelved"
  | "cancelled";

export type OrderChannel = "online" | "offline";

/**
 * How much of an order line has actually reached a shelf.
 *
 * Derived from the ledger, like every other quantity in this application:
 * SUM(qty_delta) over the receipts linked to the line, ignoring any that have
 * since been reversed. There is no `shelved_qty` column to fall out of step, and
 * undoing a shelving therefore reopens the line automatically.
 */
const SHELVED_QTY = sql`
  COALESCE((
    SELECT SUM(m.qty_delta)
    FROM stock_movements m
    WHERE m.order_line_id = ol.id
      AND NOT EXISTS (
        SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = m.id
      )
  ), 0)
`;

/** Past its expected date and not yet in the building. */
const IS_OVERDUE = sql`
  (o.expected_date IS NOT NULL
   AND o.expected_date < now()
   AND o.status IN ('ordered', 'shipped'))
`;

export type OrderListRow = {
  id: string;
  vendorName: string | null;
  projectId: string | null;
  projectName: string | null;
  channel: OrderChannel;
  status: OrderStatus;
  orderDate: Date | null;
  expectedDate: Date | null;
  totalAmount: number | null;
  currency: string;
  lineCount: number;
  /** Lines whose full ordered quantity has reached a shelf. */
  shelvedLineCount: number;
  hasInvoice: boolean;
  hasInvoiceText: boolean;
  isOverdue: boolean;
};

/**
 * Orders visible to whoever is asking.
 *
 * `null` means every order, which is what an admin or manager gets. A project
 * head passes the projects they lead; an empty list therefore matches nothing
 * rather than everything, which is the safe direction for a mistake to fall.
 * An order with no project — the general shelf — has no head and so is only
 * ever in the unrestricted set.
 */
export type OrderScope = { projectIds: string[] } | null;

function scopeClause(scope: OrderScope) {
  if (scope === null) return sql`TRUE`;
  return sql`o.project_id = ANY(${sql.param(scope.projectIds)}::uuid[])`;
}

export async function listOrders(
  db: Database,
  filters: {
    status?: OrderStatus;
    projectId?: string;
    scope?: OrderScope;
    limit?: number;
  } = {},
): Promise<OrderListRow[]> {
  const limit = Math.min(filters.limit ?? 100, 200);
  const scope = filters.scope ?? null;

  const rows = await runQuery<{
    id: string;
    vendor_name: string | null;
    project_id: string | null;
    project_name: string | null;
    channel: OrderChannel;
    status: OrderStatus;
    order_date: string | Date | null;
    expected_date: string | Date | null;
    total_amount: string | number | null;
    currency: string;
    line_count: string | number;
    shelved_line_count: string | number;
    has_invoice: boolean;
    has_invoice_text: boolean;
    is_overdue: boolean;
  }>(
    db,
    sql`
      SELECT
        o.id,
        v.name  AS vendor_name,
        p.id    AS project_id,
        p.name  AS project_name,
        o.channel,
        o.status,
        o.order_date,
        o.expected_date,
        o.total_amount,
        o.currency,
        (SELECT count(*) FROM order_lines ol WHERE ol.order_id = o.id)
          AS line_count,
        (
          SELECT count(*)
          FROM order_lines ol
          WHERE ol.order_id = o.id AND ${SHELVED_QTY} >= ol.qty
        ) AS shelved_line_count,
        (o.invoice_file_url IS NOT NULL) AS has_invoice,
        (o.invoice_ocr_text IS NOT NULL AND o.invoice_ocr_text <> '')
          AS has_invoice_text,
        ${IS_OVERDUE} AS is_overdue
      FROM orders o
      LEFT JOIN vendors v  ON v.id = o.vendor_id
      LEFT JOIN projects p ON p.id = o.project_id
      WHERE ${scopeClause(scope)}
        ${filters.status ? sql`AND o.status = ${filters.status}` : sql``}
        ${filters.projectId ? sql`AND o.project_id = ${filters.projectId}` : sql``}
      ORDER BY
        ${IS_OVERDUE} DESC,
        o.created_at DESC
      LIMIT ${limit}
    `,
  );

  return rows.map((r) => ({
    id: r.id,
    vendorName: r.vendor_name,
    projectId: r.project_id,
    projectName: r.project_name,
    channel: r.channel,
    status: r.status,
    orderDate: r.order_date ? new Date(r.order_date) : null,
    expectedDate: r.expected_date ? new Date(r.expected_date) : null,
    totalAmount: r.total_amount === null ? null : Number(r.total_amount),
    currency: r.currency,
    lineCount: Number(r.line_count),
    shelvedLineCount: Number(r.shelved_line_count),
    hasInvoice: Boolean(r.has_invoice),
    hasInvoiceText: Boolean(r.has_invoice_text),
    isOverdue: Boolean(r.is_overdue),
  }));
}

export type OrderLineDetail = {
  id: string;
  componentId: string;
  componentName: string;
  mpn: string | null;
  qty: number;
  unitPrice: number | null;
  shelvedQty: number;
  remainingQty: number;
};

export type OrderDetail = {
  id: string;
  vendorId: string | null;
  vendorName: string | null;
  vendorWebsite: string | null;
  projectId: string | null;
  projectName: string | null;
  channel: OrderChannel;
  status: OrderStatus;
  orderDate: Date | null;
  expectedDate: Date | null;
  deliveredAt: Date | null;
  shelvedAt: Date | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  invoiceFileUrl: string | null;
  invoiceMime: string | null;
  invoiceOcrText: string | null;
  totalAmount: number | null;
  currency: string;
  createdByName: string | null;
  createdAt: Date;
  isOverdue: boolean;
  lines: OrderLineDetail[];
};

export async function getOrder(
  db: Database,
  orderId: string,
): Promise<OrderDetail | null> {
  const headers = await runQuery<{
    id: string;
    vendor_id: string | null;
    vendor_name: string | null;
    vendor_website: string | null;
    project_id: string | null;
    project_name: string | null;
    channel: OrderChannel;
    status: OrderStatus;
    order_date: string | Date | null;
    expected_date: string | Date | null;
    delivered_at: string | Date | null;
    shelved_at: string | Date | null;
    tracking_number: string | null;
    tracking_url: string | null;
    invoice_file_url: string | null;
    invoice_mime: string | null;
    invoice_ocr_text: string | null;
    total_amount: string | number | null;
    currency: string;
    created_by_name: string | null;
    created_at: string | Date;
    is_overdue: boolean;
  }>(
    db,
    sql`
      SELECT
        o.id,
        o.vendor_id,
        v.name    AS vendor_name,
        v.website AS vendor_website,
        p.id      AS project_id,
        p.name    AS project_name,
        o.channel,
        o.status,
        o.order_date,
        o.expected_date,
        o.delivered_at,
        o.shelved_at,
        o.tracking_number,
        o.tracking_url,
        o.invoice_file_url,
        o.invoice_mime,
        o.invoice_ocr_text,
        o.total_amount,
        o.currency,
        u.name AS created_by_name,
        o.created_at,
        ${IS_OVERDUE} AS is_overdue
      FROM orders o
      LEFT JOIN vendors v  ON v.id = o.vendor_id
      LEFT JOIN projects p ON p.id = o.project_id
      LEFT JOIN users u    ON u.id = o.created_by
      WHERE o.id = ${orderId}
    `,
  );

  const header = headers[0];
  if (!header) return null;

  const lineRows = await runQuery<{
    id: string;
    component_id: string;
    component_name: string;
    mpn: string | null;
    qty: string | number;
    unit_price: string | number | null;
    shelved_qty: string | number;
  }>(
    db,
    sql`
      SELECT
        ol.id,
        ol.component_id,
        c.name AS component_name,
        c.mpn,
        ol.qty,
        ol.unit_price,
        ${SHELVED_QTY} AS shelved_qty
      FROM order_lines ol
      JOIN components c ON c.id = ol.component_id
      WHERE ol.order_id = ${orderId}
      ORDER BY c.name
    `,
  );

  const lines: OrderLineDetail[] = lineRows.map((r) => {
    const qty = Number(r.qty);
    const shelvedQty = Number(r.shelved_qty);
    return {
      id: r.id,
      componentId: r.component_id,
      componentName: r.component_name,
      mpn: r.mpn,
      qty,
      unitPrice: r.unit_price === null ? null : Number(r.unit_price),
      shelvedQty,
      remainingQty: Math.max(0, qty - shelvedQty),
    };
  });

  return {
    id: header.id,
    vendorId: header.vendor_id,
    vendorName: header.vendor_name,
    vendorWebsite: header.vendor_website,
    projectId: header.project_id,
    projectName: header.project_name,
    channel: header.channel,
    status: header.status,
    orderDate: header.order_date ? new Date(header.order_date) : null,
    expectedDate: header.expected_date ? new Date(header.expected_date) : null,
    deliveredAt: header.delivered_at ? new Date(header.delivered_at) : null,
    shelvedAt: header.shelved_at ? new Date(header.shelved_at) : null,
    trackingNumber: header.tracking_number,
    trackingUrl: header.tracking_url,
    invoiceFileUrl: header.invoice_file_url,
    invoiceMime: header.invoice_mime,
    invoiceOcrText: header.invoice_ocr_text,
    totalAmount:
      header.total_amount === null ? null : Number(header.total_amount),
    currency: header.currency,
    createdByName: header.created_by_name,
    createdAt: new Date(header.created_at),
    isOverdue: Boolean(header.is_overdue),
    lines,
  };
}

/**
 * Counts for the orders tab strip and the dashboard tile.
 *
 * Takes the same scope as `listOrders`, so a project head's tile counts the
 * orders they can actually open rather than the whole lab's.
 */
export async function getOrderCounts(
  db: Database,
  scope: OrderScope = null,
): Promise<{
  open: number;
  overdue: number;
  awaitingShelving: number;
}> {
  const rows = await runQuery<{
    open: string | number;
    overdue: string | number;
    awaiting: string | number;
  }>(
    db,
    sql`
      SELECT
        count(*) FILTER (
          WHERE o.status IN ('ordered', 'shipped', 'delivered')
        ) AS open,
        count(*) FILTER (WHERE ${IS_OVERDUE}) AS overdue,
        count(*) FILTER (WHERE o.status = 'delivered') AS awaiting
      FROM orders o
      WHERE ${scopeClause(scope)}
    `,
  );

  return {
    open: Number(rows[0]?.open ?? 0),
    overdue: Number(rows[0]?.overdue ?? 0),
    awaitingShelving: Number(rows[0]?.awaiting ?? 0),
  };
}

/** Vendor list for the new-order form's picker. */
export async function listVendors(
  db: Database,
): Promise<Array<{ id: string; name: string }>> {
  return runQuery<{ id: string; name: string }>(
    db,
    sql`SELECT id, name FROM vendors ORDER BY name`,
  );
}

export type InvoiceMatch = {
  orderId: string;
  vendorName: string | null;
  projectName: string | null;
  status: OrderStatus;
  orderDate: Date | null;
  totalAmount: number | null;
  /** Text either side of the first hit, so the reader sees why it matched. */
  snippet: string;
};

/**
 * Full-text search over stored invoice text — what the OCR pass is *for*.
 *
 * The spec's reason for keeping `invoice_ocr_text` at all is that a bill should
 * be findable months later by something written on it: a part number nobody
 * catalogued, a vendor's reference, a courier's docket. So this searches the
 * text as filed and quotes the surrounding characters rather than reporting a
 * bare hit — a match with no context is a match the reader has to open to judge.
 *
 * Scoped exactly like `listOrders`: a project head may search the invoices
 * behind their own projects and nobody else's, and an empty project list matches
 * nothing rather than everything.
 */
export async function searchInvoices(
  db: Database,
  query: string,
  options: { scope?: OrderScope; limit?: number } = {},
): Promise<InvoiceMatch[]> {
  const trimmed = query.trim();
  if (trimmed === "") return [];

  const scope = options.scope ?? null;
  const limit = Math.min(options.limit ?? 25, 100);

  const rows = await runQuery<{
    order_id: string;
    vendor_name: string | null;
    project_name: string | null;
    status: OrderStatus;
    order_date: string | Date | null;
    total_amount: string | number | null;
    snippet: string;
  }>(
    db,
    sql`
      SELECT
        o.id     AS order_id,
        v.name   AS vendor_name,
        p.name   AS project_name,
        o.status,
        COALESCE(o.order_date, o.created_at) AS order_date,
        o.total_amount,
        substring(
          o.invoice_ocr_text
          FROM GREATEST(1, position(lower(${trimmed}) IN lower(o.invoice_ocr_text)) - 60)
          FOR 200
        ) AS snippet
      FROM orders o
      LEFT JOIN vendors v  ON v.id = o.vendor_id
      LEFT JOIN projects p ON p.id = o.project_id
      WHERE o.invoice_ocr_text IS NOT NULL
        AND o.invoice_ocr_text ILIKE '%' || ${trimmed} || '%'
        AND ${scopeClause(scope)}
      ORDER BY COALESCE(o.order_date, o.created_at) DESC
      LIMIT ${limit}
    `,
  );

  return rows.map((r) => ({
    orderId: r.order_id,
    vendorName: r.vendor_name,
    projectName: r.project_name,
    status: r.status,
    orderDate: r.order_date ? new Date(r.order_date) : null,
    totalAmount: r.total_amount === null ? null : Number(r.total_amount),
    snippet: (r.snippet ?? "").replace(/\s+/g, " ").trim(),
  }));
}

export type OverdueOrderRow = {
  id: string;
  vendorName: string | null;
  projectId: string | null;
  projectName: string | null;
  status: OrderStatus;
  expectedDate: Date;
  /** Whole days between the expected date and today, in lab time. */
  daysLate: number;
  lineCount: number;
};

/**
 * Every order past its expected date and not yet in the building.
 *
 * Drives the daily job behind the spec's overdue-delivery notification, so it
 * is unscoped on purpose — the job decides per order who hears about it, from
 * the order's own project. `IS_OVERDUE` is the same predicate the list and the
 * counts use, so a badge on screen and an alert in somebody's bell can never
 * disagree about what "overdue" means.
 *
 * Lateness is measured in whole days in Asia/Kolkata rather than by subtracting
 * timestamps: an order expected yesterday evening is one day late this morning,
 * which is what the reader means by it.
 */
export async function listOverdueOrders(
  db: Database,
): Promise<OverdueOrderRow[]> {
  const rows = await runQuery<{
    id: string;
    vendor_name: string | null;
    project_id: string | null;
    project_name: string | null;
    status: OrderStatus;
    expected_date: string | Date;
    days_late: string | number;
    line_count: string | number;
  }>(
    db,
    sql`
      SELECT
        o.id,
        v.name AS vendor_name,
        o.project_id,
        p.name AS project_name,
        o.status,
        o.expected_date,
        (
          (now() AT TIME ZONE 'Asia/Kolkata')::date
          - (o.expected_date AT TIME ZONE 'Asia/Kolkata')::date
        ) AS days_late,
        (SELECT count(*) FROM order_lines ol WHERE ol.order_id = o.id) AS line_count
      FROM orders o
      LEFT JOIN vendors v ON v.id = o.vendor_id
      LEFT JOIN projects p ON p.id = o.project_id
      WHERE ${IS_OVERDUE}
      ORDER BY o.expected_date
    `,
  );

  return rows.map((r) => ({
    id: r.id,
    vendorName: r.vendor_name,
    projectId: r.project_id,
    projectName: r.project_name,
    status: r.status,
    expectedDate: new Date(r.expected_date),
    daysLate: Number(r.days_late),
    lineCount: Number(r.line_count),
  }));
}
