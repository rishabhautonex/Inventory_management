import { canManageInventory, requireUser } from "@/lib/auth";
import { NoAccess, Page, PageHeader } from "@/components/ui";
import { PartsImportForm } from "./parts-import-form";

export const metadata = { title: "Import parts · LabStock" };

/**
 * The spec's one concession to the lab's existing lists: "**Do** provide a
 * simple CSV import for components in case any of it turns out usable."
 *
 * Same gate as adding a part by hand, because that is what this is — the form
 * five hundred times over, with a review screen in front of it.
 */
export default async function PartsImportPage() {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return <NoAccess>Only admins and managers can add parts.</NoAccess>;
  }

  return (
    <Page>
      <PageHeader
        title="Import parts"
        description="A CSV or a pasted table of parts. Nothing is created until you have checked every row — and nothing here touches stock, which only ever comes from the ledger."
        back={{ href: "/admin/parts", label: "All parts" }}
      />
      <PartsImportForm />
    </Page>
  );
}
