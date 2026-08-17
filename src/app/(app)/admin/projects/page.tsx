import { sql } from "drizzle-orm";

import { db } from "@/db";
import { runQuery } from "@/db/rows";
import { canManageInventory, canManageUsers, requireUser } from "@/lib/auth";
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
          (SELECT count(*) FROM locations l WHERE l.project_id = p.id) AS cupboards
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
      />
    </Page>
  );
}
