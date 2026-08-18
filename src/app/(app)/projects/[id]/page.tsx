import Link from "next/link";
import { notFound } from "next/navigation";

import { db } from "@/db";
import { getBomShortfall, listProjectBoms } from "@/db/queries/bom";
import { listOrders } from "@/db/queries/orders";
import {
  getProject,
  getProjectAttention,
  getProjectStock,
} from "@/db/queries/projects";
import { listRequests, visibilityFor } from "@/db/queries/requests";
import {
  canEditProjectDetails,
  canManageInventory,
  canManageProjectBom,
  canViewProject,
  requireUser,
} from "@/lib/auth";
import { INR, formatDate, formatRelative } from "@/lib/format";
import {
  AlertIcon,
  CubeIcon,
  ReceiptIcon,
  RequestIcon,
  UploadIcon,
} from "@/components/icons";
import {
  Badge,
  Card,
  EmptyState,
  NoAccess,
  Page,
  PageHeader,
  Panel,
  StatCard,
  TableWrap,
  primaryButtonClass,
  secondaryButtonClass,
  tdClass,
  thClass,
  theadClass,
  trClass,
} from "@/components/ui";
import {
  REQUEST_STATUS_LABEL,
  REQUEST_STATUS_TONE,
} from "../../requests/request-status";
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TONE,
  orderRef,
} from "../../orders/order-ref";
import { ShortfallTable } from "./shortfall-table";
import { BomSwitcher } from "./bom-switcher";
import { ProjectDetailsPanel } from "./details-panel";

export const metadata = { title: "Project · LabStock" };

