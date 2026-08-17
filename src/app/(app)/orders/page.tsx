import Link from "next/link";

import { db } from "@/db";
import {
  getOrderCounts,
  listOrders,
  type OrderStatus,
} from "@/db/queries/orders";
import { canManageInventory, requireUser } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { PlusIcon, UploadIcon } from "@/components/icons";
import {
  Badge,
  Card,
  EmptyState,
  NoAccess,
  Page,
  PageHeader,
  TableWrap,
  primaryButtonClass,
  secondaryButtonClass,
  tdClass,
  thClass,
  theadClass,
  trClass,
} from "@/components/ui";
import { orderRef, ORDER_STATUS_TONE, ORDER_STATUS_LABEL } from "./order-ref";

export const metadata = { title: "Orders · LabStock" };

const STATUSES: OrderStatus[] = [
  "ordered",
  "shipped",
  "delivered",
  "shelved",
  "cancelled",
];

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return <NoAccess>Only admins and managers can see purchasing.</NoAccess>;
  }

  const params = await searchParams;
  const status = STATUSES.includes(params.status as OrderStatus)
    ? (params.status as OrderStatus)
    : undefined;

  const [rows, counts] = await Promise.all([
    listOrders(db, { status }),
    getOrderCounts(db),
  ]);

  return (
    <Page>
      <PageHeader
        title="Orders"
        description="Parts coming in. Stock is only recorded when a line is put away, never when it is ordered."
        action={
          <div className="flex flex-wrap gap-3">
            <Link href="/orders/from-invoice" className={primaryButtonClass}>
              <UploadIcon size={16} />
              From an invoice
            </Link>
            <Link href="/orders/new" className={secondaryButtonClass}>
              <PlusIcon size={16} />
              By hand
            </Link>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusTab active={!status} href="/orders" label="All" />
        {STATUSES.map((value) => (
          <StatusTab
            key={value}
            active={status === value}
            href={`/orders?status=${value}`}
            label={ORDER_STATUS_LABEL[value]}
          />
        ))}

        {counts.overdue > 0 ? (
          <span className="ml-auto text-sm text-danger">
            {counts.overdue} overdue
          </span>
        ) : counts.awaitingShelving > 0 ? (
          <span className="ml-auto text-sm text-warning">
            {counts.awaitingShelving} waiting to be put away
          </span>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title={status ? `No ${ORDER_STATUS_LABEL[status]} orders` : "No orders yet"}
            description="Record a purchase here, then put its lines away when the box arrives — that is what writes the stock."
            action={
              <Link href="/orders/from-invoice" className={primaryButtonClass}>
                <UploadIcon size={16} />
                Start from an invoice
              </Link>
            }
          />
        </Card>
      ) : (
        <TableWrap minWidth={860}>
          <thead className={theadClass}>
            <tr>
              <th className={thClass}>Order</th>
              <th className={thClass}>Vendor</th>
              <th className={thClass}>Project</th>
              <th className={thClass}>Expected</th>
              <th className={`${thClass} text-right`}>Amount</th>
              <th className={thClass}>Put away</th>
              <th className={thClass}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((order) => (
              <tr key={order.id} className={trClass}>
                <td className={tdClass}>
                  <Link
                    href={`/orders/${order.id}`}
                    className="font-mono text-xs font-semibold text-accent-text hover:underline"
                  >
                    {orderRef(order.id)}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted">
                    {order.channel === "offline" ? "Bought in person" : "Online"}
                  </p>
                </td>

                <td className={tdClass}>{order.vendorName ?? "—"}</td>

                <td className={`${tdClass} text-muted`}>
                  {order.projectName ?? "General"}
                </td>

                <td className={tdClass}>
                  {order.expectedDate ? (
                    <span className={order.isOverdue ? "text-danger" : "text-muted"}>
                      {formatDate(order.expectedDate)}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>

                <td className={`${tdClass} text-right tabular-nums`}>
                  {order.totalAmount === null
                    ? "—"
                    : `₹${order.totalAmount.toLocaleString("en-IN")}`}
                </td>

                <td className={`${tdClass} tabular-nums text-muted`}>
                  {order.shelvedLineCount}/{order.lineCount}
                </td>

                <td className={tdClass}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={ORDER_STATUS_TONE[order.status]}>
                      {ORDER_STATUS_LABEL[order.status]}
                    </Badge>
                    {order.isOverdue ? <Badge tone="danger">Overdue</Badge> : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </Page>
  );
}

function StatusTab({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`inline-flex min-h-11 items-center rounded-lg px-3.5 text-sm font-medium transition-colors ${
        active
          ? "bg-accent text-accent-foreground"
          : "border border-border text-muted hover:bg-surface-hover hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );
}
