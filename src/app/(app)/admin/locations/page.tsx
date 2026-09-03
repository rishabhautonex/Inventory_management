import { sql } from "drizzle-orm";

import { db } from "@/db";
import { runQuery } from "@/db/rows";
import { canManageInventory, requireUser } from "@/lib/auth";
import { NoAccess, Page, PageHeader } from "@/components/ui";
import { LocationManager } from "./location-manager";

export const metadata = { title: "Locations · LabStock" };

export type LocationNode = {
  id: string;
  name: string;
  type: "cupboard" | "shelf" | "bin" | "general";
  path: string;
  depth: number;
  parentId: string | null;
  projectId: string | null;
  projectName: string | null;
  isActive: boolean;
  itemCount: number;
  /**
   * What deleting this location would mean, rolled up over everything inside
   * it — because a delete takes the shelves and bins with it, and because a
   * cupboard that looks empty can hold a shelf that has seen a hundred
   * movements.
   *
   * `historyCount` above zero is a refusal, not a warning: a ledger row names
   * its location, so a used shelf can only be retired.
   */
  insideCount: number;
  historyCount: number;
  thresholdCount: number;
};

export default async function LocationsPage() {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return <NoAccess>Only admins and managers can manage locations.</NoAccess>;
  }

  const [tree, projectRows] = await Promise.all([
    runQuery<
      Omit<LocationNode, "itemCount" | "insideCount" | "historyCount" | "thresholdCount"> & {
        item_count: number | string;
        own_movements: number | string;
        own_thresholds: number | string;
      }
    >(
      db,
      sql`
        SELECT
          lt.id,
          lt.name,
          lt.type,
          lt.path,
          lt.depth,
          lt.parent_id      AS "parentId",
          lt.project_id     AS "projectId",
          p.name            AS "projectName",
          lt.is_active      AS "isActive",
          COALESCE(stock.lines, 0) AS item_count,
          COALESCE(moved.movements, 0) AS own_movements,
          COALESCE(mins.thresholds, 0) AS own_thresholds
        FROM location_tree lt
        LEFT JOIN projects p ON p.id = lt.project_id
        LEFT JOIN (
          SELECT location_id, count(*) FILTER (WHERE on_hand > 0) AS lines
          FROM stock_on_hand
          GROUP BY location_id
        ) stock ON stock.location_id = lt.id
        -- Every row the ledger has ever written here, not the on-hand figure:
        -- a shelf emptied back to zero still has a log naming it.
        LEFT JOIN (
          SELECT location_id, count(*) AS movements
          FROM stock_movements
          GROUP BY location_id
        ) moved ON moved.location_id = lt.id
        LEFT JOIN (
          SELECT location_id, count(*) AS thresholds
          FROM stock_thresholds
          GROUP BY location_id
        ) mins ON mins.location_id = lt.id
        ORDER BY lt.path
      `,
    ),
    runQuery<{ id: string; name: string }>(
      db,
      sql`SELECT id, name FROM projects WHERE status = 'active' ORDER BY name`,
    ),
  ]);

  // The three delete figures are rolled up here rather than in SQL: the whole
  // tree is already on hand and ordered by path, so a recursive count per row
  // would be the same numbers read a second time.
  const children = new Map<string, string[]>();
  for (const row of tree) {
    if (!row.parentId) continue;
    children.set(row.parentId, [...(children.get(row.parentId) ?? []), row.id]);
  }

  const byId = new Map(tree.map((row) => [row.id, row]));

  function rollUp(id: string): {
    inside: number;
    movements: number;
    thresholds: number;
  } {
    const row = byId.get(id);
    const totals = {
      inside: 0,
      movements: Number(row?.own_movements ?? 0),
      thresholds: Number(row?.own_thresholds ?? 0),
    };

    for (const childId of children.get(id) ?? []) {
      const child = rollUp(childId);
      totals.inside += child.inside + 1;
      totals.movements += child.movements;
      totals.thresholds += child.thresholds;
    }

    return totals;
  }

  const locations: LocationNode[] = tree.map((row) => {
    const subtree = rollUp(row.id);
    return {
      ...row,
      itemCount: Number(row.item_count),
      insideCount: subtree.inside,
      historyCount: subtree.movements,
      thresholdCount: subtree.thresholds,
    };
  });

  return (
    <Page>
      <PageHeader
        title="Locations"
        description="Each project has its own cupboard. The general shelf holds shared consumables."
        back={{ href: "/admin", label: "Admin" }}
      />
      <LocationManager locations={locations} projects={projectRows} />
    </Page>
  );
}
