import Link from "next/link";

import { db } from "@/db";
import {
  getOrderCounts,
  listOrders,
  searchInvoices,
  type InvoiceMatch,
  type OrderScope,
  type OrderStatus,
} from "@/db/queries/orders";
import { canManageInventory, requireUser } from "@/lib/auth";
import { INR, formatDate } from "@/lib/format";
import { PlusIcon, SearchIcon, UploadIcon } from "@/components/icons";
import {
  Badge,
  Card,
  EmptyState,
  NoAccess,
  Page,
  PageHeader,
  Panel,
  TableWrap,
  ghostButtonClass,
  inputClass,
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
  searchParams: Promise<{ status?: string; invoice?: string }>;
}) {
  const user = await requireUser();
  const canBuy = canManageInventory(user);

  /**
   * A project head reads this screen scoped to the projects they lead, and
   * cannot raise or receive anything. They are accountable for that spend and
   * are on the recipient list for its overdue alerts, so hiding it entirely
   * would be hiding their own orders from them.
   */
  const scope: OrderScope = canBuy ? null : { projectIds: user.leadProjectIds };
  if (!canBuy && user.leadProjectIds.length === 0) {
    return <NoAccess>Only admins and managers can see purchasing.</NoAccess>;
  }

  const params = await searchParams;
  const status = STATUSES.includes(params.status as OrderStatus)
    ? (params.status as OrderStatus)
    : undefined;

  /**
   * Searching the invoices is a different question from filtering the list —
   * "which bill mentions this?" rather than "what is outstanding?" — so it
   * answers on its own and the status tabs step aside while it does.
   */
  const invoiceQuery = (params.invoice ?? "").trim();

  const [rows, counts, invoiceMatches] = await Promise.all([
    listOrders(db, { status, scope }),
    getOrderCounts(db, scope),
    invoiceQuery === ""
      ? Promise.resolve([])
      : searchInvoices(db, invoiceQuery, { scope }),
  ]);

  return (
    <Page>
      <PageHeader
        title="Orders"
        description={
          canBuy
            ? "Parts coming in. Stock is only recorded when a line is put away, never when it is ordered."
            : "Parts coming in for the projects you head. Stock is only recorded when a line is put away, never when it is ordered."
        }
        action={
          canBuy ? (
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
          ) : undefined
        }
      />

      <InvoiceSearch query={invoiceQuery} />

      {invoiceQuery !== "" ? (
        <InvoiceResults query={invoiceQuery} matches={invoiceMatches} />
      ) : null}

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
            description={
              canBuy
                ? "Record a purchase here, then put its lines away when the box arrives — that is what writes the stock."
                : "Nothing has been bought for your projects yet. An admin raises the order; it shows up here as soon as they do."
            }
            action={
              canBuy ? (
                <Link href="/orders/from-invoice" className={primaryButtonClass}>
                  <UploadIcon size={16} />
                  Start from an invoice
                </Link>
              ) : undefined
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

/**
 * Search the text read off the invoices.
 *
 * A plain GET form rather than a client component: the answer is a page of
 * server-rendered rows either way, and this keeps the result shareable as a URL
 * and working with no JavaScript. `defaultValue` rather than `value` because
 * nothing here is controlled — the input is the query, the URL is the state.
 */
function InvoiceSearch({ query }: { query: string }) {
  return (
    <form method="get" action="/orders" className="mb-4 flex flex-wrap gap-2">
      <div className="relative min-w-0 flex-1">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
          <SearchIcon size={16} />
        </span>
        <input
          type="search"
          name="invoice"
          defaultValue={query}
          placeholder="Search inside invoices — a part number, a docket, a vendor reference"
          aria-label="Search invoice text"
          className={`${inputClass} pl-9`}
        />
      </div>
      <button type="submit" className={secondaryButtonClass}>
        Search
      </button>
      {query !== "" ? (
        <Link href="/orders" className={ghostButtonClass}>
          Clear
        </Link>
      ) : null}
    </form>
  );
}

/**
 * What the OCR text is for.
 *
 * Only orders whose invoice was actually read can match, so an empty result is
 * reported as "no invoice text mentions this" rather than "no orders" — the
 * difference matters when the bill is a photo the extractor could not read, and
 * saying the wrong one sends somebody looking for an order that does exist.
 */
function InvoiceResults({
  query,
  matches,
}: {
  query: string;
  matches: InvoiceMatch[];
}) {
  return (
    <Panel
      className="mb-6"
      title={`Invoice text matching “${query}”`}
      action={
        matches.length === 0 ? undefined : (
          <span className="text-xs text-muted">
            {matches.length} {matches.length === 1 ? "invoice" : "invoices"}
          </span>
        )
      }
    >
      {matches.length === 0 ? (
        <EmptyState
          title="No stored invoice text mentions that"
          description="Only invoices the extractor could read are searchable. A photo that came back blank is still attached to its order — open the order to look at it."
        />
      ) : (
        <ul className="divide-y divide-border">
          {matches.map((match) => (
            <li key={match.orderId}>
              <Link
                href={`/orders/${match.orderId}`}
                className="block px-1 py-3 transition-colors hover:bg-surface-hover"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-accent-text">
                    {orderRef(match.orderId)}
                  </span>
                  <Badge tone={ORDER_STATUS_TONE[match.status]}>
                    {ORDER_STATUS_LABEL[match.status]}
                  </Badge>
                  <span className="text-sm">{match.vendorName ?? "No vendor"}</span>
                  <span className="text-xs text-muted">
                    {match.projectName ?? "General"}
                    {match.orderDate ? ` · ${formatDate(match.orderDate)}` : ""}
                    {match.totalAmount === null
                      ? ""
                      : ` · ${INR.format(match.totalAmount)}`}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted">
                  …{match.snippet}…
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
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
          ? "border border-accent/40 bg-accent-soft text-accent-text"
          : "border border-border text-muted hover:bg-surface-hover hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );
}
