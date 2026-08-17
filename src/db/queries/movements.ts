import { sql, type SQL } from "drizzle-orm";

import { runQuery } from "../rows";
import type { Database } from "../types";

export type MovementReason =
  | "receipt"
  | "issue"
  | "return"
  | "adjustment"
  | "reversal";

export type LogEntry = {
  id: string;
  createdAt: Date;
  componentId: string;
  componentName: string;
  locationId: string;
  locationPath: string;
  projectId: string | null;
  projectName: string | null;
  qtyDelta: number;
  reason: MovementReason;
  userId: string | null;
  userName: string | null;
  note: string | null;
  /** Set when this row is itself an undo of an earlier movement. */
  reversesMovementId: string | null;
  /** True when some later reversal points at this row; it cannot be undone again. */
  isReversed: boolean;
};

export type LogFilters = {
  componentId?: string;
  userId?: string;
  locationId?: string;
  projectId?: string;
  reason?: MovementReason;
  /** Inclusive, interpreted in Asia/Kolkata by the caller before arriving here. */
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
};

/**
 * Screen 3 — the log. Reverse-chronological, filterable, one row per movement.
 *
 * `is_reversed` comes from a self-join rather than a stored flag, for the same
 * reason quantity is not stored: the ledger is the only source of truth, and a
 * cached flag is a thing that can disagree with it.
 */
export async function listMovements(
  db: Database,
  filters: LogFilters = {},
): Promise<LogEntry[]> {
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;

  const conditions: SQL[] = [];
  if (filters.componentId)
    conditions.push(sql`m.component_id = ${filters.componentId}`);
  if (filters.userId) conditions.push(sql`m.user_id = ${filters.userId}`);
  if (filters.locationId)
    conditions.push(sql`m.location_id = ${filters.locationId}`);
  if (filters.projectId)
    conditions.push(sql`lt.effective_project_id = ${filters.projectId}`);
  if (filters.reason) conditions.push(sql`m.reason = ${filters.reason}`);
  if (filters.from) conditions.push(sql`m.created_at >= ${filters.from}`);
  if (filters.to) conditions.push(sql`m.created_at <= ${filters.to}`);

  const where =
    conditions.length > 0
      ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
      : sql``;

  const rows = await runQuery<{
    id: string;
    created_at: string | Date;
    component_id: string;
    component_name: string;
    location_id: string;
    location_path: string;
    project_id: string | null;
    project_name: string | null;
    qty_delta: number;
    reason: MovementReason;
    user_id: string | null;
    user_name: string | null;
    note: string | null;
    reverses_movement_id: string | null;
    is_reversed: boolean;
  }>(
    db,
    sql`
    SELECT
      m.id,
      m.created_at,
      m.component_id,
      c.name AS component_name,
      m.location_id,
      lt.path AS location_path,
      lt.effective_project_id AS project_id,
      p.name AS project_name,
      m.qty_delta,
      m.reason,
      m.user_id,
      u.name AS user_name,
      m.note,
      m.reverses_movement_id,
      (r.id IS NOT NULL) AS is_reversed
    FROM stock_movements m
    JOIN components c    ON c.id = m.component_id
    JOIN location_tree lt ON lt.id = m.location_id
    LEFT JOIN projects p ON p.id = lt.effective_project_id
    LEFT JOIN users u    ON u.id = m.user_id
    LEFT JOIN stock_movements r ON r.reverses_movement_id = m.id
    ${where}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `,
  );

  return rows.map((r) => ({
    id: r.id,
    createdAt: new Date(r.created_at),
    componentId: r.component_id,
    componentName: r.component_name,
    locationId: r.location_id,
    locationPath: r.location_path,
    projectId: r.project_id,
    projectName: r.project_name,
    qtyDelta: Number(r.qty_delta),
    reason: r.reason,
    userId: r.user_id,
    userName: r.user_name,
    note: r.note,
    reversesMovementId: r.reverses_movement_id,
    isReversed: Boolean(r.is_reversed),
  }));
}

/** Options for the log's filter controls. */
export async function getFilterOptions(db: Database) {
  const [people, projects, locations] = await Promise.all([
    runQuery<{ id: string; name: string }>(
      db,
      sql`
        SELECT DISTINCT u.id, u.name
        FROM users u
        JOIN stock_movements m ON m.user_id = u.id
        ORDER BY u.name
      `,
    ),
    runQuery<{ id: string; name: string }>(
      db,
      sql`SELECT id, name FROM projects WHERE status = 'active' ORDER BY name`,
    ),
    runQuery<{ id: string; path: string }>(
      db,
      sql`SELECT id, path FROM location_tree WHERE is_active ORDER BY path`,
    ),
  ]);

  return { people, projects, locations };
}
