import { sql } from "drizzle-orm";

import { runQuery } from "../rows";
import type { Database } from "../types";

/**
 * Read models for the project screens.
 *
 * Everything about a project's stock resolves through `location_tree`, never
 * through `locations.project_id` directly: only the cupboard normally carries a
 * project, and its shelves and bins inherit it. Asking the table would count
 * the cupboard and miss every bin inside it.
 */

/** Non-cancelled spend on a project: the invoice total, or the lines if none. */
const PROJECT_SPEND = sql`
  COALESCE((
    SELECT SUM(COALESCE(
      o.total_amount,
      (
        SELECT SUM(ol.qty * COALESCE(ol.unit_price, 0))
        FROM order_lines ol
        WHERE ol.order_id = o.id
      ),
      0
    ))
    FROM orders o
    WHERE o.project_id = p.id AND o.status <> 'cancelled'
  ), 0)
`;

export type ProjectRow = {
  id: string;
  name: string;
  code: string;
  status: "active" | "closed";
  /** What the project is, as its head wrote it. Null when nobody has said. */
  description: string | null;
  repoUrl: string | null;
  /** Where the project is written up — a README, a wiki, a design doc. */
  readmeUrl: string | null;
  leads: Array<{ id: string; name: string }>;
  /** Locations that resolve to this project, at any depth. */
  locationCount: number;
  distinctParts: number;
  pieces: number;
  spend: number;
  pendingRequests: number;
  approvedRequests: number;
  bomCount: number;
};

type RawProjectRow = {
  id: string;
  name: string;
  code: string;
  status: "active" | "closed";
  description: string | null;
  repo_url: string | null;
  readme_url: string | null;
  leads: Array<{ id: string; name: string }> | null;
  location_count: string | number;
  distinct_parts: string | number;
  pieces: string | number;
  spend: string | number;
  pending_requests: string | number;
  approved_requests: string | number;
  bom_count: string | number;
};

const SELECT_PROJECT = sql`
  SELECT
    p.id,
    p.name,
    p.code,
    p.status,
    p.description,
    p.repo_url,
    p.readme_url,
    COALESCE((
      SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name)
      FROM project_leads pl
      JOIN users u ON u.id = pl.user_id
      WHERE pl.project_id = p.id
    ), '[]'::json) AS leads,
    (
      SELECT count(*) FROM location_tree lt
      WHERE lt.effective_project_id = p.id AND lt.is_active
    ) AS location_count,
    (
      SELECT count(DISTINCT soh.component_id)
      FROM stock_on_hand soh
      JOIN location_tree lt ON lt.id = soh.location_id
      WHERE lt.effective_project_id = p.id AND lt.is_active AND soh.on_hand > 0
    ) AS distinct_parts,
    COALESCE((
      SELECT SUM(soh.on_hand)
      FROM stock_on_hand soh
      JOIN location_tree lt ON lt.id = soh.location_id
      WHERE lt.effective_project_id = p.id AND lt.is_active AND soh.on_hand > 0
    ), 0) AS pieces,
    ${PROJECT_SPEND} AS spend,
    (
      SELECT count(*) FROM part_requests r
      WHERE r.project_id = p.id AND r.status = 'pending'
    ) AS pending_requests,
    (
      SELECT count(*) FROM part_requests r
      WHERE r.project_id = p.id AND r.status = 'approved'
    ) AS approved_requests,
    (SELECT count(*) FROM boms b WHERE b.project_id = p.id) AS bom_count
  FROM projects p
`;

function toRow(r: RawProjectRow): ProjectRow {
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    status: r.status,
    description: r.description,
    repoUrl: r.repo_url,
    readmeUrl: r.readme_url,
    leads: r.leads ?? [],
    locationCount: Number(r.location_count),
    distinctParts: Number(r.distinct_parts),
    pieces: Number(r.pieces),
    spend: Number(r.spend),
    pendingRequests: Number(r.pending_requests),
    approvedRequests: Number(r.approved_requests),
    bomCount: Number(r.bom_count),
  };
}

/**
 * Projects this person may open.
 *
 * `null` means every project, which is what an admin or manager gets. A head
 * passes the list they lead; an empty list returns nothing rather than
 * everything, which is the safe direction for a mistake to fall.
 */
