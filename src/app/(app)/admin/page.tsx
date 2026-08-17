import { sql } from "drizzle-orm";

import { db } from "@/db";
import { runQuery } from "@/db/rows";
import { canManageInventory, canManageUsers, requireUser } from "@/lib/auth";
import {
  ArchiveIcon,
  LayersIcon,
  PackageIcon,
  UsersIcon,
} from "@/components/icons";
import { NoAccess, Page, PageHeader, StatCard } from "@/components/ui";

export const metadata = { title: "Admin · LabStock" };

export default async function AdminPage() {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return <NoAccess>Admin tools are limited to admins and managers.</NoAccess>;
  }

  const [counts] = await runQuery<{
    parts: number;
    projects: number;
    locations: number;
    people: number;
  }>(
    db,
    sql`
      SELECT
        (SELECT count(*) FROM components)                       AS parts,
        (SELECT count(*) FROM projects WHERE status = 'active') AS projects,
        (SELECT count(*) FROM locations WHERE is_active)        AS locations,
        (SELECT count(*) FROM users WHERE is_active)            AS people
    `,
  );

  const tiles = [
    {
      href: "/admin/parts",
      label: "Parts",
      icon: <PackageIcon />,
      tone: "accent" as const,
      hint: "The catalogue, including search keywords.",
      count: counts?.parts,
    },
    {
      href: "/admin/locations",
      label: "Locations",
      icon: <ArchiveIcon />,
      tone: "positive" as const,
      hint: "Cupboards, shelves and bins, plus the general shelf.",
      count: counts?.locations,
    },
    {
      href: "/admin/projects",
      label: "Projects",
      icon: <LayersIcon />,
      tone: "warning" as const,
      hint: "Projects and who heads them.",
      count: counts?.projects,
    },
    ...(canManageUsers(user)
      ? [
          {
            href: "/admin/users",
            label: "People",
            icon: <UsersIcon />,
            tone: "accent" as const,
            hint: "Assign roles and project heads.",
            count: counts?.people,
          },
        ]
      : []),
  ];

  return (
    <Page>
      <PageHeader
        title="Admin"
        description="Set up what everyone else uses."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((tile) => (
          <StatCard
            key={tile.href}
            href={tile.href}
            icon={tile.icon}
            tone={tile.tone}
            label={tile.label}
            value={Number(tile.count ?? 0)}
            hint={tile.hint}
          />
        ))}
      </div>
    </Page>
  );
}
