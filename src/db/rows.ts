import type { SQL } from "drizzle-orm";

import type { Database, Executor } from "./types";

/**
 * `db.execute()` does not return the same shape on every driver: postgres-js
 * hands back the row array itself, while PGlite (and node-postgres) return a
 * result object with a `rows` property. Normalising in one place keeps raw SQL
 * queries portable between the app and the tests.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];

  if (
    result !== null &&
    typeof result === "object" &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }

  return [];
}

/**
 * Runs raw SQL and returns typed rows.
 *
 * Going through the driver-agnostic `Database` handle erases the row type that
 * `db.execute<T>()` would otherwise carry, so the shape is declared here
 * instead. Callers name the row type once and get full checking on every field.
 */
export async function runQuery<T>(
  db: Database | Executor,
  query: SQL,
): Promise<T[]> {
  const result = await db.execute(query);
  return rowsOf<T>(result);
}
