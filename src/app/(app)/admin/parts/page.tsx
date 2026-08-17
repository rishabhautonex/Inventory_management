import Link from "next/link";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { runQuery } from "@/db/rows";
import { canManageInventory, requireUser } from "@/lib/auth";
import { PackageIcon, PencilIcon, PlusIcon } from "@/components/icons";
import {
  Badge,
  Card,
  EmptyState,
  IconChip,
  NoAccess,
  Page,
  PageHeader,
  TableWrap,
  primaryButtonClass,
  tdClass,
  thClass,
  theadClass,
  trClass,
} from "@/components/ui";

export const metadata = { title: "All parts · LabStock" };

export default async function AdminPartsPage() {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return <NoAccess>Only admins and managers can manage parts.</NoAccess>;
  }

  const parts = await runQuery<{
    id: string;
    name: string;
    mpn: string | null;
    category: string | null;
    has_terms: boolean;
    total: number | string;
    locations: number | string;
  }>(
    db,
    sql`
      SELECT
        c.id,
        c.name,
        c.mpn,
        c.category,
        (c.search_terms IS NOT NULL AND c.search_terms <> '') AS has_terms,
        COALESCE((
          SELECT SUM(on_hand) FROM stock_on_hand s WHERE s.component_id = c.id
        ), 0) AS total,
        COALESCE((
          SELECT count(*) FROM stock_on_hand s
          WHERE s.component_id = c.id AND s.on_hand > 0
        ), 0) AS locations
      FROM components c
      ORDER BY c.name
      LIMIT 500
    `,
  );

  return (
    <Page>
      <PageHeader
        title="All parts"
        description="The catalogue. Quantities live in the ledger, not here."
        back={{ href: "/admin", label: "Admin" }}
        action={
          <Link href="/admin/parts/new" className={primaryButtonClass}>
            <PlusIcon size={16} />
            Add part
          </Link>
        }
      />

      {parts.length === 0 ? (
        <Card>
          <EmptyState
            title="No parts catalogued yet"
            description="Add the first one, and fill in its search keywords generously — that is what makes it findable."
            action={
              <Link href="/admin/parts/new" className={primaryButtonClass}>
                <PlusIcon size={16} />
                Add part
              </Link>
            }
          />
        </Card>
      ) : (
        <TableWrap minWidth={760}>
          <thead className={theadClass}>
            <tr>
              <th className={thClass}>Part</th>
              <th className={thClass}>MPN</th>
              <th className={thClass}>Category</th>
              <th className={`${thClass} text-right`}>On hand</th>
              <th className={thClass}>Keywords</th>
              <th className={`${thClass} text-right`}>Edit</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((part) => {
              const total = Number(part.total);
              const places = Number(part.locations);

              return (
                <tr key={part.id} className={trClass}>
                  <td className={tdClass}>
                    <div className="flex items-center gap-3">
                      <IconChip tone="accent">
                        <PackageIcon size={18} />
                      </IconChip>
                      <Link
                        href={`/parts/${part.id}`}
                        className="min-w-0 font-medium hover:underline"
                      >
                        {part.name}
                      </Link>
                    </div>
                  </td>

                  <td className={`${tdClass} font-mono text-xs text-muted`}>
                    {part.mpn ?? "—"}
                  </td>

                  <td className={`${tdClass} text-muted`}>
                    {part.category ?? "—"}
                  </td>

                  <td className={`${tdClass} text-right`}>
                    <span
                      className={`font-semibold tabular-nums ${
                        total <= 0 ? "text-muted" : ""
                      }`}
                    >
                      {total}
                    </span>
                    {places > 1 ? (
                      <span className="ml-1 text-xs text-muted">
                        in {places}
                      </span>
                    ) : null}
                  </td>

                  <td className={tdClass}>
                    {part.has_terms ? (
                      <Badge tone="positive">Set</Badge>
                    ) : (
                      <Badge tone="warning">Missing</Badge>
                    )}
                  </td>

                  <td className={`${tdClass} text-right`}>
                    <Link
                      href={`/admin/parts/${part.id}`}
                      aria-label={`Edit ${part.name}`}
                      className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-accent-text transition-colors hover:bg-surface-hover"
                    >
                      <PencilIcon size={18} />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
    </Page>
  );
}
