import { sql } from "drizzle-orm";

import { runQuery } from "../rows";
import type { Database } from "../types";

/**
 * ===========================================================================
 * BOMS AND SHORTFALL
 * ===========================================================================
 *
 * A BOM is a list of intentions, exactly like an order: it says what a project
 * needs, and says nothing whatever about what is on a shelf. Every quantity on
 * the right-hand side of the shortfall table is therefore derived at read time
 * from the ledger, and there is no column anywhere that could drift out of step
 * with it.
 *
 * The comparison is deliberately narrow. "In the cupboard" means *this
 * project's* locations and no others, because the lab's policy is that two
 * projects needing the same part buy it twice — offering a neighbouring
 * cupboard's stock as an answer would be offering to break that policy.
 * ===========================================================================
 */

/** Un-reversed receipts against an order line, i.e. what actually arrived. */
const SHELVED_QTY = sql`
  COALESCE((
    SELECT SUM(m.qty_delta)
    FROM stock_movements m
    WHERE m.order_line_id = ol.id
      AND NOT EXISTS (
        SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = m.id
      )
  ), 0)
`;

export type BomSummary = {
  id: string;
  projectId: string;
  name: string;
  version: string | null;
  uploadedByName: string | null;
  lineCount: number;
  createdAt: Date;
};

export async function listProjectBoms(
  db: Database,
  projectId: string,
): Promise<BomSummary[]> {
  const rows = await runQuery<{
    id: string;
    project_id: string;
    name: string;
    version: string | null;
    uploaded_by_name: string | null;
    line_count: string | number;
    created_at: string | Date;
  }>(
    db,
    sql`
      SELECT
        b.id,
        b.project_id,
        b.name,
        b.version,
        u.name AS uploaded_by_name,
        (SELECT count(*) FROM bom_lines bl WHERE bl.bom_id = b.id) AS line_count,
        b.created_at
      FROM boms b
      LEFT JOIN users u ON u.id = b.uploaded_by
      WHERE b.project_id = ${projectId}
      ORDER BY b.created_at DESC
    `,
  );

  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    version: r.version,
    uploadedByName: r.uploaded_by_name,
    lineCount: Number(r.line_count),
    createdAt: new Date(r.created_at),
  }));
}

export type ShortfallLine = {
  bomLineId: string;
  componentId: string;
  componentName: string;
  componentMpn: string | null;
  /** What the BOM asks for. */
  needed: number;
  /** On-hand across this project's own locations. */
  inProject: number;
  /** Ordered for this project and not yet on a shelf. */
  onOrder: number;
  /** Already asked for and not yet bought or turned down. */
  requested: number;
  /** `needed - inProject`, floored at zero. The spec's "to buy". */
  toBuy: number;
};

export type BomShortfall = {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  version: string | null;
  uploadedByName: string | null;
  createdAt: Date;
  lines: ShortfallLine[];
  totals: {
    lines: number;
    shortLines: number;
    piecesToBuy: number;
  };
};

/**
 * One BOM with its shortfall worked out.
 *
 * `toBuy` is `needed - inProject` and nothing else, which is what the spec
 * asks for. `onOrder` and `requested` sit beside it as information rather than
 * being subtracted: a box that has not arrived is not stock, and quietly
 * netting it off would show zero to buy for a part nobody actually has. What
 * they do is stop somebody ordering the same thing twice, which is why they are
 * on the screen at all.
 */
export async function getBomShortfall(
  db: Database,
  bomId: string,
): Promise<BomShortfall | null> {
  const heads = await runQuery<{
    id: string;
    project_id: string;
    project_name: string;
    name: string;
    version: string | null;
    uploaded_by_name: string | null;
    created_at: string | Date;
  }>(
    db,
    sql`
      SELECT
        b.id,
        b.project_id,
        p.name AS project_name,
        b.name,
        b.version,
        u.name AS uploaded_by_name,
        b.created_at
      FROM boms b
      JOIN projects p    ON p.id = b.project_id
      LEFT JOIN users u  ON u.id = b.uploaded_by
      WHERE b.id = ${bomId}
    `,
  );

  const head = heads[0];
  if (!head) return null;

  const rows = await runQuery<{
    bom_line_id: string;
    component_id: string;
    component_name: string;
    component_mpn: string | null;
    qty_needed: string | number;
    in_project: string | number;
    on_order: string | number;
    requested: string | number;
  }>(
    db,
    sql`
      SELECT
        bl.id           AS bom_line_id,
        bl.component_id,
        c.name          AS component_name,
        c.mpn           AS component_mpn,
        bl.qty_needed,

        COALESCE((
          SELECT SUM(soh.on_hand)
          FROM stock_on_hand soh
          JOIN location_tree lt ON lt.id = soh.location_id
          WHERE soh.component_id = bl.component_id
            AND lt.effective_project_id = ${head.project_id}
            AND lt.is_active
        ), 0) AS in_project,

        COALESCE((
          SELECT SUM(GREATEST(ol.qty - ${SHELVED_QTY}, 0))
          FROM order_lines ol
          JOIN orders o ON o.id = ol.order_id
          WHERE ol.component_id = bl.component_id
            AND o.project_id = ${head.project_id}
            AND o.status <> 'cancelled'
        ), 0) AS on_order,

        COALESCE((
          SELECT SUM(pr.qty)
          FROM part_requests pr
          WHERE pr.component_id = bl.component_id
            AND pr.project_id = ${head.project_id}
            AND pr.status IN ('pending', 'approved')
        ), 0) AS requested

      FROM bom_lines bl
      JOIN components c ON c.id = bl.component_id
      WHERE bl.bom_id = ${bomId}
    `,
  );

  const lines: ShortfallLine[] = rows
    .map((r) => {
      const needed = Number(r.qty_needed);
      const inProject = Number(r.in_project);
      return {
        bomLineId: r.bom_line_id,
        componentId: r.component_id,
        componentName: r.component_name,
        componentMpn: r.component_mpn,
        needed,
        inProject,
        onOrder: Number(r.on_order),
        requested: Number(r.requested),
        toBuy: Math.max(0, needed - inProject),
      };
    })
    // Biggest gaps first: the point of the screen is what still has to be
    // bought, and a complete line is the one nobody needs to read.
    .sort((a, b) => b.toBuy - a.toBuy || a.componentName.localeCompare(b.componentName));

  return {
    id: head.id,
    projectId: head.project_id,
    projectName: head.project_name,
    name: head.name,
    version: head.version,
    uploadedByName: head.uploaded_by_name,
    createdAt: new Date(head.created_at),
    lines,
    totals: {
      lines: lines.length,
      shortLines: lines.filter((line) => line.toBuy > 0).length,
      piecesToBuy: lines.reduce((sum, line) => sum + line.toBuy, 0),
    },
  };
}

/**
 * The BOM a project page shows by default.
 *
 * The newest one. Older uploads are kept rather than replaced — a BOM is a
 * record of what was asked for at a point in time — but only one can be the
 * current answer to "what is this project short of", and the most recent upload
 * is the only defensible choice for that.
 */
export async function getLatestBomId(
  db: Database,
  projectId: string,
): Promise<string | null> {
  const rows = await runQuery<{ id: string }>(
    db,
    sql`
      SELECT id FROM boms
      WHERE project_id = ${projectId}
      ORDER BY created_at DESC
      LIMIT 1
    `,
  );
  return rows[0]?.id ?? null;
}
