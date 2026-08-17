import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type * as schema from "./schema";

/**
 * Driver-agnostic handle. The app runs on postgres-js against Supabase; the
 * tests run on PGlite. Query modules take this so the exact same SQL is
 * exercised in both places — a test that ran against a mock would prove
 * nothing about the constraints and triggers this design depends on.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** A transaction handle, accepted anywhere a Database is. */
export type Executor = Database;
