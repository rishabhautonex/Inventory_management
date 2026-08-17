import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "../src/db/schema";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "..", "drizzle");

/**
 * Boots an in-memory Postgres and applies the real migration files — the same
 * SQL that will run against Supabase. The triggers, check constraints and
 * generated columns under test are therefore the actual ones, not a
 * reimplementation that could drift from production.
 */
export async function createTestDb() {
  const client = new PGlite({ extensions: { pg_trgm } });
  await client.waitReady;

  const journalPath = path.join(migrationsDir, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };

  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    const file = path.join(migrationsDir, `${entry.tag}.sql`);
    const contents = fs.readFileSync(file, "utf8");

    // Strip comment lines first, then discard chunks with nothing left. Done
    // with a single linear pass on purpose: testing "is this chunk only
    // comments?" with a nested-quantifier regex backtracks exponentially on
    // the long comment banners in 0001 and hangs the process.
    const statements = contents
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.replace(/^\s*--.*$/gm, "").trim().length > 0);

    for (const statement of statements) {
      try {
        await client.exec(statement);
      } catch (cause) {
        throw new Error(
          `Migration ${entry.tag} failed on statement:\n${statement.slice(0, 400)}\n\n${String(cause)}`,
          { cause },
        );
      }
    }
  }

  const db = drizzle(client, { schema, casing: "snake_case" });
  return { db, client };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];

/**
 * Flattens an error and its `cause` chain into one searchable string.
 *
 * Drizzle wraps driver errors in a generic "Failed query: ..." Error and hangs
 * the real database message off `cause`, so asserting on `.message` alone would
 * silently pass against the wrapper and never check what the database actually
 * said.
 */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  for (let depth = 0; current != null && depth < 8; depth++) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }

  return parts.join(" | ");
}

let fixtureCounter = 0;

/**
 * Each test gets its own component and location so a single long-lived database
 * can be shared across a file. `stock_movements` cannot be truncated between
 * tests — the append-only trigger blocks it, which is the point.
 */
export async function makeFixtures(
  db: TestDb,
  opts: { componentName?: string; searchTerms?: string; mpn?: string } = {},
) {
  const n = ++fixtureCounter;

  const [user] = await db
    .insert(schema.users)
    .values({
      id: crypto.randomUUID(),
      googleSub: `sub-${n}`,
      email: `user${n}@autonexai360.com`,
      name: `Test User ${n}`,
      role: "admin",
    })
    .returning();

  const [project] = await db
    .insert(schema.projects)
    .values({ name: `Project ${n}`, code: `PRJ${n}` })
    .returning();

  const [cupboard] = await db
    .insert(schema.locations)
    .values({
      name: `Cupboard ${n}`,
      type: "cupboard",
      projectId: project.id,
    })
    .returning();

  const [shelf] = await db
    .insert(schema.locations)
    .values({ name: `Shelf ${n}`, type: "shelf", parentId: cupboard.id })
    .returning();

  const [component] = await db
    .insert(schema.components)
    .values({
      name: opts.componentName ?? `Component ${n}`,
      mpn: opts.mpn ?? `MPN-${n}`,
      searchTerms: opts.searchTerms ?? null,
      createdBy: user.id,
    })
    .returning();

  return { user, project, cupboard, shelf, component };
}
