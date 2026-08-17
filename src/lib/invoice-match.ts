import { searchComponents } from "@/db/queries/search";
import type { Database } from "@/db/types";
import { candidateLines } from "@/lib/invoice-extract";

/**
 * Matches invoice line descriptions against the catalogue.
 *
 * Line parsing lives in invoice-extract.ts and is shared with the intake flow,
 * so there is exactly one notion of "what is the description part of this line"
 * — two would drift, and the drift would show up as a suggestion that disagrees
 * with the line it came from.
 */

export { candidateLines };

export type MatchCandidate = {
  componentId: string;
  name: string;
  mpn: string | null;
  score: number;
};

export type LineSuggestion = {
  line: string;
  candidates: MatchCandidate[];
};

/**
 * Ranked catalogue matches for one description.
 *
 * Reuses the same fuzzy search the main search box uses, so "esp 32" on an
 * invoice matches ESP32 for exactly the reason it does when typed — no second,
 * subtly different matching implementation to keep in step.
 */
export async function matchDescription(
  db: Database,
  description: string,
  limit = 3,
): Promise<MatchCandidate[]> {
  const hits = await searchComponents(db, description, { limit: limit * 3 });

  // Search returns one row per component-location pair; a suggestion list wants
  // each component once.
  const byComponent = new Map<string, MatchCandidate>();
  for (const hit of hits) {
    if (byComponent.has(hit.componentId)) continue;
    byComponent.set(hit.componentId, {
      componentId: hit.componentId,
      name: hit.name,
      mpn: hit.mpn,
      score: hit.score,
    });
    if (byComponent.size >= limit) break;
  }

  return [...byComponent.values()];
}

/** Suggestions for every candidate line, for the read-only invoice panel. */
export async function suggestComponents(
  db: Database,
  ocrText: string,
  options: { perLine?: number } = {},
): Promise<LineSuggestion[]> {
  const perLine = options.perLine ?? 3;
  const lines = candidateLines(ocrText);

  const suggestions = await Promise.all(
    lines.map(async (line) => ({
      line,
      candidates: await matchDescription(db, line, perLine),
    })),
  );

  // Lines with nothing to suggest are dropped: an empty row teaches the reader
  // nothing and pushes the useful rows off the screen.
  return suggestions.filter((s) => s.candidates.length > 0);
}
