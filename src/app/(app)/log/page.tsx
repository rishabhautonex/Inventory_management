import Link from "next/link";

import { db } from "@/db";
import {
  getFilterOptions,
  listMovements,
  type LogFilters,
  type MovementReason,
} from "@/db/queries/movements";
import { canUndoMovement, requireUser } from "@/lib/auth";
import {
  Card,
  EmptyState,
  Page,
  PageHeader,
  secondaryButtonClass,
} from "@/components/ui";
import { LogFilterBar } from "./log-filter-bar";
import { MovementRow } from "./movement-row";

export const metadata = { title: "Stock movements · LabStock" };

const REASONS: MovementReason[] = [
  "receipt",
  "issue",
  "return",
  "adjustment",
  "reversal",
];

const PAGE_SIZE = 50;

/** Must match the column template in `MovementRow`'s desktop layout. */
const COLUMNS =
  "md:grid-cols-[minmax(0,1.6fr)_7rem_4.5rem_minmax(0,1.6fr)_8.5rem_6rem]";

function parseDate(value: string | undefined, endOfDay = false): Date | undefined {
  if (!value) return undefined;
  // A date input gives "YYYY-MM-DD" with no zone. Interpret it as a Kolkata
  // day (UTC+5:30) so "today" means the lab's today, not UTC's.
  const stamp = endOfDay ? `${value}T23:59:59.999+05:30` : `${value}T00:00:00+05:30`;
  const parsed = new Date(stamp);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export default async function LogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;

  const page = Math.max(1, Number(params.page ?? 1) || 1);

  const filters: LogFilters = {
    componentId: params.component || undefined,
    userId: params.person || undefined,
    locationId: params.location || undefined,
    projectId: params.project || undefined,
    reason: REASONS.includes(params.reason as MovementReason)
      ? (params.reason as MovementReason)
      : undefined,
    from: parseDate(params.from),
    to: parseDate(params.to, true),
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  };

  const [entries, options] = await Promise.all([
    listMovements(db, filters),
    getFilterOptions(db),
  ]);

  const hasMore = entries.length > PAGE_SIZE;
  const visible = hasMore ? entries.slice(0, PAGE_SIZE) : entries;

  const nextParams = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v) as [string, string][],
  );
  nextParams.set("page", String(page + 1));

  const prevParams = new URLSearchParams(nextParams);
  prevParams.set("page", String(page - 1));

  return (
    <Page>
      <PageHeader
        title="Stock movements"
        description="Every movement, newest first. Nothing here is ever edited or deleted — undo appends a reversal."
      />

      <LogFilterBar
        options={options}
        reasons={REASONS}
        currentUserId={user.id}
      />

      <Card className="mt-4 overflow-hidden">
        {visible.length === 0 ? (
          <EmptyState
            title="No movements match these filters"
            description="Clear a filter, or widen the date range."
          />
        ) : (
          <>
            <div
              aria-hidden
              className={`hidden gap-4 border-b border-border bg-surface-muted/50 px-4 py-3 text-xs font-medium text-muted md:grid ${COLUMNS}`}
            >
              <span>Part</span>
              <span>Type</span>
              <span className="text-right">Qty</span>
              <span>Location</span>
              <span>When</span>
              <span />
            </div>

            <ul className="divide-y divide-border">
              {visible.map((entry) => (
                <MovementRow
                  key={entry.id}
                  entry={entry}
                  canUndo={canUndoMovement(user, entry)}
                />
              ))}
            </ul>
          </>
        )}
      </Card>

      {page > 1 || hasMore ? (
        <div className="mt-4 flex items-center justify-between gap-3">
          {page > 1 ? (
            <Link href={`/log?${prevParams}`} className={secondaryButtonClass}>
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-muted">Page {page}</span>
          {hasMore ? (
            <Link href={`/log?${nextParams}`} className={secondaryButtonClass}>
              Older →
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}
    </Page>
  );
}
