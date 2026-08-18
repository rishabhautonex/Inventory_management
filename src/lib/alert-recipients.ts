import { sql } from "drizzle-orm";

import { runQuery } from "@/db/rows";
import type { Database } from "@/db/types";

/**
 * Who hears about a condition on one project's shelf, or one project's order.
 *
 * Admins, plus the heads of that project, and deliberately never managers: the
 * spec keeps them off every per-event list and owes them a digest instead — see
 * [manager-digest.ts](./manager-digest.ts).
 *
 * Shared by the stock alerts and the overdue-order job because the spec states
 * one rule for both, and two copies of it would drift the first time a role was
 * added.
 *
 * A null project is the general shelf, which has no head, so it reaches admins
 * only. A null must never widen to "everybody".
 */
export async function adminsAndProjectHeads(
  db: Database,
  projectId: string | null,
): Promise<string[]> {
  const rows = await runQuery<{ id: string }>(
    db,
    sql`
      SELECT u.id
      FROM users u
      WHERE u.is_active
        AND (
          u.role = 'admin'
          OR (
            u.role = 'project_head'
            AND ${projectId}::uuid IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM project_leads pl
              WHERE pl.user_id = u.id
                AND pl.project_id = ${projectId}::uuid
            )
          )
        )
    `,
  );

  return rows.map((r) => r.id);
}

/** Everybody owed the weekly digest. */
export async function activeManagers(db: Database): Promise<string[]> {
  const rows = await runQuery<{ id: string }>(
    db,
    sql`SELECT id FROM users WHERE is_active AND role = 'manager'`,
  );

  return rows.map((r) => r.id);
}
