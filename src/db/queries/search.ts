import { sql } from "drizzle-orm";

import { runQuery } from "../rows";
import type { Database } from "../types";

/**
 * One row per component-location pair, which is the whole trick behind the
 * two-tap take-out flow: the user picks the location by tapping the row, so
 * choosing where to take stock from costs zero extra interactions.
 */
export type SearchHit = {
  componentId: string;
  name: string;
  mpn: string | null;
  manufacturer: string | null;
  category: string | null;
  photoUrl: string | null;
  /** Null only when the component has never been stocked anywhere. */
  locationId: string | null;
  locationName: string | null;
  locationPath: string | null;
  projectId: string | null;
  projectName: string | null;
  onHand: number;
  minQty: number | null;
  score: number;
};

export type SearchOptions = {
  limit?: number;
  /**
   * Minimum word-similarity for a fuzzy hit. Lower catches more typos at the
   * cost of noise; 0.4 keeps "esp32 devkti" working without dragging in
   * unrelated parts.
   */
  threshold?: number;
};

/**
 * Fuzzy component search.
 *
 * Matches across name, mpn, manufacturer, category and search_terms via the two
 * generated columns:
 *
 *   search_squashed  separators stripped, so "esp 32" / "esp-32" / "ESP32" all
 *                    collapse to the same string and match exactly
 *   search_blob      separators intact, for trigram word-similarity so typos
 *                    and partial words still land
 *
 * Ranking, highest first:
 *   1.00  the component's own name contains the query
 *   0.80  some other searchable field contains it
 *   ≤0.7  fuzzy trigram match
 *
 * In-stock rows always sort above out-of-stock ones, which are kept rather than
 * hidden so the user can see a part exists but the cupboard is empty.
 */
export async function searchComponents(
  db: Database,
  rawQuery: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  const limit = options.limit ?? 50;
  const threshold = options.threshold ?? 0.4;
  const trimmed = rawQuery.trim();

  if (trimmed === "") return [];

  const rows = await runQuery<{
    component_id: string;
    name: string;
    mpn: string | null;
    manufacturer: string | null;
    category: string | null;
    photo_url: string | null;
    location_id: string | null;
    location_name: string | null;
    location_path: string | null;
    project_id: string | null;
    project_name: string | null;
    on_hand: number | string | null;
    min_qty: number | null;
    score: number | string;
  }>(
    db,
    sql`
    WITH q AS (
      SELECT
        lower(${trimmed})           AS raw,
        squash_search(${trimmed})   AS squashed
    ),
    matched AS (
      SELECT
        c.id,
        c.name,
        c.mpn,
        c.manufacturer,
        c.category,
        c.photo_url,
        GREATEST(
          CASE
            WHEN q.squashed <> ''
             AND squash_search(c.name) LIKE '%' || q.squashed || '%'
            THEN 1.0
            ELSE 0
          END,
          CASE
            WHEN q.squashed <> ''
             AND c.search_squashed LIKE '%' || q.squashed || '%'
            THEN 0.8
            ELSE 0
          END,
          word_similarity(q.raw, c.search_blob) * 0.7
        ) AS score
      FROM components c
      CROSS JOIN q
      WHERE
        (q.squashed <> '' AND c.search_squashed LIKE '%' || q.squashed || '%')
        OR word_similarity(q.raw, c.search_blob) >= ${threshold}
    )
    SELECT
      m.id            AS component_id,
      m.name,
      m.mpn,
      m.manufacturer,
      m.category,
      m.photo_url,
      lt.id           AS location_id,
      lt.name         AS location_name,
      lt.path         AS location_path,
      p.id            AS project_id,
      p.name          AS project_name,
      COALESCE(soh.on_hand, 0) AS on_hand,
      st.min_qty,
      m.score
    FROM matched m
    -- LEFT JOIN so a catalogued-but-never-stocked part still surfaces.
    LEFT JOIN stock_on_hand soh ON soh.component_id = m.id
    LEFT JOIN location_tree lt  ON lt.id = soh.location_id
    LEFT JOIN projects p        ON p.id = lt.effective_project_id
    LEFT JOIN stock_thresholds st
           ON st.component_id = m.id AND st.location_id = lt.id
    WHERE lt.id IS NULL OR lt.is_active
    ORDER BY
      (COALESCE(soh.on_hand, 0) > 0) DESC,  -- in stock first
      m.score DESC,
      COALESCE(soh.on_hand, 0) DESC,
      m.name ASC,
      lt.path ASC
    LIMIT ${limit}
  `,
  );

  return rows.map((r) => ({
    componentId: r.component_id,
    name: r.name,
    mpn: r.mpn,
    manufacturer: r.manufacturer,
    category: r.category,
    photoUrl: r.photo_url,
    locationId: r.location_id,
    locationName: r.location_name,
    locationPath: r.location_path,
    projectId: r.project_id,
    projectName: r.project_name,
    onHand: Number(r.on_hand ?? 0),
    minQty: r.min_qty === null ? null : Number(r.min_qty),
    score: Number(r.score),
  }));
}
