import { sql } from "drizzle-orm";

import { runQuery } from "@/db/rows";
import type { Database } from "@/db/types";

/**
 * The week, as one row, for the manager digest.
 *
 * The spec keeps managers off every per-event notification and owes them a
 * periodic summary instead. That summary is a read model like any other on the
 * dashboard: every figure here is counted from rows that exist, and a figure
 * with nothing behind it comes back as a zero the sender can choose to omit
 * rather than a guess.
 *
 * Windowed on the last seven lab-local days, so the digest a manager reads on
 * Monday morning covers the week that just ended in Asia/Kolkata rather than
 * one that ends mid-afternoon in UTC.
 */

/** Midnight seven lab days ago, as a timestamptz. */
const WEEK_START = sql`
  ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - interval '6 days')
   AT TIME ZONE 'Asia/Kolkata')
`;

/**
 * A movement that still stands.
 *
 * A correction is two rows — the mistake and its reversal — and counting either
 * of them as activity would report work that did not happen. Same rule as
 * `listTopMovers()`.
 */
const STANDS = sql`
  (m.reason <> 'reversal'
   AND NOT EXISTS (
     SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = m.id
   ))
`;

export type DigestPart = { name: string; unitsOut: number };

export type WeeklyDigest = {
  /** ISO year and week in lab time, e.g. `2026-W34`. One digest per key. */
  weekKey: string;
  movements: number;
  unitsOut: number;
  unitsIn: number;
  /** Distinct people who moved anything this week. */
  activePeople: number;
  lowStockLines: number;
  outOfStockLines: number;
  overdueOrders: number;
  ordersPlaced: number;
  /** Spend on orders placed this week, INR, cancelled ones excluded. */
  spend: number;
  pendingRequests: number;
  /** Approved and waiting for an admin to turn into an order. */
  requestsToOrder: number;
  /** Most-consumed parts of the week, biggest first. */
  topParts: DigestPart[];
};

export async function getWeeklyDigest(db: Database): Promise<WeeklyDigest> {
  const [row] = await runQuery<{
    week_key: string;
    movements: string | number;
    units_out: string | number;
    units_in: string | number;
    active_people: string | number;
    low_stock_lines: string | number;
    out_of_stock_lines: string | number;
    overdue_orders: string | number;
    orders_placed: string | number;
    spend: string | number;
    pending_requests: string | number;
    requests_to_order: string | number;
  }>(
    db,
    sql`
      SELECT
        to_char(now() AT TIME ZONE 'Asia/Kolkata', 'IYYY-"W"IW') AS week_key,

        (SELECT count(*) FROM stock_movements m
          WHERE m.created_at >= ${WEEK_START} AND ${STANDS}) AS movements,

        (SELECT COALESCE(-SUM(m.qty_delta), 0) FROM stock_movements m
          WHERE m.created_at >= ${WEEK_START} AND ${STANDS}
            AND m.qty_delta < 0) AS units_out,

        (SELECT COALESCE(SUM(m.qty_delta), 0) FROM stock_movements m
          WHERE m.created_at >= ${WEEK_START} AND ${STANDS}
            AND m.qty_delta > 0) AS units_in,

        (SELECT count(DISTINCT m.user_id) FROM stock_movements m
          WHERE m.created_at >= ${WEEK_START} AND ${STANDS}
            AND m.user_id IS NOT NULL) AS active_people,

        -- Thresholds are the only judgeable pairs, and a threshold whose shelf
        -- has never seen a movement is empty rather than missing: the same rule
        -- getStockHealth() applies, so the digest and the gauge agree.
        (SELECT count(*) FROM stock_thresholds st
          JOIN location_tree lt ON lt.id = st.location_id
          LEFT JOIN stock_on_hand soh
            ON soh.component_id = st.component_id
           AND soh.location_id  = st.location_id
          WHERE lt.is_active
            AND COALESCE(soh.on_hand, 0) > 0
            AND COALESCE(soh.on_hand, 0) <= st.min_qty) AS low_stock_lines,

        (SELECT count(*) FROM stock_thresholds st
          JOIN location_tree lt ON lt.id = st.location_id
          LEFT JOIN stock_on_hand soh
            ON soh.component_id = st.component_id
           AND soh.location_id  = st.location_id
          WHERE lt.is_active
            AND COALESCE(soh.on_hand, 0) <= 0) AS out_of_stock_lines,

        (SELECT count(*) FROM orders o
          WHERE o.expected_date IS NOT NULL
            AND o.expected_date < now()
            AND o.status IN ('ordered', 'shipped')) AS overdue_orders,

        (SELECT count(*) FROM orders o
          WHERE o.status <> 'cancelled'
            AND COALESCE(o.order_date, o.created_at) >= ${WEEK_START}) AS orders_placed,

        (SELECT COALESCE(SUM(o.total_amount), 0) FROM orders o
          WHERE o.status <> 'cancelled'
            AND COALESCE(o.order_date, o.created_at) >= ${WEEK_START}) AS spend,

        (SELECT count(*) FROM part_requests pr
          WHERE pr.status = 'pending') AS pending_requests,

        (SELECT count(*) FROM part_requests pr
          WHERE pr.status = 'approved' AND pr.order_id IS NULL) AS requests_to_order
    `,
  );

  const topParts = await runQuery<{ name: string; units_out: string | number }>(
    db,
    sql`
      SELECT c.name, -SUM(m.qty_delta) AS units_out
      FROM stock_movements m
      JOIN components c ON c.id = m.component_id
      WHERE m.created_at >= ${WEEK_START}
        AND m.qty_delta < 0
        AND ${STANDS}
      GROUP BY c.id, c.name
      ORDER BY units_out DESC, c.name ASC
      LIMIT 3
    `,
  );

  return {
    weekKey: String(row?.week_key ?? ""),
    movements: Number(row?.movements ?? 0),
    unitsOut: Number(row?.units_out ?? 0),
    unitsIn: Number(row?.units_in ?? 0),
    activePeople: Number(row?.active_people ?? 0),
    lowStockLines: Number(row?.low_stock_lines ?? 0),
    outOfStockLines: Number(row?.out_of_stock_lines ?? 0),
    overdueOrders: Number(row?.overdue_orders ?? 0),
    ordersPlaced: Number(row?.orders_placed ?? 0),
    spend: Number(row?.spend ?? 0),
    pendingRequests: Number(row?.pending_requests ?? 0),
    requestsToOrder: Number(row?.requests_to_order ?? 0),
    topParts: topParts.map((r) => ({
      name: r.name,
      unitsOut: Number(r.units_out),
    })),
  };
}
