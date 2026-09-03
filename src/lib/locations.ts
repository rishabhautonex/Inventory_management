import { eq, inArray, sql } from "drizzle-orm";

import { runQuery } from "@/db/rows";
import { locations, stockThresholds } from "@/db/schema";
import type { Database } from "@/db/types";

/**
 * Deleting a location.
 *
 * Retiring is the reversible option and is what almost every case wants — a
 * cupboard that is no longer in use keeps every movement ever made against it
 * and simply stops being offered as somewhere to put things. Deleting is for a
 * location that should never have existed: a typo, a duplicate, a shelf added
 * to the wrong cupboard ten seconds ago.
 *
 * Which is why the rule here is narrower than the project one:
 *
 * **A location that has ever seen a movement cannot be deleted at all.**
 *
 * `stock_movements.location_id` is `ON DELETE restrict`, so the database says
 * the same thing; the check below exists so that somebody is told *which* shelf
 * has history and what to do instead, rather than being handed a constraint
 * name. The ledger is append-only, every row in it names a location, and a row
 * naming a place that no longer exists is a log that cannot be read. Nothing in
 * this file touches `stock_movements`, and nothing ever should.
 *
 * The consequence worth stating: this delete cannot destroy anybody else's
 * work, because a location with any of it recorded against it is refused. That
 * is what makes it an ordinary correction and not the deliberate, retyped
 * confirmation a project delete asks for.
 *
 * What it does take with it:
 *
 *  - **The shelves and bins inside it.** `locations.parent_id` is also
 *    `restrict`, so a cupboard can only go once its children have, and asking
 *    somebody to delete a mistyped cupboard leaf-first is ceremony. They go in
 *    the same transaction, deepest first, and the count is reported.
 *  - **The minimums set on them.** Those would cascade on their own; they are
 *    deleted explicitly so the number the reviewer is shown is a counted one.
 */

export type LocationDeletion = {
  name: string;
  /** Itself, plus every shelf and bin inside it. */
  deletedLocations: number;
  /** Low-stock minimums that were set on any of them. */
  clearedThresholds: number;
};

export type LocationDeleteResult =
  | { ok: true; deleted: LocationDeletion }
  | { ok: false; reason: "missing" }
  /** `named` lists the locations that hold the history, nearest first. */
  | { ok: false; reason: "history"; movements: number; named: string[] };

type SubtreeRow = {
  id: string;
  name: string;
  depth: number | string;
  movements: number | string;
};

export async function deleteLocationCascade(
  db: Database,
  locationId: string,
): Promise<LocationDeleteResult> {
  return db.transaction(async (tx) => {
    // The location and everything inside it, deepest last, with the number of
    // ledger rows naming each one. Counted inside the transaction because the
    // answer is what decides whether the delete may happen at all.
    const subtree = await runQuery<SubtreeRow>(
      tx,
      sql`
        WITH RECURSIVE subtree AS (
          SELECT l.id, l.name, 1 AS depth
          FROM locations l
          WHERE l.id = ${locationId}

          UNION ALL

          SELECT child.id, child.name, parent.depth + 1
          FROM locations child
          JOIN subtree parent ON child.parent_id = parent.id
        )
        SELECT
          s.id,
          s.name,
          s.depth,
          COALESCE(m.movements, 0) AS movements
        FROM subtree s
        LEFT JOIN (
          SELECT location_id, count(*) AS movements
          FROM stock_movements
          GROUP BY location_id
        ) m ON m.location_id = s.id
        ORDER BY s.depth
      `,
    );

    if (subtree.length === 0) return { ok: false, reason: "missing" };

    const withHistory = subtree.filter((row) => Number(row.movements) > 0);
    if (withHistory.length > 0) {
      return {
        ok: false,
        reason: "history",
        movements: withHistory.reduce((sum, row) => sum + Number(row.movements), 0),
        named: withHistory.map((row) => row.name),
      };
    }

    const ids = subtree.map((row) => row.id);

    const thresholds = await tx
      .delete(stockThresholds)
      .where(inArray(stockThresholds.locationId, ids))
      .returning({ id: stockThresholds.id });

    // Deepest first: a parent cannot go before its children, by `restrict`.
    const deepestFirst = [...subtree].sort(
      (a, b) => Number(b.depth) - Number(a.depth),
    );
    for (const row of deepestFirst) {
      await tx.delete(locations).where(eq(locations.id, row.id));
    }

    return {
      ok: true,
      deleted: {
        name: subtree[0].name,
        deletedLocations: subtree.length,
        clearedThresholds: thresholds.length,
      },
    };
  });
}
