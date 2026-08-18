import { sql } from "drizzle-orm";

import { runQuery } from "@/db/rows";
import type { Database } from "@/db/types";

/**
 * Threshold coverage: which shelves have a minimum, and which do not.
 *
 * The low-stock alert can only fire for a component/location pair that has a
 * `min_qty`, and `getStockHealth()` counts only those pairs for the same reason —
 * without a minimum there is no standard to be below. The consequence is easy to
 * miss in daily use: a shelf nobody set a minimum on is not healthy, it is
 * *unwatched*, and it will empty in silence.
 *
 * So this returns both halves. A pair that holds stock but carries no minimum is
 * a gap in the alerting, not a row to leave out of the table.
 */

export type CoverageLine = {
  componentId: string;
  componentName: string;
  componentMpn: string | null;
  locationId: string;
  locationPath: string;
  projectName: string | null;
  onHand: number;
  /** Null means no minimum is set, so no alert can fire for this shelf. */
  minQty: number | null;
};

export type ThresholdCoverage = {
  /** Pairs with a minimum, the ones furthest below it first. */
  watched: CoverageLine[];
  /** Pairs holding stock with no minimum set at all. */
  unwatched: CoverageLine[];
  counts: {
    watched: number;
    unwatched: number;
    /** Watched pairs at or below their minimum right now. */
    breaching: number;
  };
};

const LINE_COLUMNS = sql`
  c.id     AS component_id,
  c.name   AS component_name,
  c.mpn    AS component_mpn,
  lt.id    AS location_id,
  lt.path  AS location_path,
  p.name   AS project_name,
  COALESCE(soh.on_hand, 0) AS on_hand
`;

type RawLine = {
  component_id: string;
  component_name: string;
  component_mpn: string | null;
  location_id: string;
  location_path: string;
  project_name: string | null;
  on_hand: string | number;
  min_qty: string | number | null;
};

function toLine(r: RawLine): CoverageLine {
  return {
    componentId: r.component_id,
    componentName: r.component_name,
    componentMpn: r.component_mpn,
    locationId: r.location_id,
    locationPath: r.location_path,
    projectName: r.project_name,
    onHand: Number(r.on_hand),
    minQty: r.min_qty === null ? null : Number(r.min_qty),
  };
}

export async function getThresholdCoverage(
  db: Database,
  limit = 100,
): Promise<ThresholdCoverage> {
  const [watched, unwatched, counts] = await Promise.all([
    /**
     * Every pair with a minimum, driven from the thresholds side with a LEFT
     * JOIN so a minimum whose shelf has never seen a movement still appears. It
     * is empty, not missing — the same reading `getProjectAttention()` takes.
     */
    runQuery<RawLine>(
      db,
      sql`
        SELECT ${LINE_COLUMNS}, st.min_qty
        FROM stock_thresholds st
        JOIN components c     ON c.id  = st.component_id
        JOIN location_tree lt ON lt.id = st.location_id
        LEFT JOIN projects p  ON p.id  = lt.effective_project_id
        LEFT JOIN stock_on_hand soh
          ON soh.component_id = st.component_id
         AND soh.location_id  = st.location_id
        WHERE lt.is_active
        ORDER BY
          (COALESCE(soh.on_hand, 0)::float8 / GREATEST(st.min_qty, 1)) ASC,
          c.name ASC
        LIMIT ${limit}
      `,
    ),

    // Shelves holding something with nothing to measure it against.
    runQuery<RawLine>(
      db,
      sql`
        SELECT ${LINE_COLUMNS}, NULL::int AS min_qty
        FROM stock_on_hand soh
        JOIN components c     ON c.id  = soh.component_id
        JOIN location_tree lt ON lt.id = soh.location_id
        LEFT JOIN projects p  ON p.id  = lt.effective_project_id
        WHERE lt.is_active
          AND soh.on_hand > 0
          AND NOT EXISTS (
            SELECT 1 FROM stock_thresholds st
            WHERE st.component_id = soh.component_id
              AND st.location_id  = soh.location_id
          )
        ORDER BY soh.on_hand DESC, c.name ASC
        LIMIT ${limit}
      `,
    ),

    runQuery<{
      watched: string | number;
      unwatched: string | number;
      breaching: string | number;
    }>(
      db,
      sql`
        SELECT
          (SELECT count(*) FROM stock_thresholds st
            JOIN location_tree lt ON lt.id = st.location_id
            WHERE lt.is_active) AS watched,

          (SELECT count(*) FROM stock_on_hand soh
            JOIN location_tree lt ON lt.id = soh.location_id
            WHERE lt.is_active AND soh.on_hand > 0
              AND NOT EXISTS (
                SELECT 1 FROM stock_thresholds st
                WHERE st.component_id = soh.component_id
                  AND st.location_id  = soh.location_id
              )) AS unwatched,

          (SELECT count(*) FROM stock_thresholds st
            JOIN location_tree lt ON lt.id = st.location_id
            LEFT JOIN stock_on_hand soh
              ON soh.component_id = st.component_id
             AND soh.location_id  = st.location_id
            WHERE lt.is_active
              AND COALESCE(soh.on_hand, 0) <= st.min_qty) AS breaching
      `,
    ),
  ]);

  const row = counts[0];

  return {
    watched: watched.map(toLine),
    unwatched: unwatched.map(toLine),
    counts: {
      watched: Number(row?.watched ?? 0),
      unwatched: Number(row?.unwatched ?? 0),
      breaching: Number(row?.breaching ?? 0),
    },
  };
}
