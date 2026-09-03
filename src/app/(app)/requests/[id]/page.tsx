import Link from "next/link";
import { notFound } from "next/navigation";

import { db } from "@/db";
import { getRequest, visibilityFor } from "@/db/queries/requests";
import { listVendors } from "@/db/queries/orders";
import {
  canApproveForProject,
  canManageInventory,
  canViewProject,
  requireUser,
} from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import {
  Badge,
  Card,
  Page,
  PageHeader,
  Panel,
} from "@/components/ui";
import { orderRef } from "../../orders/order-ref";
import { REQUEST_STATUS_LABEL, REQUEST_STATUS_TONE } from "../request-status";
import { DecisionPanel } from "./decision-panel";
import { ConvertPanel } from "./convert-panel";

export const metadata = { title: "Request · LabStock" };

export default async function RequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  // Scoped to what this person may see inside the lookup, so a request for
  // somebody else's project is a 404 rather than a refusal that confirms it
  // exists.
  const request = await getRequest(db, visibilityFor(user), id);
  if (!request) notFound();

  const canDecide =
    request.status === "pending" &&
    canApproveForProject(user, request.projectId);

  const canOrder = request.status === "approved" && canManageInventory(user);
  const vendors = canOrder ? await listVendors(db) : [];

  // The requester can see which project their request belongs to without being
  // able to open the project screens, so the name is only a link when it leads
  // somewhere they are allowed to go.
  const canOpenProject = canViewProject(user, request.projectId);

  return (
    <Page>
      <PageHeader
        title={request.label}
        description={`${request.qty} piece${request.qty === 1 ? "" : "s"} for ${request.projectName}`}
        back={{ href: "/requests", label: "Requests" }}
        action={
          <Badge tone={REQUEST_STATUS_TONE[request.status]}>
            {REQUEST_STATUS_LABEL[request.status]}
          </Badge>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Panel title="What was asked for">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
              <Detail label="Part">
                {request.componentId ? (
                  <Link
                    href={`/parts/${request.componentId}`}
                    className="text-accent-text hover:underline"
                  >
                    {request.componentName}
                  </Link>
                ) : (
                  <span>{request.freeText}</span>
                )}
                {request.componentMpn ? (
                  <span className="mt-0.5 block font-mono text-xs text-muted">
                    {request.componentMpn}
                  </span>
                ) : request.componentId ? null : (
                  <span className="mt-0.5 block text-xs text-warning">
                    Not in the catalogue yet
                  </span>
                )}
              </Detail>

              <Detail label="How many">
                <span className="tabular-nums">{request.qty}</span>
              </Detail>

              <Detail label="Project">
                {canOpenProject ? (
                  <Link
                    href={`/projects/${request.projectId}`}
                    className="text-accent-text hover:underline"
                  >
                    {request.projectName}
                  </Link>
                ) : (
                  request.projectName
                )}
              </Detail>

              <Detail label="Already in that cupboard">
                <span className="tabular-nums">
                  {request.inProject === null ? "—" : request.inProject}
                </span>
              </Detail>

              <Detail label="Asked by">{request.requestedByName}</Detail>

              <Detail label="When">{formatDateTime(request.createdAt)}</Detail>
            </dl>

            {request.reason ? (
              <div className="mt-5 rounded-lg border border-border bg-surface-muted p-3.5">
                <p className="text-xs font-medium text-muted">Why</p>
                <p className="mt-1 text-sm whitespace-pre-wrap">{request.reason}</p>
              </div>
            ) : null}
          </Panel>

          {request.decidedAt ? (
            <Panel title="Decision">
              <p className="text-sm">
                <span className="font-medium">
                  {request.status === "rejected" ? "Turned down" : "Approved"}
                </span>{" "}
                by {request.decidedByName ?? "somebody since removed"} on{" "}
                {formatDateTime(request.decidedAt)}.
              </p>

              {/* Both numbers, because the ask is not overwritten when a head
                  approves fewer — and "4" next to a request for 10 reads as an
                  error unless it says which is which. */}
              {request.approvedQty !== null &&
              request.approvedQty !== request.qty ? (
                <p className="mt-2 text-sm">
                  <Badge tone="warning">
                    {request.approvedQty} of {request.qty} approved
                  </Badge>
                </p>
              ) : null}
              {request.decisionNote ? (
                <div className="mt-3 rounded-lg border border-border bg-surface-muted p-3.5">
                  <p className="text-sm whitespace-pre-wrap">
                    {request.decisionNote}
                  </p>
                </div>
              ) : null}
            </Panel>
          ) : null}

          {request.orderId ? (
            <Panel title="Ordered">
              <p className="text-sm text-muted">
                This became order{" "}
                <Link
                  href={`/orders/${request.orderId}`}
                  className="font-mono font-semibold text-accent-text hover:underline"
                >
                  {orderRef(request.orderId)}
                </Link>
                . It becomes stock when its line is put away, not before.
              </p>
            </Panel>
          ) : null}
        </div>

        <div className="space-y-4">
          {canDecide ? (
            <DecisionPanel
              requestId={request.id}
              askedQty={request.qty}
              label={request.label}
            />
          ) : null}

          {canOrder ? (
            <ConvertPanel
              requestId={request.id}
              // Null for a free-text request: the panel asks which part it
              // turned out to be, and can catalogue it on the spot.
              componentId={request.componentId}
              label={request.label}
              // What the head approved, not what was asked for. Buying the
              // full ask when it was cut down would overrule the decision.
              qty={request.approvedQty ?? request.qty}
              vendors={vendors}
            />
          ) : null}

          {!canDecide && !canOrder && request.status === "pending" ? (
            <Card className="p-4 sm:p-5">
              <p className="text-sm text-muted">
                Waiting on a head of {request.projectName}. You will be told
                either way.
              </p>
            </Card>
          ) : null}
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
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}
