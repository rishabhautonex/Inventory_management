import { sql } from "drizzle-orm";

import { runQuery } from "../rows";
import type { Database } from "../types";
import type { SessionUser } from "@/lib/auth";

export type RequestStatus = "pending" | "approved" | "rejected" | "ordered";

/**
 * Who may see which requests.
 *
 * The spec makes the requests screen role-aware rather than filtered by choice:
 * an engineer sees their own, a head sees the queue for the projects they run,
 * and an admin sees the lot. Expressing that as a value rather than as branches
 * inside the SQL means the page decides once and every query below — list,
 * counts, single row — is scoped the same way.
 */
export type RequestVisibility =
  | { kind: "all" }
  | { kind: "own"; userId: string }
  | { kind: "own_or_projects"; userId: string; projectIds: string[] };

/** The role-to-visibility mapping, in one place. */
export function visibilityFor(user: SessionUser): RequestVisibility {
  if (user.role === "admin" || user.role === "manager") return { kind: "all" };
  if (user.role === "project_head") {
    return {
      kind: "own_or_projects",
      userId: user.id,
      projectIds: user.leadProjectIds,
    };
  }
  return { kind: "own", userId: user.id };
}

function visibilityClause(visibility: RequestVisibility) {
  switch (visibility.kind) {
    case "all":
      return sql`TRUE`;
    case "own":
      return sql`r.requested_by = ${visibility.userId}`;
    case "own_or_projects":
      // An empty project list makes `= ANY('{}')` false rather than an error,
      // so a head with nothing assigned still sees their own requests.
      return sql`(
        r.requested_by = ${visibility.userId}
        OR r.project_id = ANY(${sql.param(visibility.projectIds)}::uuid[])
      )`;
  }
}

export type RequestRow = {
  id: string;
  projectId: string;
  projectName: string;
  requestedById: string;
  requestedByName: string;
  /** Null when the request is free text for something not catalogued yet. */
  componentId: string | null;
  componentName: string | null;
  componentMpn: string | null;
  freeText: string | null;
  /** What the request is for, however it was expressed. */
  label: string;
  qty: number;
  /** What the head approved, when that differs from the ask. Null means as asked. */
  approvedQty: number | null;
  reason: string | null;
  status: RequestStatus;
  decidedById: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  orderId: string | null;
  /** On-hand of the requested part in that project's own cupboards. */
  inProject: number | null;
  createdAt: Date;
};

type RawRequestRow = {
  id: string;
  project_id: string;
  project_name: string;
  requested_by: string;
  requested_by_name: string;
  component_id: string | null;
  component_name: string | null;
  component_mpn: string | null;
  free_text: string | null;
  qty: number | string;
  approved_qty: number | string | null;
  reason: string | null;
  status: RequestStatus;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | Date | null;
  decision_note: string | null;
  order_id: string | null;
  in_project: string | number | null;
  created_at: string | Date;
};

/**
 * Stock of the requested part in the requesting project's own cupboards.
 *
 * Location-scoped on purpose: the lab's policy is that two projects needing the
 * same part buy it twice, so what another cupboard holds is not an answer to
 * this request and must not be offered as one.
 */
const IN_PROJECT = sql`
  CASE WHEN r.component_id IS NULL THEN NULL ELSE COALESCE((
    SELECT SUM(soh.on_hand)
    FROM stock_on_hand soh
    JOIN location_tree lt ON lt.id = soh.location_id
    WHERE soh.component_id = r.component_id
      AND lt.effective_project_id = r.project_id
      AND lt.is_active
  ), 0) END
`;

const SELECT_REQUEST = sql`
  SELECT
    r.id,
    r.project_id,
    p.name           AS project_name,
    r.requested_by,
    ru.name          AS requested_by_name,
    r.component_id,
    c.name           AS component_name,
    c.mpn            AS component_mpn,
    r.free_text,
    r.qty,
    r.approved_qty,
    r.reason,
    r.status,
    r.decided_by,
    du.name          AS decided_by_name,
    r.decided_at,
    r.decision_note,
    r.order_id,
    ${IN_PROJECT}    AS in_project,
    r.created_at
  FROM part_requests r
  JOIN projects p        ON p.id = r.project_id
  JOIN users ru          ON ru.id = r.requested_by
  LEFT JOIN users du     ON du.id = r.decided_by
  LEFT JOIN components c ON c.id = r.component_id
`;

