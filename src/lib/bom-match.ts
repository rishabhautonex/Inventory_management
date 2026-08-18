import { sql } from "drizzle-orm";

import { runQuery } from "@/db/rows";
import type { Database } from "@/db/types";
import { searchComponents } from "@/db/queries/search";
import type { BomParseRow } from "@/lib/bom-parse";

/**
 * ===========================================================================
 * BOM MATCHING
 * ===========================================================================
 *
 * The spec's order is exact-then-fuzzy: "match each row to an existing
 * component by normalised MPN first, then fuzzy name". That order matters. An
 * MPN identifies one part and nothing else, so when the spreadsheet carries one
 * there is no reason to let a similar-sounding name outrank it — and the
 * catalogue's unique index is on exactly the same normalisation, so a hit here
 * is the one and only row that could have matched.
 *
 * Fuzzy matching reuses the same search the main box uses, so "esp 32" in a BOM
 * finds ESP32 for exactly the reason it does when typed. A second, subtly
 * different matcher would drift from it.
 *
 * Nothing here writes, and nothing here decides. It proposes, and the review
 * screen is where a person accepts.
 * ===========================================================================
 */

export type BomMatch = {
  componentId: string;
  name: string;
  mpn: string | null;
  /** 1 for an MPN hit; the search score otherwise. */
  score: number;
  via: "mpn" | "name";
};

export type BomMatchedRow = BomParseRow & {
  matches: BomMatch[];
  /**
   * The match the review screen pre-selects, or null to leave it unanswered.
   *
   * Only exact MPN hits and literal name containment are pre-selected. A merely
   * similar name is offered in the list but never ticked, because a wrong
   * pre-selection is the one a reviewer scrolls past without reading.
   */
  suggestedComponentId: string | null;
};

/** Search scores at or above this mean the query appeared verbatim in a field. */
const CONFIDENT_SCORE = 0.8;

/** Fuzzy lookups run in small waves rather than all at once. */
const BATCH = 20;

/**
 * Exact catalogue hits for a batch of identifiers, in one round trip.
 *
 * `squash_search` on both sides is the same normalisation the unique index on
 * `components.mpn` uses, so "STM32F103C8T6", "stm32f103c8t6" and
 * "STM32-F103-C8T6" all resolve to the same row.
 */
async function matchByMpn(
  db: Database,
  identifiers: string[],
): Promise<Map<string, BomMatch>> {
  const found = new Map<string, BomMatch>();
  if (identifiers.length === 0) return found;

  const rows = await runQuery<{
    key: string;
    id: string;
    name: string;
    mpn: string | null;
  }>(
    db,
    sql`
      SELECT
        needle.key,
        c.id,
        c.name,
        c.mpn
      FROM unnest(${sql.param(identifiers)}::text[]) AS needle(key)
      JOIN components c
        ON squash_search(c.mpn) = squash_search(needle.key)
      WHERE c.mpn IS NOT NULL AND c.mpn <> ''
    `,
  );

  for (const row of rows) {
    if (found.has(row.key)) continue;
    found.set(row.key, {
      componentId: row.id,
      name: row.name,
      mpn: row.mpn,
      score: 1,
      via: "mpn",
    });
  }

  return found;
}

/** Ranked fuzzy candidates for one description. */
async function matchByName(
  db: Database,
  text: string,
  limit: number,
): Promise<BomMatch[]> {
  const hits = await searchComponents(db, text, { limit: limit * 3 });

  // Search returns one row per component-location pair; a candidate list wants
  // each component once.
  const byComponent = new Map<string, BomMatch>();
  for (const hit of hits) {
    if (byComponent.has(hit.componentId)) continue;
    byComponent.set(hit.componentId, {
      componentId: hit.componentId,
      name: hit.name,
      mpn: hit.mpn,
      score: hit.score,
      via: "name",
    });
    if (byComponent.size >= limit) break;
  }

  return [...byComponent.values()];
}

/**
 * Proposes a catalogue match for every parsed row.
 *
 * A row that matched on MPN still gets its fuzzy candidates listed underneath,
 * because an MPN typed into the wrong column is a real mistake and the reviewer
 * needs somewhere to go when the exact hit is plainly the wrong part.
 */
export async function matchBomRows(
  db: Database,
  rows: BomParseRow[],
  options: { perRow?: number } = {},
): Promise<BomMatchedRow[]> {
  const perRow = options.perRow ?? 4;

  const exact = await matchByMpn(
    db,
    [...new Set(rows.map((row) => row.identifier))],
  );

  const matched: BomMatchedRow[] = [];

  for (let start = 0; start < rows.length; start += BATCH) {
    const wave = rows.slice(start, start + BATCH);

    const results = await Promise.all(
      wave.map(async (row) => {
        const mpnHit = exact.get(row.identifier) ?? null;

        let fuzzy = await matchByName(db, row.identifier, perRow);

        // The name column is worth a look when the MPN column found nothing —
        // a BOM exported with an internal code in the part-number field is
        // common, and the name beside it is still a real part.
        if (fuzzy.length === 0 && !mpnHit && row.secondary) {
          fuzzy = await matchByName(db, row.secondary, perRow);
        }

        const candidates: BomMatch[] = mpnHit
          ? [
              mpnHit,
              ...fuzzy.filter((m) => m.componentId !== mpnHit.componentId),
            ]
          : fuzzy;

        const best = candidates[0] ?? null;
        const suggestedComponentId =
          mpnHit?.componentId ??
          (best && best.score >= CONFIDENT_SCORE ? best.componentId : null);

        return {
          ...row,
          matches: candidates.slice(0, perRow),
          suggestedComponentId,
        };
      }),
    );

    matched.push(...results);
  }

  return matched;
}
