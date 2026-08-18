import { db } from "@/db";
import { listVendorsWithSpend } from "@/db/queries/vendors";
import { canManageInventory, requireUser } from "@/lib/auth";
import {
  Card,
  EmptyState,
  NoAccess,
  Page,
  PageHeader,
} from "@/components/ui";
import { VendorList } from "./vendor-list";

export const metadata = { title: "Vendors · LabStock" };

/**
 * Who the lab buys from.
 *
 * Vendors arrive by name as somebody types an invoice, which keeps receiving fast
 * and leaves one loose end: a typo forks a supplier in two, and every spend
 * figure then reports half of what was really spent with them. Renaming and
 * merging are the two writes that close it.
 */
export default async function VendorsPage() {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return <NoAccess>Only admins and managers can manage vendors.</NoAccess>;
  }

  const vendors = await listVendorsWithSpend(db);

  return (
    <Page>
      <PageHeader
        title="Vendors"
        description="Created as orders are raised. Fix a name here, or fold a duplicate into the one you are keeping — the orders move with it."
        back={{ href: "/admin", label: "Admin" }}
      />

      {vendors.length === 0 ? (
        <Card>
          <EmptyState
            title="No vendors yet"
            description="They appear here as soon as an order names one. There is nothing to set up first."
          />
        </Card>
      ) : (
        <VendorList vendors={vendors} />
      )}
    </Page>
  );
}
