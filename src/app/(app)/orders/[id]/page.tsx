import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { runQuery } from "@/db/rows";
import { getOrder } from "@/db/queries/orders";
import { canManageInventory, canViewOrder, requireUser } from "@/lib/auth";
import { checkInvoiceStorageConfig } from "@/lib/storage";
import { formatDate, formatDateTime } from "@/lib/format";
import { ExternalLinkIcon } from "@/components/icons";
import {
  Badge,
  Card,
  NoAccess,
  Page,
  PageHeader,
  ProgressBar,
  TableWrap,
  tdClass,
  thClass,
  theadClass,
  trClass,
} from "@/components/ui";
import { ORDER_STATUS_LABEL, ORDER_STATUS_TONE, orderRef } from "../order-ref";
import { InvoicePanel } from "./invoice-panel";
import { ShelvePanel } from "./shelve-panel";
import { StatusActions } from "./status-actions";

/**
 * The invoice panel uploads and OCRs a bill through server actions, which run
 * under this route. A multi-page scan takes minutes, so the default function
 * timeout would cut it off. Cap it to whatever the host plan actually allows.
 */
export const maxDuration = 300;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return { title: `Order ${orderRef(id)} · LabStock` };
}

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const canBuy = canManageInventory(user);

  const { id } = await params;

  const [order, locations] = await Promise.all([
    getOrder(db, id),
    // Only the shelving panel needs these, and only an admin sees it.
    canBuy
      ? runQuery<{ id: string; path: string }>(
          db,
          sql`SELECT id, path FROM location_tree WHERE is_active ORDER BY path`,
        )
      : Promise.resolve([]),
  ]);

  if (!order) notFound();

  /**
   * Checked after the row is read because the answer depends on which project
   * the order is for: a head may open their own project's orders and nobody
   * else's. Every write on this page stays behind `canBuy`.
   */
  if (!canViewOrder(user, order.projectId)) {
    return (
      <NoAccess>
        This order is visible to admins, managers, and the heads of the project
        it was bought for.
      </NoAccess>
    );
  }

  const storage = checkInvoiceStorageConfig();

  const lineSum = order.lines.reduce(
    (sum, line) => sum + line.qty * (line.unitPrice ?? 0),
    0,
  );

  return (
    <Page>
      <PageHeader
        title={`Order ${orderRef(order.id)}`}
        description={[
          order.vendorName ?? "No vendor recorded",
          order.projectName ?? "General shelf",
          order.channel === "offline" ? "bought in person" : "ordered online",
        ].join(" · ")}
        back={{ href: "/orders", label: "Orders" }}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={ORDER_STATUS_TONE[order.status]}>
              {ORDER_STATUS_LABEL[order.status]}
            </Badge>
            {order.isOverdue ? <Badge tone="danger">Overdue</Badge> : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card className="overflow-hidden">
            <div className="px-4 py-4 sm:px-5">
              <h2 className="text-base font-semibold">Lines</h2>
              <p className="mt-1 text-sm text-muted">
                Quantities here are what was ordered. On-hand comes from the
                ledger, and only the receipts below feed it.
              </p>
            </div>

            <TableWrap minWidth={620}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>Part</th>
                  <th className={`${thClass} text-right`}>Ordered</th>
                  <th className={`${thClass} text-right`}>Unit price</th>
                  <th className={thClass}>Put away</th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((line) => (
                  <tr key={line.id} className={trClass}>
                    <td className={tdClass}>
                      <Link
                        href={`/parts/${line.componentId}`}
                        className="font-medium hover:underline"
                      >
                        {line.componentName}
                      </Link>
                      {line.mpn ? (
                        <p className="font-mono text-xs text-muted">{line.mpn}</p>
                      ) : null}
                    </td>

                    <td className={`${tdClass} text-right tabular-nums`}>
                      {line.qty}
                    </td>

                    <td className={`${tdClass} text-right tabular-nums text-muted`}>
                      {line.unitPrice === null
                        ? "—"
                        : `₹${line.unitPrice.toLocaleString("en-IN")}`}
                    </td>

                    <td className={`${tdClass} min-w-40`}>
                      <div className="flex items-center gap-2">
                        <span className="tabular-nums text-sm">
                          {line.shelvedQty}/{line.qty}
                        </span>
                        {line.remainingQty === 0 ? (
                          <Badge tone="positive">Done</Badge>
                        ) : null}
                      </div>
                      <div className="mt-1.5">
                        <ProgressBar
                          value={line.shelvedQty}
                          max={line.qty}
                          tone={line.remainingQty === 0 ? "positive" : "accent"}
                          label={`${line.componentName} put away`}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>

            {lineSum > 0 ? (
              <div className="flex flex-wrap justify-end gap-x-8 gap-y-1 border-t border-border px-4 py-4 text-sm sm:px-5">
                <span className="text-muted">Lines add up to</span>
                <span className="font-semibold tabular-nums">
                  ₹{lineSum.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                </span>
                {order.totalAmount !== null &&
                Math.abs(order.totalAmount - lineSum) > 0.01 ? (
                  <p className="w-full text-right text-xs text-muted">
                    The invoice total is ₹
                    {order.totalAmount.toLocaleString("en-IN")} — the difference is
                    normally shipping and tax.
                  </p>
                ) : null}
              </div>
            ) : null}
          </Card>

          {canBuy ? <ShelvePanel order={order} locations={locations} /> : null}
        </div>

        <div className="space-y-4">
          <Card className="p-4 sm:p-5">
            <h2 className="text-base font-semibold">Details</h2>

            <dl className="mt-4 space-y-3 text-sm">
              <Detail label="Ordered">
                {order.orderDate ? formatDate(order.orderDate) : "—"}
              </Detail>
              <Detail label="Expected">
                {order.expectedDate ? (
                  <span className={order.isOverdue ? "text-danger" : undefined}>
                    {formatDate(order.expectedDate)}
                  </span>
                ) : (
                  "—"
                )}
              </Detail>
              <Detail label="Delivered">
                {order.deliveredAt ? formatDateTime(order.deliveredAt) : "—"}
              </Detail>
              <Detail label="Put away">
                {order.shelvedAt ? formatDateTime(order.shelvedAt) : "—"}
              </Detail>
              <Detail label="Invoice total">
                {order.totalAmount === null
                  ? "—"
                  : `₹${order.totalAmount.toLocaleString("en-IN")}`}
              </Detail>
              <Detail label="Recorded by">{order.createdByName ?? "—"}</Detail>

              {order.trackingNumber || order.trackingUrl ? (
                <Detail label="Tracking">
                  {order.trackingUrl ? (
                    <a
                      href={order.trackingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-accent-text hover:underline"
                    >
                      {order.trackingNumber ?? "Track"}
                      <ExternalLinkIcon size={14} />
                    </a>
                  ) : (
                    <span className="font-mono text-xs">
                      {order.trackingNumber}
                    </span>
                  )}
                </Detail>
              ) : null}

              {order.vendorWebsite ? (
                <Detail label="Vendor">
                  <a
                    href={order.vendorWebsite}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-accent-text hover:underline"
                  >
                    {order.vendorName}
                    <ExternalLinkIcon size={14} />
                  </a>
                </Detail>
              ) : null}
            </dl>

            {canBuy ? (
              <div className="mt-5">
                <StatusActions orderId={order.id} status={order.status} />
              </div>
            ) : null}
          </Card>

          <InvoicePanel
            orderId={order.id}
            hasInvoice={order.invoiceFileUrl !== null}
            invoiceMime={order.invoiceMime}
            ocrText={order.invoiceOcrText}
            storageProblem={storage.ok ? null : storage.error}
            readOnly={!canBuy}
          />
        </div>
      </div>
    </Page>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
