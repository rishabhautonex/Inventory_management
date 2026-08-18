import { sql } from "drizzle-orm";

import { runQuery } from "@/db/rows";
import type { Database } from "@/db/types";

/**
 * Catalogue reads that are about the catalogue itself rather than about finding
 * a part to take out. Searching lives in [search.ts](./search.ts).
 */

export type CatalogueClash = {
  /** The value from the import file that already exists in the catalogue. */
  key: string;
  via: "mpn" | "name";
  componentId: string;
  name: string;
  mpn: string | null;
};

/**
 * Which of these part numbers and names the catalogue already holds.
 *
 * Matched through `squash_search` on both sides — the same normalisation as the
 * unique index on `components.mpn` — so "STM32F103C8T6" and "stm32-f103-c8t6"
 * are recognised as the same part. Without this the importer would offer to
 * create a second row that the database would then refuse, and the reviewer
 * would learn about it as an error rather than as a fact about their file.
 *
 * Names are compared exactly (after squashing), never fuzzily. A part *similar*
 * to an existing one is usually a genuinely different part — 10k and 100k
 * resistors read almost identically — and warning about those would train the
 * reviewer to tick past the warnings that matter.
 */
export async function findCatalogueClashes(
  db: Database,
  input: { mpns: string[]; names: string[] },
): Promise<CatalogueClash[]> {
  const clashes: CatalogueClash[] = [];

  if (input.mpns.length > 0) {
    const rows = await runQuery<{
      key: string;
      id: string;
      name: string;
      mpn: string | null;
    }>(
      db,
      sql`
        SELECT needle.key, c.id, c.name, c.mpn
        FROM unnest(${sql.param(input.mpns)}::text[]) AS needle(key)
        JOIN components c
          ON squash_search(c.mpn) = squash_search(needle.key)
        WHERE c.mpn IS NOT NULL AND c.mpn <> ''
      `,
    );

    for (const row of rows) {
      clashes.push({
        key: row.key,
        via: "mpn",
        componentId: row.id,
        name: row.name,
        mpn: row.mpn,
      });
    }
  }

  if (input.names.length > 0) {
    const rows = await runQuery<{
      key: string;
      id: string;
      name: string;
      mpn: string | null;
    }>(
      db,
      sql`
        SELECT needle.key, c.id, c.name, c.mpn
        FROM unnest(${sql.param(input.names)}::text[]) AS needle(key)
        JOIN components c
          ON squash_search(c.name) = squash_search(needle.key)
      `,
    );

    for (const row of rows) {
      clashes.push({
        key: row.key,
        via: "name",
        componentId: row.id,
        name: row.name,
        mpn: row.mpn,
      });
    }
  }

  return clashes;
}