export async function listProjects(
  db: Database,
  projectIds: string[] | null,
): Promise<ProjectRow[]> {
  const rows = await runQuery<RawProjectRow>(
    db,
    sql`
      ${SELECT_PROJECT}
      WHERE ${
        projectIds === null
          ? sql`TRUE`
          : sql`p.id = ANY(${sql.param(projectIds)}::uuid[])`
      }
      ORDER BY p.status, p.name
    `,
  );

  return rows.map(toRow);
}

export async function getProject(
  db: Database,
  projectId: string,
): Promise<ProjectRow | null> {
  const rows = await runQuery<RawProjectRow>(
    db,
    sql`${SELECT_PROJECT} WHERE p.id = ${projectId} LIMIT 1`,
  );
  const row = rows[0];
  return row ? toRow(row) : null;
}

export type ProjectStockLine = {
  componentId: string;
  componentName: string;
  componentMpn: string | null;
  locationId: string;
  locationPath: string;
  onHand: number;
  minQty: number | null;
};

/** What is actually in this project's cupboards, one row per part per shelf. */
export async function getProjectStock(
  db: Database,
  projectId: string,
  limit = 200,
): Promise<ProjectStockLine[]> {
  const rows = await runQuery<{
    component_id: string;
    component_name: string;
    component_mpn: string | null;
    location_id: string;
    location_path: string;
    on_hand: string | number;
    min_qty: number | null;
  }>(
    db,
    sql`
      SELECT
        c.id      AS component_id,
        c.name    AS component_name,
        c.mpn     AS component_mpn,
        lt.id     AS location_id,
        lt.path   AS location_path,
        soh.on_hand,
        st.min_qty
      FROM stock_on_hand soh
      JOIN location_tree lt  ON lt.id = soh.location_id
      JOIN components c      ON c.id = soh.component_id
      LEFT JOIN stock_thresholds st
             ON st.component_id = c.id AND st.location_id = lt.id
      WHERE lt.effective_project_id = ${projectId}
        AND lt.is_active
        AND soh.on_hand > 0
      ORDER BY c.name ASC, lt.path ASC
      LIMIT ${limit}
    `,
  );

  return rows.map((r) => ({
    componentId: r.component_id,
    componentName: r.component_name,
    componentMpn: r.component_mpn,
    locationId: r.location_id,
    locationPath: r.location_path,
    onHand: Number(r.on_hand),
    minQty: r.min_qty === null ? null : Number(r.min_qty),
  }));
}

export type ProjectAttentionLine = {
  componentId: string;
  componentName: string;
  componentMpn: string | null;
  locationId: string;
  locationPath: string;
  onHand: number;
  minQty: number;
};

/**
 * The shelves in this project's cupboards that are at or below their minimum.
 *
 * Deliberately not a filter over `getProjectStock()`, which drops `on_hand = 0`
 * so that "in the cupboard" lists what is actually there. An empty shelf is the
 * one row a project head most needs and the one that filter removes — they are
 * notified when a part hits zero and then found nothing on the page the alert
 * points at. So this reads from the thresholds side and keeps the zeros.
 *
 * Ordered by the fraction of the minimum still on the shelf, like the
 * dashboard's `listLowStock()`: "0 of 2" outranks "18 of 20".
 */
export async function getProjectAttention(
  db: Database,
  projectId: string,
  limit = 50,
): Promise<ProjectAttentionLine[]> {
  const rows = await runQuery<{
    component_id: string;
    component_name: string;
    component_mpn: string | null;
    location_id: string;
    location_path: string;
    on_hand: string | number;
    min_qty: string | number;
  }>(
    db,
    sql`
      SELECT
        c.id     AS component_id,
        c.name   AS component_name,
        c.mpn    AS component_mpn,
        lt.id    AS location_id,
        lt.path  AS location_path,
        COALESCE(soh.on_hand, 0) AS on_hand,
        st.min_qty
      FROM stock_thresholds st
      JOIN location_tree lt  ON lt.id = st.location_id
      JOIN components c      ON c.id = st.component_id
      LEFT JOIN stock_on_hand soh
             ON soh.component_id = st.component_id
            AND soh.location_id  = st.location_id
      WHERE lt.effective_project_id = ${projectId}
        AND lt.is_active
        AND COALESCE(soh.on_hand, 0) <= st.min_qty
      ORDER BY
        (COALESCE(soh.on_hand, 0)::float8 / GREATEST(st.min_qty, 1)) ASC,
        COALESCE(soh.on_hand, 0) ASC,
        c.name ASC
      LIMIT ${limit}
    `,
  );

  return rows.map((r) => ({
    componentId: r.component_id,
    componentName: r.component_name,
    componentMpn: r.component_mpn,
    locationId: r.location_id,
    locationPath: r.location_path,
    onHand: Number(r.on_hand),
    minQty: Number(r.min_qty),
  }));
}

