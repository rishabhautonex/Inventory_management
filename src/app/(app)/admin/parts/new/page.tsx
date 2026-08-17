import { canManageInventory, requireUser } from "@/lib/auth";
import { NoAccess, Page, PageHeader } from "@/components/ui";
import { PartForm } from "../part-form";

export const metadata = { title: "New part · LabStock" };

export default async function NewPartPage() {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return <NoAccess>Only admins and managers can add parts.</NoAccess>;
  }

  return (
    <Page>
      <PageHeader
        title="Add a part"
        description="Fill in the keywords generously — they are what search matches on."
        back={{ href: "/admin/parts", label: "All parts" }}
      />
      <PartForm />
    </Page>
  );
}
