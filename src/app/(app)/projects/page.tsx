import Link from "next/link";

import { db } from "@/db";
import { listProjects } from "@/db/queries/projects";
import { canManageInventory, canManageProjectBom, requireUser } from "@/lib/auth";
import { INR } from "@/lib/format";
import { DocumentIcon, GithubIcon, UploadIcon } from "@/components/icons";
import {
  Badge,
  Card,
  EmptyState,
  NoAccess,
  Page,
  PageHeader,
  TableWrap,
  secondaryButtonClass,
  tdClass,
  thClass,
  theadClass,
  trClass,
} from "@/components/ui";

export const metadata = { title: "Projects · LabStock" };

/**
 * The project list, as the spec's screen 7 describes it.
 *
 * Distinct from `/admin/projects`, which is where projects are created and
 * heads are assigned. This one is the *view* — stock, BOM shortfall, spend —
 * and a project head can open it for the projects they run without being an
 * admin.
 */
export default async function ProjectsPage() {
  const user = await requireUser();

  const canSeeAll = canManageInventory(user);
  if (!canSeeAll && user.leadProjectIds.length === 0) {
    return (
      <NoAccess>
        Projects are visible to the heads of that project, and to admins.
      </NoAccess>
    );
  }

  const projects = await listProjects(
    db,
    canSeeAll ? null : user.leadProjectIds,
  );

  return (
    <Page>
      <PageHeader
        title="Projects"
        description="Each project's own cupboard, what its BOM still needs, and what it has cost."
        action={
          canSeeAll ? (
            <Link href="/admin/projects" className={secondaryButtonClass}>
              Manage projects
            </Link>
          ) : undefined
        }
      />

      {projects.length === 0 ? (
        <Card>
          <EmptyState
            title="No projects"
            description="An admin opens a project under Admin → Projects, then gives it a cupboard."
          />
        </Card>
      ) : (
        <TableWrap minWidth={860}>
          <thead className={theadClass}>
            <tr>
              <th className={thClass}>Project</th>
              <th className={thClass}>Heads</th>
              <th className={`${thClass} text-right`}>Parts</th>
              <th className={`${thClass} text-right`}>Pieces</th>
              <th className={`${thClass} text-right`}>Spend</th>
              <th className={thClass}>Waiting on</th>
              <th className={thClass}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id} className={trClass}>
                <td className={tdClass}>
                  <Link
                    href={`/projects/${project.id}`}
                    className="font-medium text-accent-text hover:underline"
                  >
                    {project.name}
                  </Link>
                  <p className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                    <span className="font-mono">{project.code}</span>
                    {project.status === "closed" ? (
                      <Badge tone="neutral">Closed</Badge>
                    ) : null}
                    {project.repoUrl ? (
                      <a
                        href={project.repoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-accent-text hover:underline"
                      >
                        <GithubIcon size={13} />
                        Repo
                      </a>
                    ) : null}
                    {project.readmeUrl ? (
                      <a
                        href={project.readmeUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-accent-text hover:underline"
                      >
                        <DocumentIcon size={13} />
                        Docs
                      </a>
                    ) : null}
                  </p>
                  {project.description ? (
                    <p className="mt-1 max-w-md truncate text-xs text-muted">
                      {project.description}
                    </p>
                  ) : null}
                </td>

                <td className={`${tdClass} text-muted`}>
                  {project.leads.length === 0
                    ? "—"
                    : project.leads.map((lead) => lead.name).join(", ")}
                </td>

                <td className={`${tdClass} text-right tabular-nums`}>
                  {project.distinctParts}
                </td>

                <td className={`${tdClass} text-right tabular-nums text-muted`}>
                  {project.pieces}
                </td>

                <td className={`${tdClass} text-right tabular-nums`}>
                  {project.spend > 0 ? INR.format(project.spend) : "—"}
                </td>

                <td className={tdClass}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {project.pendingRequests > 0 ? (
                      <Badge tone="warning">
                        {project.pendingRequests} to approve
                      </Badge>
                    ) : null}
                    {project.approvedRequests > 0 ? (
                      <Badge tone="accent">
                        {project.approvedRequests} to order
                      </Badge>
                    ) : null}
                    {project.bomCount === 0 ? (
                      <span className="text-xs text-muted">No BOM</span>
                    ) : null}
                  </div>
                </td>

                {/* The BOM is the head's own document, so the upload path is on
                    the row rather than only inside the project page. */}
                <td className={`${tdClass} text-right`}>
                  {canManageProjectBom(user, project.id) ? (
                    <Link
                      href={`/projects/${project.id}/bom`}
                      className="inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border px-3 text-xs font-semibold text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                    >
                      <UploadIcon size={14} />
                      {project.bomCount > 0 ? "New BOM" : "Upload a BOM"}
                    </Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </Page>
  );
}
