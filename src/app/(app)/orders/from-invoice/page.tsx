import { sql } from "drizzle-orm";

import { db } from "@/db";
import { runQuery } from "@/db/rows";
import { canManageInventory, requireUser } from "@/lib/auth";
import { checkInvoiceStorageConfig } from "@/lib/storage";
import { NoAccess, Page, PageHeader } from "@/components/ui";
import { InvoiceIntake } from "./invoice-intake";

export const metadata = { title: "Order from an invoice · LabStock" };

/**
 * Reading an invoice runs OCR, and a multi-page scan takes minutes rather than
 * seconds. Server actions run under the route that invoked them, so the limit
 * has to be raised here rather than in the action. Cap it to whatever the host
 * plan actually allows.
 */
export const maxDuration = 300;

export default async function FromInvoicePage() {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return <NoAccess>Only admins and managers can record orders.</NoAccess>;
  }

  const [projects, locations] = await Promise.all([
    runQuery<{ id: string; name: string }>(
      db,
      sql`SELECT id, name FROM projects WHERE status = 'active' ORDER BY name`,
    ),
    runQuery<{ id: string; path: string }>(
      db,
      sql`SELECT id, path FROM location_tree WHERE is_active ORDER BY path`,
    ),
  ]);

  const storage = checkInvoiceStorageConfig();

  return (
    <Page>
      <PageHeader
        title="Order from an invoice"
        description="Upload a bill and it will be read for you. You confirm every line and choose where each part goes before anything is recorded."
        back={{ href: "/orders", label: "Orders" }}
      />

      {storage.ok ? null : (
        <div className="mb-4 rounded-xl border border-danger/30 bg-danger/10 px-4 py-4">
          <p className="text-sm font-semibold text-danger">
            Invoice storage is not set up yet
          </p>
          <p className="mt-1 text-sm text-danger/90">{storage.error}</p>
        </div>
      )}

      <InvoiceIntake projects={projects} locations={locations} />
    </Page>
  );
}
