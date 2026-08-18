import { notFound } from "next/navigation";

import { db } from "@/db";
import { getProject } from "@/db/queries/projects";
import { canManageProjectBom, requireUser } from "@/lib/auth";
import { NoAccess, Page, PageHeader } from "@/components/ui";
import { BomImport } from "./bom-import";

export const metadata = { title: "Upload a BOM · LabStock" };

export default async function BomImportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const project = await getProject(db, id);
  if (!project) notFound();

  // Wider than the admin gate used elsewhere in the app: the spec puts BOM
  // upload in the hands of "a project head or admin".
  if (!canManageProjectBom(user, project.id)) {
    return (
      <NoAccess>
        Only a head of this project, or an admin, can change its BOM.
      </NoAccess>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Upload a BOM"
        description={`The parts list for ${project.name}. Nothing is saved until you have checked every row.`}
        back={{ href: `/projects/${project.id}`, label: project.name }}
      />
      <BomImport projectId={project.id} projectName={project.name} />
    </Page>
  );
}
