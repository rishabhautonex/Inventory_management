import { sql } from "drizzle-orm";

import { runQuery } from "../rows";
import type { Database } from "../types";

/**
 * Read models for the dashboard.
 *
 * Every quantity here is derived: `stock_on_hand` is a view over
 * SUM(qty_delta), and the week-on-week change is a sum over the same ledger
 * rows. Nothing is cached and nothing is stored, so these numbers cannot drift
 * from the movements that produced them.
 */

export type DashboardSummary = {
  parts: number;
  /** Components catalogued in the last seven days. */
  partsAddedThisWeek: number;
  unitsOnHand: number;
  /** Net units in minus out over the last seven days; may be negative. */
  unitsDeltaThisWeek: number;
  /** Component/location pairs at or below their configured minimum. */
  lowStockLines: number;
  movementsToday: number;
  movementsYesterday: number;
  activeLocations: number;
  activeProjects: number;
};

/**
 * "Today" means the lab's today.
 *
 * Timestamps are stored UTC, but a movement at 02:00 IST belongs to the Indian
 * day that has just started, not the UTC one that is still yesterday. Truncating
 * in Asia/Kolkata and converting back gives the timestamptz of local midnight.
 */
const TODAY_START = sql`(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;

export async function getDashboardSummary(
  db: Database,
): Promise<DashboardSummary> {
  const rows = await runQuery<{
    parts: string | number;
    parts_added_week: string | number;
    units_on_hand: string | number;
    units_delta_week: string | number;
    low_stock_lines: string | number;
    movements_today: string | number;
    movements_yesterday: string | number;
    active_locations: string | number;
    active_projects: string | number;
  }>(
    db,
    sql`
      SELECT
        (SELECT count(*) FROM components) AS parts,

        (SELECT count(*) FROM components
          WHERE created_at >= now() - interval '7 days') AS parts_added_week,

        (SELECT COALESCE(SUM(on_hand), 0) FROM stock_on_hand) AS units_on_hand,

        (SELECT COALESCE(SUM(qty_delta), 0) FROM stock_movements
          WHERE created_at >= now() - interval '7 days') AS units_delta_week,

        (SELECT count(*)
           FROM stock_on_hand soh
           JOIN stock_thresholds st
             ON st.component_id = soh.component_id
            AND st.location_id  = soh.location_id
           JOIN location_tree lt ON lt.id = soh.location_id
          WHERE lt.is_active AND soh.on_hand <= st.min_qty) AS low_stock_lines,

        (SELECT count(*) FROM stock_movements
          WHERE created_at >= ${TODAY_START}) AS movements_today,

        (SELECT count(*) FROM stock_movements
          WHERE created_at >= ${TODAY_START} - interval '1 day'
            AND created_at <  ${TODAY_START}) AS movements_yesterday,

        (SELECT count(*) FROM locations WHERE is_active) AS active_locations,

        (SELECT count(*) FROM projects WHERE status = 'active') AS active_projects
    `,
  );

  const row = rows[0];

  return {
    parts: Number(row?.parts ?? 0),
    partsAddedThisWeek: Number(row?.parts_added_week ?? 0),
    unitsOnHand: Number(row?.units_on_hand ?? 0),
    unitsDeltaThisWeek: Number(row?.units_delta_week ?? 0),
    lowStockLines: Number(row?.low_stock_lines ?? 0),
    movementsToday: Number(row?.movements_today ?? 0),
    movementsYesterday: Number(row?.movements_yesterday ?? 0),
    activeLocations: Number(row?.active_locations ?? 0),
    activeProjects: Number(row?.active_projects ?? 0),
  };
}

export type LowStockLine = {
  componentId: string;
  name: string;
  mpn: string | null;
  locationId: string;
  locationPath: string;
  onHand: number;
  minQty: number;
};

/**
 * Parts at or below their per-location minimum, worst first.
 *
 * Ordered by the fraction of the minimum still on the shelf rather than by raw
 * count, so "0 of 2" outranks "18 of 20" — the shelf that is actually empty is
 * the one worth walking to.
 */
export async function listLowStock(
  db: Database,
  limit = 5,
): Promise<LowStockLine[]> {
  const rows = await runQuery<{
    component_id: string;
    name: string;
    mpn: string | null;
    location_id: string;
    location_path: string;
    on_hand: string | number;
    min_qty: string | number;
  }>(
    db,
    sql`
      SELECT
        c.id     AS component_id,
        c.name,
        c.mpn,
        lt.id    AS location_id,
        lt.path  AS location_path,
        soh.on_hand,
        st.min_qty
      FROM stock_on_hand soh
      JOIN stock_thresholds st
        ON st.component_id = soh.component_id
       AND st.location_id  = soh.location_id
      JOIN components c     ON c.id  = soh.component_id
      JOIN location_tree lt ON lt.id = soh.location_id
      WHERE lt.is_active AND soh.on_hand <= st.min_qty
      ORDER BY
        (soh.on_hand::float8 / GREATEST(st.min_qty, 1)) ASC,
        soh.on_hand ASC,
        c.name ASC
      LIMIT ${limit}
    `,
  );

  return rows.map((r) => ({
    componentId: r.component_id,
    name: r.name,
    mpn: r.mpn,
    locationId: r.location_id,
    locationPath: r.location_path,
    onHand: Number(r.on_hand),
    minQty: Number(r.min_qty),
  }));
}
