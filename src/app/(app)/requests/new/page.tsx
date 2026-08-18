import { sql } from "drizzle-orm";

import { db } from "@/db";
import { runQuery } from "@/db/rows";
import { requireUser } from "@/lib/auth";
import { Card, EmptyState, Page, PageHeader } from "@/components/ui";
import { RequestForm } from "./request-form";

export const metadata = { title: "Ask for a part · LabStock" };

/**
 * Raising a request is open to everyone signed in — an engineer at an empty
 * cupboard is exactly who this screen is for, so there is no role gate here.
 *
 * The part and project can arrive prefilled in the query string, which is what
 * lets a search result with nothing on the shelf hand straight over.
 */
export default async function NewRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; component?: string }>;
}) {
  await requireUser();
  const params = await searchParams;

  const projects = await runQuery<{ id: string; name: string; code: string }>(
    db,
    sql`SELECT id, name, code FROM projects WHERE status = 'active' ORDER BY name`,
  );

  const prefilled = params.component
    ? (
        await runQuery<{ id: string; name: string; mpn: string | null }>(
          db,
          sql`SELECT id, name, mpn FROM components WHERE id = ${params.component}`,
        )
      )[0]
    : undefined;

  return (
    <Page>
      <PageHeader
        title="Ask for a part"
        description="A project head decides, then an admin buys it. Nothing here changes stock."
        back={{ href: "/requests", label: "Requests" }}
      />

      {projects.length === 0 ? (
        <Card>
          <EmptyState
            title="No open projects"
            description="A request has to belong to a project, and there are no active ones. An admin can open one under Admin → Projects."
          />
        </Card>
      ) : (
        <RequestForm
          projects={projects}
          defaultProjectId={
            projects.some((p) => p.id === params.project) ? params.project : undefined
          }
          defaultComponent={
            prefilled
              ? {
                  componentId: prefilled.id,
                  name: prefilled.name,
                  mpn: prefilled.mpn,
                }
              : null
          }
        />
      )}
    </Page>
  );
}
