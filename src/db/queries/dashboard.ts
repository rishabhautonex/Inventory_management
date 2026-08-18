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

export type MovementDay = {
  /** Lab-local calendar day, ISO. */
  day: string;
  /** Short label for a chart axis — "18 Aug". */
  label: string;
  movements: number;
  unitsIn: number;
  unitsOut: number;
};

/**
 * Daily throughput for the last `days` days, in and out kept apart.
 *
 * The day list is generated rather than read from the ledger, so a day with no
 * movements is a zero in the series and not a gap the chart would draw straight
 * through. Bucketing happens in Asia/Kolkata for the same reason
 * `movements_today` does: a movement at 02:00 IST belongs to the Indian day.
 */
export async function getMovementSeries(
  db: Database,
  days = 14,
): Promise<MovementDay[]> {
  const rows = await runQuery<{
    day: string;
    label: string;
    movements: string | number;
    units_in: string | number;
    units_out: string | number;
  }>(
    db,
    sql`
      WITH bounds AS (
        SELECT
          date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')::date AS today,
          ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
            - make_interval(days => ${days - 1}::int)) AT TIME ZONE 'Asia/Kolkata') AS since
      ),
      calendar AS (
        SELECT generate_series(
                 b.today - make_interval(days => ${days - 1}::int),
                 b.today,
                 interval '1 day'
               )::date AS day
        FROM bounds b
      ),
      recent AS (
        SELECT
          (m.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
          m.qty_delta
        FROM stock_movements m, bounds b
        WHERE m.created_at >= b.since
      )
      SELECT
        to_char(c.day, 'YYYY-MM-DD')                  AS day,
        to_char(c.day, 'DD Mon')                      AS label,
        count(r.qty_delta)                            AS movements,
        COALESCE(SUM(GREATEST(r.qty_delta, 0)), 0)    AS units_in,
        COALESCE(SUM(GREATEST(-r.qty_delta, 0)), 0)   AS units_out
      FROM calendar c
      LEFT JOIN recent r ON r.day = c.day
      GROUP BY c.day
      ORDER BY c.day
    `,
  );

  return rows.map((r) => ({
    day: r.day,
    label: r.label,
    movements: Number(r.movements),
    unitsIn: Number(r.units_in),
    unitsOut: Number(r.units_out),
  }));
}

/** Rows are Monday-first weekdays; columns are two-hour buckets of the day. */
export const HEATMAP_BUCKETS = 12;

/**
 * When the lab actually moves stock: weekday against hour of day.
 *
 * Returned as a dense 7 × 12 matrix so the caller renders a grid without
 * having to fill the holes itself.
 */
export async function getActivityHeatmap(
  db: Database,
  days = 28,
): Promise<number[][]> {
  const rows = await runQuery<{
    dow: string | number;
    bucket: string | number;
    n: string | number;
  }>(
    db,
    sql`
      SELECT
        EXTRACT(ISODOW FROM (created_at AT TIME ZONE 'Asia/Kolkata'))::int AS dow,
        (EXTRACT(HOUR FROM (created_at AT TIME ZONE 'Asia/Kolkata'))::int / 2) AS bucket,
        count(*) AS n
      FROM stock_movements
      WHERE created_at >= now() - make_interval(days => ${days}::int)
      GROUP BY 1, 2
    `,
  );

  const grid: number[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: HEATMAP_BUCKETS }, () => 0),
  );

  for (const row of rows) {
    const dow = Number(row.dow) - 1; // ISODOW is 1 = Monday.
    const bucket = Math.min(HEATMAP_BUCKETS - 1, Number(row.bucket));
    if (dow >= 0 && dow < 7) grid[dow]![bucket] = Number(row.n);
  }

  return grid;
}

export type TopMover = {
  componentId: string;
  name: string;
  unitsOut: number;
  movements: number;
};

/**
 * What the lab is actually consuming: units taken out over the window.
 *
 * Reversals are excluded on both sides — the reversal row itself, and the
 * movement it undid — so a mistake that was corrected does not leave a part
 * looking busy. Returns are left in the "in" direction and simply not counted
 * here, because this answers "what is leaving the shelves".
 */
export async function listTopMovers(
  db: Database,
  days = 30,
  limit = 5,
): Promise<TopMover[]> {
  const rows = await runQuery<{
    component_id: string;
    name: string;
    units_out: string | number;
    movements: string | number;
  }>(
    db,
    sql`
      SELECT
        c.id                AS component_id,
        c.name,
        SUM(-m.qty_delta)   AS units_out,
        count(*)            AS movements
      FROM stock_movements m
      JOIN components c ON c.id = m.component_id
      WHERE m.created_at >= now() - make_interval(days => ${days}::int)
        AND m.qty_delta < 0
        AND m.reason <> 'reversal'
        AND NOT EXISTS (
          SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = m.id
        )
      GROUP BY c.id, c.name
      ORDER BY units_out DESC, c.name ASC
      LIMIT ${limit}
    `,
  );

  return rows.map((r) => ({
    componentId: r.component_id,
    name: r.name,
    unitsOut: Number(r.units_out),
    movements: Number(r.movements),
  }));
}

export type StockHealth = {
  /** Component/location pairs with a minimum set — the only ones judgeable. */
  tracked: number;
  healthy: number;
  low: number;
  out: number;
};

/**
 * The split behind the coverage gauge.
 *
 * Only pairs with a threshold are counted: without a minimum there is no
 * standard to be above, and counting them as healthy would flatter the number.
 * A threshold whose shelf has never seen a movement reads as out of stock,
 * which is what it is.
 */
export async function getStockHealth(db: Database): Promise<StockHealth> {
  const rows = await runQuery<{
    tracked: string | number;
    healthy: string | number;
    low: string | number;
    out: string | number;
  }>(
    db,
    sql`
      SELECT
        count(*) AS tracked,
        count(*) FILTER (WHERE COALESCE(soh.on_hand, 0) > st.min_qty)  AS healthy,
        count(*) FILTER (WHERE COALESCE(soh.on_hand, 0) > 0
                           AND COALESCE(soh.on_hand, 0) <= st.min_qty) AS low,
        count(*) FILTER (WHERE COALESCE(soh.on_hand, 0) <= 0)          AS out
      FROM stock_thresholds st
      JOIN location_tree lt ON lt.id = st.location_id
      LEFT JOIN stock_on_hand soh
        ON soh.component_id = st.component_id
       AND soh.location_id  = st.location_id
      WHERE lt.is_active
    `,
  );

  const row = rows[0];

  return {
    tracked: Number(row?.tracked ?? 0),
    healthy: Number(row?.healthy ?? 0),
    low: Number(row?.low ?? 0),
    out: Number(row?.out ?? 0),
  };
}