export type ProjectSignals = {
  projectId: string;
  /** Watched shelves at or below their minimum but not yet empty. */
  low: number;
  /** Watched shelves with nothing on them. */
  empty: number;
  /** Ordered, shipped or delivered — anything not yet fully put away. */
  openOrders: number;
  overdueOrders: number;
  /** Lines still short against the project's newest BOM, or null if it has none. */
  shortLines: number | null;
};

/**
 * The per-project figures behind a project head's own overview.
 *
 * One query for every project they lead rather than one per project, because a
 * head running four projects would otherwise cost four round trips on the
 * dashboard's critical path.
 *
 * `shortLines` is null rather than 0 for a project with no BOM: nothing has been
 * asked for, which is not the same as everything having arrived, and a "0 short"
 * badge on a project nobody has uploaded a parts list for would read as the
 * second.
 */
export async function listProjectSignals(
  db: Database,
  projectIds: string[],
): Promise<ProjectSignals[]> {
  if (projectIds.length === 0) return [];

  const rows = await runQuery<{
    project_id: string;
    low: string | number;
    empty: string | number;
    open_orders: string | number;
    overdue_orders: string | number;
    short_lines: string | number | null;
    has_bom: boolean;
  }>(
    db,
    sql`
      WITH scoped AS (
        SELECT id FROM projects WHERE id = ANY(${sql.param(projectIds)}::uuid[])
      ),
      -- Newest upload only. Older BOMs stay readable but only one can be the
      -- current answer to "what is this project short of".
      latest_bom AS (
        SELECT DISTINCT ON (b.project_id) b.project_id, b.id
        FROM boms b
        JOIN scoped s ON s.id = b.project_id
        ORDER BY b.project_id, b.created_at DESC
      )
      SELECT
        s.id AS project_id,

        (
          SELECT count(*)
          FROM stock_thresholds st
          JOIN location_tree lt ON lt.id = st.location_id
          LEFT JOIN stock_on_hand soh
                 ON soh.component_id = st.component_id
                AND soh.location_id  = st.location_id
          WHERE lt.effective_project_id = s.id
            AND lt.is_active
            AND COALESCE(soh.on_hand, 0) <= st.min_qty
            AND COALESCE(soh.on_hand, 0) > 0
        ) AS low,

        (
          SELECT count(*)
          FROM stock_thresholds st
          JOIN location_tree lt ON lt.id = st.location_id
          LEFT JOIN stock_on_hand soh
                 ON soh.component_id = st.component_id
                AND soh.location_id  = st.location_id
          WHERE lt.effective_project_id = s.id
            AND lt.is_active
            AND COALESCE(soh.on_hand, 0) <= 0
        ) AS empty,

        (
          SELECT count(*)
          FROM orders o
          WHERE o.project_id = s.id
            AND o.status IN ('ordered', 'shipped', 'delivered')
        ) AS open_orders,

        (
          SELECT count(*)
          FROM orders o
          WHERE o.project_id = s.id
            AND o.expected_date IS NOT NULL
            AND o.expected_date < now()
            AND o.status IN ('ordered', 'shipped')
        ) AS overdue_orders,

        (
          SELECT count(*)
          FROM bom_lines bl
          JOIN latest_bom lb ON lb.id = bl.bom_id
          WHERE lb.project_id = s.id
            AND bl.qty_needed > COALESCE((
              SELECT SUM(soh.on_hand)
              FROM stock_on_hand soh
              JOIN location_tree lt ON lt.id = soh.location_id
              WHERE soh.component_id = bl.component_id
                AND lt.effective_project_id = s.id
                AND lt.is_active
            ), 0)
        ) AS short_lines,

        EXISTS (SELECT 1 FROM latest_bom lb WHERE lb.project_id = s.id) AS has_bom
      FROM scoped s
    `,
  );

  return rows.map((r) => ({
    projectId: r.project_id,
    low: Number(r.low),
    empty: Number(r.empty),
    openOrders: Number(r.open_orders),
    overdueOrders: Number(r.overdue_orders),
    shortLines: r.has_bom ? Number(r.short_lines ?? 0) : null,
  }));
}