/**
 * The project page the spec asks for: the cupboard's stock, the BOM shortfall,
 * the requests, and the spend total.
 *
 * Which BOM is showing is a query parameter rather than state, so the switcher
 * produces a shareable link and the page stays a server component.
 */
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ bom?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { bom: requestedBomId } = await searchParams;

  const project = await getProject(db, id);
  if (!project) notFound();

  if (!canViewProject(user, project.id)) {
    return (
      <NoAccess>
        This project is visible to its heads, and to admins and managers.
      </NoAccess>
    );
  }

  const canUploadBom = canManageProjectBom(user, project.id);
  const canOrder = canManageInventory(user);
  const canEditDetails = canEditProjectDetails(user, project.id);

  const [boms, stock, attention, requests, orders] = await Promise.all([
    listProjectBoms(db, project.id),
    getProjectStock(db, project.id),
    getProjectAttention(db, project.id),
    listRequests(db, visibilityFor(user), { projectId: project.id, limit: 20 }),
    // Scoped to this project, so no visibility question arises: anybody who got
    // this far can see the project, and these are its own orders.
    listOrders(db, { projectId: project.id, limit: 10 }),
  ]);

  const empties = attention.filter((line) => line.onHand <= 0).length;

  // Newest by default: a BOM is a record of what was asked for at a point in
  // time, and only the latest can be the current answer to "what are we short".
  const activeBom =
    boms.find((entry) => entry.id === requestedBomId) ?? boms[0] ?? null;
  const shortfall = activeBom ? await getBomShortfall(db, activeBom.id) : null;

  const openRequests = requests.filter(
    (request) => request.status === "pending" || request.status === "approved",
  );

  return (
    <Page>
      <PageHeader
        title={project.name}
        description={`${project.code}${project.status === "closed" ? " · closed" : ""}${
          project.leads.length > 0
            ? ` · headed by ${project.leads.map((lead) => lead.name).join(", ")}`
            : ""
        }`}
        back={{ href: "/projects", label: "Projects" }}
        action={
          canUploadBom ? (
            <Link
              href={`/projects/${project.id}/bom`}
              className={primaryButtonClass}
            >
              <UploadIcon size={16} />
              Upload a BOM
            </Link>
          ) : undefined
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<CubeIcon />}
          tone="accent"
          label="Distinct parts"
          value={project.distinctParts}
          hint={`${project.pieces} pieces in ${project.locationCount} location${project.locationCount === 1 ? "" : "s"}`}
        />
        <StatCard
          icon={<AlertIcon />}
          tone={shortfall && shortfall.totals.shortLines > 0 ? "warning" : "positive"}
          label="Still to buy"
          value={shortfall ? shortfall.totals.shortLines : "—"}
          hint={
            shortfall
              ? `${shortfall.totals.piecesToBuy} pieces across ${shortfall.totals.lines} BOM lines`
              : "No BOM uploaded yet"
          }
        />
        <StatCard
          icon={<ReceiptIcon />}
          tone="positive"
          label="Spend"
          value={project.spend > 0 ? INR.format(project.spend) : "—"}
          hint="Orders raised for this project, cancellations aside"
        />
        <StatCard
          icon={<RequestIcon />}
          tone={project.pendingRequests > 0 ? "warning" : "accent"}
          label="Open requests"
          value={openRequests.length}
          hint={`${project.pendingRequests} waiting, ${project.approvedRequests} to order`}
          href="/requests?status=pending"
        />
      </div>

      <div className="space-y-4">
        <ProjectDetailsPanel
          projectId={project.id}
          description={project.description}
          repoUrl={project.repoUrl}
          canEdit={canEditDetails}
        />

        <Panel
          title="BOM shortfall"
          action={
            boms.length > 1 && activeBom ? (
              <BomSwitcher
                projectId={project.id}
                boms={boms.map((entry) => ({
                  id: entry.id,
                  label: `${entry.name}${entry.version ? ` (${entry.version})` : ""} · ${formatDate(entry.createdAt)}`,
                }))}
                activeId={activeBom.id}
              />
            ) : undefined
          }
        >
          {!shortfall ? (
            <EmptyState
              title="No BOM yet"
              description="Upload the parts list as a CSV, or paste it straight out of a spreadsheet. Each row needs something identifying the part and a quantity."
              action={
                canUploadBom ? (
                  <Link
                    href={`/projects/${project.id}/bom`}
                    className={primaryButtonClass}
                  >
                    <UploadIcon size={16} />
                    Upload a BOM
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <>
              <p className="mb-4 text-sm text-muted">
                <span className="font-medium text-foreground">
                  {shortfall.name}
                  {shortfall.version ? ` (${shortfall.version})` : ""}
                </span>{" "}
                · uploaded {formatRelative(shortfall.createdAt)}
                {shortfall.uploadedByName ? ` by ${shortfall.uploadedByName}` : ""}
                . Compared against this project&apos;s own cupboards only —
                another project&apos;s stock is not an answer.
              </p>

              <ShortfallTable
                bomId={shortfall.id}
                lines={shortfall.lines}
                canOrder={canOrder}
              />
            </>
          )}
        </Panel>

        <Panel
          eyebrow="Against the minimums set on these shelves"
          title="Needs attention"
          action={
            attention.length > 0 ? (
              <div className="flex items-center gap-2">
                {empties > 0 ? <Badge tone="danger">{empties} empty</Badge> : null}
                {attention.length - empties > 0 ? (
                  <Badge tone="warning">{attention.length - empties} low</Badge>
                ) : null}
              </div>
            ) : undefined
          }
        >
          {attention.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              Nothing on this project&apos;s shelves is at or below its minimum.
              Only shelves with a minimum set are watched.
            </p>
          ) : (
            <TableWrap minWidth={620}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>Part</th>
                  <th className={thClass}>Where</th>
                  <th className={`${thClass} text-right`}>On hand</th>
                  <th className={`${thClass} text-right`}>Minimum</th>
                </tr>
              </thead>
              <tbody>
                {attention.map((line) => (
                  <tr
                    key={`${line.componentId}-${line.locationId}`}
                    className={trClass}
                  >
                    <td className={tdClass}>
                      <Link
                        href={`/parts/${line.componentId}`}
                        className="font-medium text-accent-text hover:underline"
                      >
                        {line.componentName}
                      </Link>
                      {line.componentMpn ? (
                        <p className="mt-0.5 font-mono text-xs text-muted">
                          {line.componentMpn}
                        </p>
                      ) : null}
                    </td>
                    <td className={`${tdClass} text-muted`}>
                      {line.locationPath}
                    </td>
                    <td className={`${tdClass} text-right`}>
                      <span
                        className={`readout font-semibold ${
                          line.onHand <= 0 ? "text-danger" : "text-warning"
                        }`}
                      >
                        {line.onHand}
                      </span>
                    </td>
                    <td
                      className={`${tdClass} text-right tabular-nums text-muted`}
                    >
                      {line.minQty}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Panel>

        <Panel
          title="Requests"
          action={
            <Link
              href="/requests"
              className="text-sm font-medium text-accent-text hover:underline"
            >
              All requests
            </Link>
          }
        >
          {requests.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              Nothing has been asked for on this project.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {requests.slice(0, 8).map((request) => (
                <li
                  key={request.id}
                  className="flex flex-wrap items-center gap-3 py-3 first:pt-0"
                >
                  <Link
                    href={`/requests/${request.id}`}
                    className="min-w-0 flex-1 text-sm font-medium text-accent-text hover:underline"
                  >
                    {request.qty} × {request.label}
                  </Link>
                  <span className="text-xs text-muted">
                    {request.requestedByName} · {formatRelative(request.createdAt)}
                  </span>
                  <Badge tone={REQUEST_STATUS_TONE[request.status]}>
                    {REQUEST_STATUS_LABEL[request.status]}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="In the cupboard">
          {stock.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              Nothing on this project&apos;s shelves yet.
            </p>
          ) : (
            <TableWrap minWidth={620}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>Part</th>
                  <th className={thClass}>Where</th>
                  <th className={`${thClass} text-right`}>On hand</th>
                </tr>
              </thead>
              <tbody>
                {stock.map((line) => (
                  <tr
                    key={`${line.componentId}-${line.locationId}`}
                    className={trClass}
                  >
                    <td className={tdClass}>
                      <Link
                        href={`/parts/${line.componentId}`}
                        className="font-medium text-accent-text hover:underline"
                      >
                        {line.componentName}
                      </Link>
                      {line.componentMpn ? (
                        <p className="mt-0.5 font-mono text-xs text-muted">
                          {line.componentMpn}
                        </p>
                      ) : null}
                    </td>
                    <td className={`${tdClass} text-muted`}>
                      {line.locationPath}
                    </td>
                    <td className={`${tdClass} text-right tabular-nums`}>
                      {line.minQty !== null && line.onHand <= line.minQty ? (
                        <span className="font-semibold text-warning">
                          {line.onHand}
                        </span>
                      ) : (
                        line.onHand
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Panel>

        <Panel
          eyebrow="What the spend went on"
          title="Orders for this project"
          action={
            orders.length > 0 ? (
              <Link
                href="/orders"
                className="text-sm font-medium text-accent-text hover:underline"
              >
                All orders
              </Link>
            ) : undefined
          }
        >
          {orders.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              Nothing has been bought for this project yet. An order is an
              intention — it becomes stock only when a line is put away.
            </p>
          ) : (
            <TableWrap minWidth={680}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>Order</th>
                  <th className={thClass}>Vendor</th>
                  <th className={thClass}>Expected</th>
                  <th className={`${thClass} text-right`}>Amount</th>
                  <th className={thClass}>Put away</th>
                  <th className={thClass}>Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className={trClass}>
                    <td className={tdClass}>
                      <Link
                        href={`/orders/${order.id}`}
                        className="font-mono text-xs font-semibold text-accent-text hover:underline"
                      >
                        {orderRef(order.id)}
                      </Link>
                    </td>
                    <td className={tdClass}>{order.vendorName ?? "—"}</td>
                    <td className={tdClass}>
                      {order.expectedDate ? (
                        <span
                          className={
                            order.isOverdue ? "text-danger" : "text-muted"
                          }
                        >
                          {formatDate(order.expectedDate)}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className={`${tdClass} text-right tabular-nums`}>
                      {order.totalAmount === null
                        ? "—"
                        : INR.format(order.totalAmount)}
                    </td>
                    <td className={`${tdClass} tabular-nums text-muted`}>
                      {order.shelvedLineCount}/{order.lineCount}
                    </td>
                    <td className={tdClass}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={ORDER_STATUS_TONE[order.status]}>
                          {ORDER_STATUS_LABEL[order.status]}
                        </Badge>
                        {order.isOverdue ? (
                          <Badge tone="danger">Overdue</Badge>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Panel>

        {boms.length > 0 && canUploadBom ? (
          <Card className="p-4 sm:p-5">
            <p className="text-sm text-muted">
              {boms.length} BOM{boms.length === 1 ? "" : "s"} uploaded. A new
              upload does not replace the old one — the newest is what this page
              measures against.
            </p>
            <Link
              href={`/projects/${project.id}/bom`}
              className={`${secondaryButtonClass} mt-4`}
            >
              <UploadIcon size={16} />
              Upload another
            </Link>
          </Card>
        ) : null}
      </div>
    </Page>
  );
}
