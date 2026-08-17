import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { components } from "@/db/schema";
import { canManageInventory, requireUser } from "@/lib/auth";
import { NoAccess, Page, PageHeader } from "@/components/ui";
import { PartForm } from "../part-form";

export const metadata = { title: "Edit part · LabStock" };

export default async function EditPartPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return <NoAccess>Only admins and managers can edit parts.</NoAccess>;
  }

  const { id } = await params;
  const [component] = await db
    .select()
    .from(components)
    .where(eq(components.id, id));

  if (!component) notFound();

  return (
    <Page>
      <PageHeader
        title="Edit part"
        description={component.name}
        back={{ href: `/parts/${component.id}`, label: "the part" }}
      />
      <PartForm
        componentId={component.id}
        initial={{
          name: component.name,
          mpn: component.mpn ?? "",
          manufacturer: component.manufacturer ?? "",
          category: component.category ?? "",
          searchTerms: component.searchTerms ?? "",
          productUrl: component.productUrl ?? "",
          datasheetUrl: component.datasheetUrl ?? "",
          photoUrl: component.photoUrl ?? "",
          notes: component.notes ?? "",
        }}
      />
    </Page>
  );
}