function toRow(r: RawRequestRow): RequestRow {
  return {
    id: r.id,
    projectId: r.project_id,
    projectName: r.project_name,
    requestedById: r.requested_by,
    requestedByName: r.requested_by_name,
    componentId: r.component_id,
    componentName: r.component_name,
    componentMpn: r.component_mpn,
    freeText: r.free_text,
    label: r.component_name ?? r.free_text ?? "Unnamed part",
    qty: Number(r.qty),
    approvedQty: r.approved_qty === null ? null : Number(r.approved_qty),
    reason: r.reason,
    status: r.status,
    decidedById: r.decided_by,
    decidedByName: r.decided_by_name,
    decidedAt: r.decided_at ? new Date(r.decided_at) : null,
    decisionNote: r.decision_note,
    orderId: r.order_id,
    inProject: r.in_project === null ? null : Number(r.in_project),
    createdAt: new Date(r.created_at),
  };
}

export async function listRequests(
  db: Database,
  visibility: RequestVisibility,
  filters: { status?: RequestStatus; projectId?: string; limit?: number } = {},
): Promise<RequestRow[]> {
  const limit = Math.min(filters.limit ?? 100, 200);

  const rows = await runQuery<RawRequestRow>(
    db,
    sql`
      ${SELECT_REQUEST}
      WHERE ${visibilityClause(visibility)}
        ${filters.status ? sql`AND r.status = ${filters.status}` : sql``}
        ${filters.projectId ? sql`AND r.project_id = ${filters.projectId}` : sql``}
      ORDER BY
        -- Anything still waiting on a person sorts first; the rest is history.
        (r.status = 'pending') DESC,
        (r.status = 'approved') DESC,
        r.created_at DESC
      LIMIT ${limit}
    `,
  );

  return rows.map(toRow);
}

/**
 * One request, scoped to what the viewer may see.
 *
 * The visibility clause is part of the lookup rather than a check afterwards,
 * so an id belonging to a project somebody does not lead simply returns null
 * and there is no window in which the row could be read and then refused.
 */
export async function getRequest(
  db: Database,
  visibility: RequestVisibility,
  id: string,
): Promise<RequestRow | null> {
  const rows = await runQuery<RawRequestRow>(
    db,
    sql`
      ${SELECT_REQUEST}
      WHERE r.id = ${id} AND ${visibilityClause(visibility)}
      LIMIT 1
    `,
  );

  const row = rows[0];
  return row ? toRow(row) : null;
}

export type RequestCounts = {
  pending: number;
  approved: number;
  rejected: number;
  ordered: number;
};

export async function getRequestCounts(
  db: Database,
  visibility: RequestVisibility,
): Promise<RequestCounts> {
  const rows = await runQuery<{ status: RequestStatus; total: string | number }>(
    db,
    sql`
      SELECT r.status, count(*) AS total
      FROM part_requests r
      WHERE ${visibilityClause(visibility)}
      GROUP BY r.status
    `,
  );

  const counts: RequestCounts = {
    pending: 0,
    approved: 0,
    rejected: 0,
    ordered: 0,
  };
  for (const row of rows) counts[row.status] = Number(row.total);
  return counts;
}

/**
 * Requests this person can actually act on right now, for the nav badge.
 *
 * Not the same set as the requests they can see: approving is limited to the
 * head of that very project, so a head's own request against a project they do
 * not run is visible to them and not theirs to decide.
 */
export async function countAwaitingMe(
  db: Database,
  user: SessionUser,
): Promise<number> {
  if (user.role === "admin") {
    const rows = await runQuery<{ total: string | number }>(
      db,
      sql`SELECT count(*) AS total FROM part_requests WHERE status = 'approved'`,
    );
    return Number(rows[0]?.total ?? 0);
  }

  if (user.role === "manager") {
    const rows = await runQuery<{ total: string | number }>(
      db,
      sql`
        SELECT count(*) AS total
        FROM part_requests
        WHERE status IN ('pending', 'approved')
      `,
    );
    return Number(rows[0]?.total ?? 0);
  }

  if (user.role !== "project_head") return 0;

  const rows = await runQuery<{ total: string | number }>(
    db,
    sql`
      SELECT count(*) AS total
      FROM part_requests
      WHERE status = 'pending'
        AND project_id = ANY(${sql.param(user.leadProjectIds)}::uuid[])
    `,
  );
  return Number(rows[0]?.total ?? 0);
}
