import Link from "next/link";

import { db } from "@/db";
import { getDashboardSummary, listLowStock } from "@/db/queries/dashboard";
import { listMovements } from "@/db/queries/movements";
import { getOrderCounts } from "@/db/queries/orders";
import { canManageInventory, requireUser } from "@/lib/auth";
import { formatDelta, formatReason, formatRelative } from "@/lib/format";
import {
  AlertIcon,
  CubeIcon,
  MovementsIcon,
  PackageIcon,
  ReceiptIcon,
} from "@/components/icons";
import {
  Badge,
  EmptyState,
  Page,
  PageHeader,
  Panel,
  ProgressBar,
  StatCard,
  type Tone,
} from "@/components/ui";

export const metadata = { title: "Dashboard · LabStock" };

const RECENT_LIMIT = 6;
const LOW_STOCK_LIMIT = 5;

/** Badge colour per movement reason, so the log reads at a glance. */
const REASON_TONE: Record<string, Tone> = {
  receipt: "positive",
  return: "positive",
  issue: "accent",
  adjustment: "warning",
  reversal: "neutral",
};

export default async function DashboardPage() {
  const user = await requireUser();

  const showOrders = canManageInventory(user);

  const [summary, recent, lowStock, orderCounts] = await Promise.all([
    getDashboardSummary(db),
    listMovements(db, { limit: RECENT_LIMIT }),
    listLowStock(db, LOW_STOCK_LIMIT),
    showOrders ? getOrderCounts(db) : Promise.resolve(null),
  ]);

  const firstName = user.name.split(/\s+/)[0];

  // Only shown when yesterday had movements to compare against — a percentage
  // measured from zero is not a percentage.
  const movementTrend =
    summary.movementsYesterday > 0
      ? (() => {
          const change =
            ((summary.movementsToday - summary.movementsYesterday) /
              summary.movementsYesterday) *
            100;
          return {
            direction: change >= 0 ? ("up" as const) : ("down" as const),
            label: `${change >= 0 ? "+" : ""}${Math.round(change)}%`,
          };
        })()
      : undefined;

  return (
    <Page>
      <PageHeader
        title="Dashboard"
        description={`Welcome back, ${firstName}. Here is where the lab's stock stands today.`}
      />

      <div
        className={`grid gap-4 sm:grid-cols-2 ${
          orderCounts ? "xl:grid-cols-5" : "xl:grid-cols-4"
        }`}
      >
        <StatCard
          icon={<PackageIcon />}
          tone="accent"
          label="Parts catalogued"
          value={summary.parts.toLocaleString("en-IN")}
          trend={
            summary.partsAddedThisWeek > 0
              ? { direction: "up", label: `+${summary.partsAddedThisWeek}` }
              : undefined
          }
          hint="Distinct components in the catalogue"
        />

        <StatCard
          icon={<CubeIcon />}
          tone="positive"
          label="Units on hand"
          value={summary.unitsOnHand.toLocaleString("en-IN")}
          trend={
            summary.unitsDeltaThisWeek !== 0
              ? {
                  direction: summary.unitsDeltaThisWeek > 0 ? "up" : "down",
                  label: formatDelta(summary.unitsDeltaThisWeek),
                }
              : undefined
          }
          hint="Summed from the ledger, across every location"
        />

        <StatCard
          icon={<AlertIcon />}
          tone={summary.lowStockLines > 0 ? "warning" : "positive"}
          label="Below minimum"
          value={summary.lowStockLines}
          hint={
            summary.lowStockLines > 0
              ? "Part-and-cupboard pairs needing a reorder"
              : "Everything with a minimum set is above it"
          }
        />

        <StatCard
          icon={<MovementsIcon />}
          tone="accent"
          label="Movements today"
          value={summary.movementsToday}
          trend={movementTrend}
          hint={`${summary.activeLocations} locations · ${summary.activeProjects} active projects`}
          href="/log"
        />

        {orderCounts ? (
          <StatCard
            icon={<ReceiptIcon />}
            tone={
              orderCounts.overdue > 0
                ? "danger"
                : orderCounts.awaitingShelving > 0
                  ? "warning"
                  : "accent"
            }
            label="Open orders"
            value={orderCounts.open}
            hint={
              orderCounts.overdue > 0
                ? `${orderCounts.overdue} past their expected date`
                : orderCounts.awaitingShelving > 0
                  ? `${orderCounts.awaitingShelving} delivered, waiting to be put away`
                  : "Nothing overdue"
            }
            href="/orders"
          />
        ) : null}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel
            title="Recent activity"
            action={
              <Link
                href="/log"
                className="text-sm font-semibold text-accent-text hover:underline"
              >
                View all
              </Link>
            }
          >
            {recent.length === 0 ? (
              <EmptyState
                title="Nothing has moved yet"
                description="Once someone takes a part out or puts one back, it shows up here and in the log."
              />
            ) : (
              <ul className="space-y-2">
                {recent.map((entry) => {
                  const undone = entry.isReversed;

                  return (
                    <li
                      key={entry.id}
                      className="rounded-lg border border-border bg-surface-muted/60 px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <p
                          className={`min-w-0 truncate text-sm font-medium ${
                            undone ? "line-through opacity-60" : ""
                          }`}
                        >
                          <Link
                            href={`/parts/${entry.componentId}`}
                            className="text-accent-text hover:underline"
                          >
                            {entry.componentName}
                          </Link>
                        </p>

                        <span
                          className={`shrink-0 text-sm font-semibold tabular-nums ${
                            undone
                              ? "text-muted line-through"
                              : entry.qtyDelta > 0
                                ? "text-positive"
                                : "text-foreground"
                          }`}
                        >
                          {formatDelta(entry.qtyDelta)}
                        </span>
                      </div>

                      <div className="mt-1.5 flex items-end justify-between gap-3">
                        <p className="min-w-0 truncate text-xs text-muted">
                          {entry.locationPath}
                          {entry.userName ? (
                            <>
                              <span className="mx-1.5 opacity-50">·</span>
                              {entry.userName}
                            </>
                          ) : null}
                        </p>

                        <div className="flex shrink-0 items-center gap-2">
                          <Badge tone={REASON_TONE[entry.reason] ?? "neutral"}>
                            {formatReason(entry.reason)}
                          </Badge>
                          <span className="whitespace-nowrap text-xs text-muted">
                            {formatRelative(entry.createdAt)}
                          </span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        <Panel
          title="Low stock"
          action={
            summary.lowStockLines > 0 ? (
              <Badge tone="warning">{summary.lowStockLines}</Badge>
            ) : null
          }
        >
          {lowStock.length === 0 ? (
            <EmptyState
              title="Nothing is running low"
              description="Set a minimum on a part from its detail page and it will be watched here."
            />
          ) : (
            <>
              <ul className="space-y-2">
                {lowStock.map((line) => (
                  <li
                    key={`${line.componentId}:${line.locationId}`}
                    className="rounded-lg border border-border bg-surface-muted/60 px-4 py-3"
                  >
                    <Link
                      href={`/parts/${line.componentId}`}
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {line.name}
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {line.locationPath}
                    </p>

                    <div className="mt-2.5 flex items-center justify-between gap-3 text-xs">
                      <span
                        className={`font-semibold tabular-nums ${
                          line.onHand <= 0 ? "text-danger" : "text-warning"
                        }`}
                      >
                        {line.onHand} on hand
                      </span>
                      <span className="text-muted tabular-nums">
                        min {line.minQty}
                      </span>
                    </div>

                    <div className="mt-1.5">
                      <ProgressBar
                        value={line.onHand}
                        max={line.minQty}
                        tone={line.onHand <= 0 ? "danger" : "warning"}
                        label={`${line.name} at ${line.locationPath}`}
                      />
                    </div>
                  </li>
                ))}
              </ul>

              {summary.lowStockLines > lowStock.length ? (
                <p className="mt-3 text-center text-xs text-muted">
                  and {summary.lowStockLines - lowStock.length} more below their
                  minimum
                </p>
              ) : null}
            </>
          )}
        </Panel>
      </div>
    </Page>
  );
}
