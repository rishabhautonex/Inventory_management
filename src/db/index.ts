import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";
import type { Database } from "./types";

/**
 * Next imports every route module during a build to collect its config. If the
 * connection were opened at module scope, building without a database URL —
 * which is exactly what CI does — would fail on import rather than on use.
 *
 * The proxy below defers construction to the first actual query, so a missing
 * DATABASE_URL surfaces as a clear error at request time instead.
 */
const globalForDb = globalThis as unknown as {
  __labstockSql?: ReturnType<typeof postgres>;
  __labstockDb?: ReturnType<typeof drizzle<typeof schema>>;
};

function connect() {
  if (globalForDb.__labstockDb) return globalForDb.__labstockDb;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.",
    );
  }

  const client =
    globalForDb.__labstockSql ??
    postgres(connectionString, {
      // Supabase's transaction pooler does not support prepared statements.
      prepare: false,
      // Per instance, not per deployment. A serverless host runs many of these
      // against one pooler, so a generous cap here is how you exhaust it.
      max: 3,
    });

  const instance = drizzle(client, { schema, casing: "snake_case" });

  // Cached in every environment, because both of them reuse this module.
  // Development reloads it on each edit; production reuses the same server
  // instance across requests. Either way, the `db` proxy below calls connect()
  // on every property access, so without this cache each `db.select(...)` would
  // build its own pool and postgres.js would hold those connections open until
  // the pooler ran out of them.
  globalForDb.__labstockSql = client;
  globalForDb.__labstockDb = instance;

  return instance;
}

export const db = new Proxy({} as Database, {
  get(_target, property) {
    const instance = connect();
    const value = Reflect.get(instance as object, property, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
}) as Database;

export { schema };
