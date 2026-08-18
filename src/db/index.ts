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

      /**
       * Per instance, not per deployment. A serverless host runs many of these
       * against one pooler, so a generous cap here is how you exhaust it — but
       * too tight a cap is worse. Every page calls `requireUser()`, so with a
       * pool of three, three slow or stuck queries make the whole application
       * stop responding rather than just one screen.
       */
      max: Number(process.env.DATABASE_POOL_MAX ?? 8),

      /**
       * The fix for the app freezing after a period of inactivity.
       *
       * The pooler drops idle client connections, and a laptop that slept or a
       * NAT that timed out does the same. postgres-js cannot tell a dropped
       * socket from a quiet one, so it sends the next query into a socket that
       * nothing is listening to and waits — the query never arrives, so no
       * server-side timeout can rescue it, and the connection is held until TCP
       * eventually gives up. Three of those and the pool is gone.
       *
       * Closing our own idle connections first means a stale socket is never
       * reused. This matters far more than it looks.
       */
      idle_timeout: 20,

      /** Recycles long-lived connections, so one cannot rot in place. */
      max_lifetime: 60 * 30,

      /** An unreachable database should fail in seconds, not hang the request. */
      connect_timeout: 15,
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
