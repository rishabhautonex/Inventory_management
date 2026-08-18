import Link from "next/link";

import { db } from "@/db";
import {
  getRequestCounts,
  listRequests,
  visibilityFor,
  type RequestStatus,
} from "@/db/queries/requests";
import { requireUser } from "@/lib/auth";
import { formatRelative } from "@/lib/format";
import { PlusIcon } from "@/components/icons";
import {
  Badge,
  Card,
  EmptyState,
  Page,
  PageHeader,
  TableWrap,
  primaryButtonClass,
  tdClass,
  thClass,
  theadClass,
  trClass,
} from "@/components/ui";
import {
  REQUEST_STATUSES,
  REQUEST_STATUS_LABEL,
  REQUEST_STATUS_TONE,
} from "./request-status";

export const metadata = { title: "Requests · LabStock" };

/**
 * The requests screen is role-aware rather than filtered by choice, per the
 * spec: an engineer sees their own, a head sees the queue for the projects they
 * run, an admin sees everything. `visibilityFor` is the single place that
 * decides which, and every query on this page is scoped through it.
 */
const DESCRIPTION: Record<string, string> = {
  engineer: "Ask for something the cupboard does not have. A project head decides.",
  project_head:
    "Requests for the projects you head, plus your own. Approving one puts it in the admins' buying queue.",
  admin: "Everything asked for across the lab. Approved requests are yours to order.",
  manager: "Everything asked for across the lab.",
};

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const visibility = visibilityFor(user);

  const params = await searchParams;
  const status = REQUEST_STATUSES.includes(params.status as RequestStatus)
    ? (params.status as RequestStatus)
    : undefined;

  const [rows, counts] = await Promise.all([
    listRequests(db, visibility, { status }),
    getRequestCounts(db, visibility),
  ]);

  return (
    <Page>
      <PageHeader
        title="Requests"
        description={DESCRIPTION[user.role]}
        action={
          <Link href="/requests/new" className={primaryButtonClass}>
            <PlusIcon size={16} />
            Ask for a part
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusTab active={!status} href="/requests" label="All" />
        {REQUEST_STATUSES.map((value) => (
          <StatusTab
            key={value}
            active={status === value}
            href={`/requests?status=${value}`}
            label={REQUEST_STATUS_LABEL[value]}
            count={counts[value]}
          />
        ))}
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title={
              status
                ? `Nothing ${REQUEST_STATUS_LABEL[status].toLowerCase()}`
                : "No requests yet"
            }
            description="When a part is not in the cupboard, ask for it here rather than buying round the system. The project head decides, then an admin orders it."
            action={
              <Link href="/requests/new" className={primaryButtonClass}>
                <PlusIcon size={16} />
                Ask for a part
              </Link>
            }
          />
        </Card>
      ) : (
        <TableWrap minWidth={820}>
          <thead className={theadClass}>
            <tr>
              <th className={thClass}>Part</th>
              <th className={thClass}>Project</th>
              <th className={`${thClass} text-right`}>Wanted</th>
              <th className={`${thClass} text-right`}>In cupboard</th>
              <th className={thClass}>Asked by</th>
              <th className={thClass}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={trClass}>
                <td className={tdClass}>
                  <Link
                    href={`/requests/${row.id}`}
                    className="font-medium text-accent-text hover:underline"
                  >
                    {row.label}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted">
                    {row.componentId ? (
                      row.componentMpn ? (
                        <span className="font-mono">{row.componentMpn}</span>
                      ) : (
                        "In the catalogue"
                      )
                    ) : (
                      "Not catalogued yet"
                    )}
                  </p>
                </td>

                <td className={`${tdClass} text-muted`}>{row.projectName}</td>

                <td className={`${tdClass} text-right tabular-nums`}>
                  {row.qty}
                </td>

                <td className={`${tdClass} text-right tabular-nums text-muted`}>
                  {row.inProject === null ? "—" : row.inProject}
                </td>

                <td className={tdClass}>
                  <span className="text-sm">{row.requestedByName}</span>
                  <p className="mt-0.5 text-xs text-muted">
                    {formatRelative(row.createdAt)}
                  </p>
                </td>

                <td className={tdClass}>
                  <Badge tone={REQUEST_STATUS_TONE[row.status]}>
                    {REQUEST_STATUS_LABEL[row.status]}
                  </Badge>
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
  count,
}: {
  href: string;
  label: string;
  active: boolean;
  count?: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`inline-flex min-h-11 items-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors ${
        active
          ? "border border-accent/40 bg-accent-soft text-accent-text"
          : "border border-border text-muted hover:bg-surface-hover hover:text-foreground"
      }`}
    >
      {label}
      {count ? (
        <span className="tabular-nums text-xs opacity-80">{count}</span>
      ) : null}
    </Link>
  );
}
