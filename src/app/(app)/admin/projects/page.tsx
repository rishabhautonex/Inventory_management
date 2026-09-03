import { sql } from "drizzle-orm";

import { db } from "@/db";
import { runQuery } from "@/db/rows";
import {
  canDeleteProject,
  canManageInventory,
  canManageUsers,
  requireUser,
} from "@/lib/auth";
import { NoAccess, Page, PageHeader } from "@/components/ui";
import { ProjectManager } from "./project-manager";

export const metadata = { title: "Projects · LabStock" };

export type ProjectRow = {
  id: string;
  name: string;
  code: string;
  status: "active" | "closed";
  leads: Array<{ id: string; name: string }>;
  cupboards: number;
  /**
   * What is filed under the project, counted here so the delete confirmation
   * can state it rather than asking somebody to guess. `requests` and `boms`
   * are destroyed with the project; `cupboards` and `orders` survive it and
   * lose their project.
   */
  requests: number;
  boms: number;
  orders: number;
};

export default async function ProjectsPage() {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return <NoAccess>Only admins and managers can manage projects.</NoAccess>;
  }

  const [rows, people] = await Promise.all([
    runQuery<{
      id: string;
      name: string;
      code: string;
      status: "active" | "closed";
      leads: Array<{ id: string; name: string }> | null;
      cupboards: number | string;
      requests: number | string;
      boms: number | string;
      orders: number | string;
    }>(
      db,
      sql`
        SELECT
          p.id,
          p.name,
          p.code,
          p.status,
          COALESCE(
            (
              SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name)
              FROM project_leads pl
              JOIN users u ON u.id = pl.user_id
              WHERE pl.project_id = p.id
            ),
            '[]'::json
          ) AS leads,
          (SELECT count(*) FROM locations l WHERE l.project_id = p.id) AS cupboards,
          (SELECT count(*) FROM part_requests r WHERE r.project_id = p.id) AS requests,
          (SELECT count(*) FROM boms b WHERE b.project_id = p.id) AS boms,
          (SELECT count(*) FROM orders o WHERE o.project_id = p.id) AS orders
        FROM projects p
        ORDER BY p.status, p.name
      `,
    ),
    runQuery<{ id: string; name: string; email: string }>(
      db,
      sql`SELECT id, name, email FROM users WHERE is_active ORDER BY name`,
    ),
  ]);

  const projects: ProjectRow[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    code: row.code,
    status: row.status,
    leads: row.leads ?? [],
    cupboards: Number(row.cupboards),
    requests: Number(row.requests),
    boms: Number(row.boms),
    orders: Number(row.orders),
  }));

  return (
    <Page>
      <PageHeader
        title="Projects"
        description="A project can have more than one head, and a person can head more than one project."
        back={{ href: "/admin", label: "Admin" }}
      />
      <ProjectManager
        projects={projects}
        people={people}
        canAssignLeads={canManageUsers(user)}
        canDelete={canDeleteProject(user)}
      />
    </Page>
  );
}
