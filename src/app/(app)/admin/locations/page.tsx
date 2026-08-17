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
};

export default async function LocationsPage() {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return <NoAccess>Only admins and managers can manage locations.</NoAccess>;
  }

  const [tree, projectRows] = await Promise.all([
    runQuery<LocationNode & { item_count: number | string }>(
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
          COALESCE(stock.lines, 0) AS item_count
        FROM location_tree lt
        LEFT JOIN projects p ON p.id = lt.project_id
        LEFT JOIN (
          SELECT location_id, count(*) FILTER (WHERE on_hand > 0) AS lines
          FROM stock_on_hand
          GROUP BY location_id
        ) stock ON stock.location_id = lt.id
        ORDER BY lt.path
      `,
    ),
    runQuery<{ id: string; name: string }>(
      db,
      sql`SELECT id, name FROM projects WHERE status = 'active' ORDER BY name`,
    ),
  ]);

  const locations: LocationNode[] = tree.map((row) => ({
    ...row,
    itemCount: Number(row.item_count),
  }));

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
