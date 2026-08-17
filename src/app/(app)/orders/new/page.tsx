import { sql } from "drizzle-orm";

import { db } from "@/db";
import { runQuery } from "@/db/rows";
import { listVendors } from "@/db/queries/orders";
import { canManageInventory, requireUser } from "@/lib/auth";
import { NoAccess, Page, PageHeader } from "@/components/ui";
import { OrderForm } from "./order-form";

export const metadata = { title: "New order · LabStock" };

export default async function NewOrderPage() {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return <NoAccess>Only admins and managers can record orders.</NoAccess>;
  }

  const [projects, vendors] = await Promise.all([
    runQuery<{ id: string; name: string }>(
      db,
      sql`SELECT id, name FROM projects WHERE status = 'active' ORDER BY name`,
    ),
    listVendors(db),
  ]);

  return (
    <Page>
      <PageHeader
        title="New order"
        description="Record what was bought. The invoice can be attached afterwards."
        back={{ href: "/orders", label: "Orders" }}
      />
      <OrderForm projects={projects} vendors={vendors} />
    </Page>
  );
}
