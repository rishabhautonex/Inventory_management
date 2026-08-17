import { sql } from "drizzle-orm";

import { db } from "@/db";
import { runQuery } from "@/db/rows";
import { canManageUsers, requireUser } from "@/lib/auth";
import { NoAccess, Page, PageHeader } from "@/components/ui";
import { UserList } from "./user-list";

export const metadata = { title: "People · LabStock" };

export type PersonRow = {
  id: string;
  name: string;
  email: string;
  role: "engineer" | "project_head" | "admin" | "manager";
  isActive: boolean;
  projects: string[];
};

export default async function UsersPage() {
  const user = await requireUser();
  if (!canManageUsers(user)) {
    return <NoAccess>Only a manager can assign roles.</NoAccess>;
  }

  const rows = await runQuery<{
    id: string;
    name: string;
    email: string;
    role: PersonRow["role"];
    is_active: boolean;
    projects: string[] | null;
  }>(
    db,
    sql`
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        u.is_active,
        COALESCE(
          (
            SELECT json_agg(p.name ORDER BY p.name)
            FROM project_leads pl
            JOIN projects p ON p.id = pl.project_id
            WHERE pl.user_id = u.id
          ),
          '[]'::json
        ) AS projects
      FROM users u
      ORDER BY u.is_active DESC, u.name
    `,
  );

  const people: PersonRow[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    isActive: row.is_active,
    projects: row.projects ?? [],
  }));

  return (
    <Page>
      <PageHeader
        title="People"
        description="Accounts appear here after their first sign-in. New accounts start as engineers."
        back={{ href: "/admin", label: "Admin" }}
      />
      <UserList people={people} currentUserId={user.id} />
    </Page>
  );
}
