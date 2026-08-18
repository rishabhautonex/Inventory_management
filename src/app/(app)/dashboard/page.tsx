import Link from "next/link";

import { db } from "@/db";
import {
  getActivityHeatmap,
  getDashboardSummary,
  getMovementSeries,
  getStockHealth,
  listLowStock,
  listTopMovers,
} from "@/db/queries/dashboard";
import { listMovements } from "@/db/queries/movements";
import { getOrderCounts } from "@/db/queries/orders";
import { listProjectSignals, listProjects } from "@/db/queries/projects";
import { countAwaitingMe } from "@/db/queries/requests";
import { canManageInventory, requireUser } from "@/lib/auth";
import { INR, formatDelta, formatReason, formatRelative } from "@/lib/format";
import {
  AlertIcon,
  ChevronRightIcon,
  CubeIcon,
  LayersIcon,
  MovementsIcon,
  PackageIcon,
  ReceiptIcon,
  RequestIcon,
  UploadIcon,
} from "@/components/icons";
import {
  Badge,
  Card,
  EmptyState,
  Heatmap,
  Page,
  PageHeader,
  Panel,
  ProgressBar,
  RadialGauge,
  SplineChart,
  StatCard,
  StatusPill,
  type Tone,
} from "@/components/ui";

export const metadata = { title: "Dashboard · LabStock" };

const RECENT_LIMIT = 6;
const LOW_STOCK_LIMIT = 5;
const SERIES_DAYS = 14;
const HEATMAP_DAYS = 28;

/** Badge colour per movement reason, so the log reads at a glance. */
const REASON_TONE: Record<string, Tone> = {
  receipt: "positive",
  return: "positive",
  issue: "accent",
  adjustment: "warning",
  reversal: "neutral",
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Two-hour buckets, labelled by the hour they open. */
const HOUR_LABELS = Array.from({ length: 12 }, (_, i) =>
  `${String(i * 2).padStart(2, "0")}`,
);

export default async function DashboardPage() {
  const user = await requireUser();

  const showOrders = canManageInventory(user);

  /**
   * A project head's own band.
   *
   * Everything else on this screen is lab-wide, which is right for a search
   * page's audience but leaves the person accountable for two projects reading
   * numbers that mostly are not theirs. Only shown to somebody who actually
   * leads something — an admin has /projects for the same view.
   */
  const leadIds = user.role === "project_head" ? user.leadProjectIds : [];

  const [
    summary,
    recent,
    lowStock,
    orderCounts,
    awaitingMe,
    series,
    health,
    heatmap,
    topMovers,
    myProjects,
    projectSignals,
  ] = await Promise.all([
    getDashboardSummary(db),
    listMovements(db, { limit: RECENT_LIMIT }),
    listLowStock(db, LOW_STOCK_LIMIT),
    showOrders ? getOrderCounts(db) : Promise.resolve(null),
    countAwaitingMe(db, user),
    getMovementSeries(db, SERIES_DAYS),
    getStockHealth(db),
    getActivityHeatmap(db, HEATMAP_DAYS),
    listTopMovers(db, 30, 5),
    leadIds.length > 0 ? listProjects(db, leadIds) : Promise.resolve([]),
    listProjectSignals(db, leadIds),
  ]);

  const signalFor = new Map(projectSignals.map((row) => [row.projectId, row]));

  // Only shown when there is something to act on. A tile reading "0 waiting"
  // is a tile that teaches the eye to skip that corner of the screen.
  const showRequests = awaitingMe > 0;
  const tiles = 4 + (orderCounts ? 1 : 0) + (showRequests ? 1 : 0);

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

  const labels = series.map((day) => day.label);
  const movementsPerDay = series.map((day) => day.movements);

  /**
   * On-hand, walked backwards from today.
   *
   * Today's figure is the ledger's own sum; each earlier day is that number
   * with the intervening net movement removed. It is history reconstructed from
   * the same rows the total came from, not a second stored series that could
   * drift from it.
   */
  const onHandHistory = (() => {
    const points: number[] = new Array(series.length);
    let running = summary.unitsOnHand;
    for (let i = series.length - 1; i >= 0; i -= 1) {
      points[i] = running;
      running -= series[i]!.unitsIn - series[i]!.unitsOut;
    }
    return points;
  })();

  const windowIn = series.reduce((sum, day) => sum + day.unitsIn, 0);
  const windowOut = series.reduce((sum, day) => sum + day.unitsOut, 0);
  const windowMovements = series.reduce((sum, day) => sum + day.movements, 0);
  const dailyAverage = windowMovements / Math.max(1, series.length);

  const coverage =
    health.tracked > 0 ? Math.round((health.healthy / health.tracked) * 100) : 0;
  const coverageTone: Tone =
    health.out > 0 ? "danger" : health.low > 0 ? "warning" : "positive";

  // The busiest two-hour window in the last four weeks, straight off the grid.
  const peak = heatmap.reduce(
    (best, row, dow) =>
      row.reduce(
        (inner, count, bucket) =>
          count > inner.count ? { dow, bucket, count } : inner,
        best,
      ),
    { dow: 0, bucket: 0, count: 0 },
  );

  /**
   * Signals are derived, never predicted: each line is a statement about rows
   * already fetched, and one that cannot be computed is simply not listed.
   */
  const signals: Array<{ tone: Tone; label: string; detail: string }> = [];

  if (health.out > 0) {
    signals.push({
      tone: "danger",
      label: `${health.out} watched ${health.out === 1 ? "shelf is" : "shelves are"} empty`,
      detail: "A minimum is set and nothing is on hand",
    });
  }

  if (peak.count > 0) {
    signals.push({
      tone: "accent",
      label: `Busiest window is ${WEEKDAYS[peak.dow]} ${HOUR_LABELS[peak.bucket]}:00–${String(peak.bucket * 2 + 2).padStart(2, "0")}:00`,
      detail: `${peak.count} movements there over ${HEATMAP_DAYS} days`,
    });
  }

  if (windowMovements > 0) {
    const net = windowIn - windowOut;
    signals.push({
      tone: net >= 0 ? "positive" : "warning",
      label: `${formatDelta(net)} units net over ${SERIES_DAYS} days`,
      detail: `${windowIn.toLocaleString("en-IN")} in · ${windowOut.toLocaleString("en-IN")} out`,
    });
  }

  if (dailyAverage >= 1) {
    const change = Math.round(
      ((summary.movementsToday - dailyAverage) / dailyAverage) * 100,
    );
    signals.push({
      tone: change >= 0 ? "positive" : "neutral",
      label: `Today is ${Math.abs(change)}% ${change >= 0 ? "above" : "below"} the ${SERIES_DAYS}-day average`,
      detail: `${dailyAverage.toFixed(1)} movements a day on average`,
    });
  }

  const tileGrid =
    tiles >= 6
      ? "sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6"
      : tiles === 5
        ? "sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5"
        : "sm:grid-cols-2 xl:grid-cols-4";

  return (
    <div className="aurora relative isolate">
      <Page className="relative">
        <PageHeader
          eyebrow="Operations"
          title="Dashboard"
          description={`Welcome back, ${firstName}. Every figure here is summed from the movement ledger.`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone="positive" live>
                Ledger live
              </StatusPill>
              <StatusPill tone="neutral">
                {summary.activeLocations} locations · {summary.activeProjects}{" "}
                projects
              </StatusPill>
            </div>
          }
        />

        <div className={`grid gap-4 ${tileGrid}`}>
          <StatCard
            icon={<PackageIcon size={16} />}
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
            icon={<CubeIcon size={16} />}
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
            spark={onHandHistory}
          />

          <StatCard
            icon={<AlertIcon size={16} />}
            tone={summary.lowStockLines > 0 ? "warning" : "positive"}
            label="Below minimum"
            value={summary.lowStockLines}
            unit={summary.lowStockLines === 1 ? "line" : "lines"}
            hint={
              summary.lowStockLines > 0
                ? "Part-and-cupboard pairs needing a reorder"
                : "Everything with a minimum set is above it"
            }
          />

          <StatCard
            icon={<MovementsIcon size={16} />}
            tone="accent"
            label="Movements today"
            value={summary.movementsToday}
            trend={movementTrend}
            hint={`${windowMovements} over the last ${SERIES_DAYS} days`}
            href="/log"
            spark={movementsPerDay}
          />

          {orderCounts ? (
            <StatCard
              icon={<ReceiptIcon size={16} />}
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

          {showRequests ? (
            <StatCard
              icon={<RequestIcon size={16} />}
              tone="warning"
              label={
                user.role === "admin" || user.role === "manager"
                  ? "Requests to order"
                  : "Requests to approve"
              }
              value={awaitingMe}
              hint={
                user.role === "admin" || user.role === "manager"
                  ? "Approved and waiting to be bought"
                  : "Waiting on your decision"
              }
              href="/requests"
            />
          ) : null}
        </div>

        {myProjects.length > 0 ? (
          <Panel
            className="mt-4"
            eyebrow="Yours to run"
            title={myProjects.length === 1 ? "Your project" : "Your projects"}
            action={
              <Link
                href="/projects"
                className="inline-flex items-center gap-1 text-sm font-semibold text-accent-text hover:underline"
              >
                All projects
                <ChevronRightIcon size={16} />
              </Link>
            }
          >
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {myProjects.map((project) => {
                const signal = signalFor.get(project.id);

                return (
                  <li
                    key={project.id}
                    className="rounded-xl border border-border bg-surface-muted/60 p-4 transition-colors hover:border-border-strong"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <Link
                        href={`/projects/${project.id}`}
                        className="min-w-0 text-sm font-semibold hover:text-accent-text"
                      >
                        <span className="block truncate">{project.name}</span>
                        <span className="mt-0.5 block font-mono text-xs font-medium text-muted">
                          {project.code}
                        </span>
                      </Link>
                      <LayersIcon size={16} className="shrink-0 text-muted" />
                    </div>

                    {/* Each badge restates a row already counted, and one that
                        counts nothing is not drawn — a rail of zeroes teaches
                        the eye to skip the whole card. */}
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {project.pendingRequests > 0 ? (
                        <Badge tone="warning">
                          {project.pendingRequests} to approve
                        </Badge>
                      ) : null}
                      {signal && signal.empty > 0 ? (
                        <Badge tone="danger">{signal.empty} empty</Badge>
                      ) : null}
                      {signal && signal.low > 0 ? (
                        <Badge tone="warning">{signal.low} low</Badge>
                      ) : null}
                      {signal && signal.overdueOrders > 0 ? (
                        <Badge tone="danger">
                          {signal.overdueOrders} overdue
                        </Badge>
                      ) : null}
                      {signal && signal.shortLines !== null && signal.shortLines > 0 ? (
                        <Badge tone="accent">{signal.shortLines} short</Badge>
                      ) : null}
                      {project.pendingRequests === 0 &&
                      signal &&
                      signal.empty === 0 &&
                      signal.low === 0 &&
                      signal.overdueOrders === 0 &&
                      (signal.shortLines ?? 0) === 0 ? (
                        <Badge tone="positive">Nothing outstanding</Badge>
                      ) : null}
                    </div>

                    <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                      <div>
                        <dt className="eyebrow text-muted">Parts</dt>
                        <dd className="readout mt-0.5 text-sm font-semibold">
                          {project.distinctParts}
                        </dd>
                      </div>
                      <div>
                        <dt className="eyebrow text-muted">Open orders</dt>
                        <dd className="readout mt-0.5 text-sm font-semibold">
                          {signal ? signal.openOrders : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt className="eyebrow text-muted">Spend</dt>
                        <dd className="readout mt-0.5 text-sm font-semibold">
                          {project.spend > 0 ? INR.format(project.spend) : "—"}
                        </dd>
                      </div>
                    </dl>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Link
                        href={`/projects/${project.id}`}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-accent-text transition-colors hover:bg-surface-hover"
                      >
                        Open
                        <ChevronRightIcon size={14} />
                      </Link>
                      <Link
                        href={`/projects/${project.id}/bom`}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                      >
                        <UploadIcon size={14} />
                        {project.bomCount > 0 ? "New BOM" : "Upload a BOM"}
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>
        ) : null}

        {/* Throughput and coverage: the two questions a lab head opens this
            screen to answer — is stock flowing, and is anything about to run
            out. */}
        <div className="mt-4 grid gap-4 xl:grid-cols-3">
          <Panel
            className="xl:col-span-2"
            eyebrow={`Last ${SERIES_DAYS} days`}
            title="Throughput"
            action={
              <div className="flex items-center gap-2">
                <Badge tone="positive">{windowIn.toLocaleString("en-IN")} in</Badge>
                <Badge tone="warning">
                  {windowOut.toLocaleString("en-IN")} out
                </Badge>
              </div>
            }
          >
            {windowMovements === 0 ? (
              <EmptyState
                title="No movements in this window"
                description="Units in and out will chart here as soon as stock starts moving."
              />
            ) : (
              <SplineChart
                labels={labels}
                series={[
                  {
                    name: "Units in",
                    tone: "positive",
                    values: series.map((day) => day.unitsIn),
                  },
                  {
                    name: "Units out",
                    tone: "warning",
                    values: series.map((day) => day.unitsOut),
                  },
                ]}
              />
            )}
          </Panel>

          <Panel
            eyebrow="Against minimums"
            title="Stock coverage"
            action={
              health.tracked > 0 ? (
                <StatusPill tone={coverageTone}>
                  {health.tracked} watched
                </StatusPill>
              ) : null
            }
          >
            {health.tracked === 0 ? (
              <EmptyState
                title="Nothing is being watched yet"
                description="Set a minimum on a part from its detail page and its coverage shows up here."
              />
            ) : (
              <div className="flex flex-col items-center">
                <RadialGauge
                  value={health.healthy}
                  max={health.tracked}
                  tone={coverageTone}
                  label={`${coverage}%`}
                  caption="above minimum"
                />

                <dl className="mt-5 grid w-full grid-cols-3 gap-2 text-center">
                  {[
                    { label: "Healthy", value: health.healthy, tone: "positive" as Tone },
                    { label: "Low", value: health.low, tone: "warning" as Tone },
                    { label: "Empty", value: health.out, tone: "danger" as Tone },
                  ].map((cell) => (
                    <div
                      key={cell.label}
                      className="rounded-lg border border-border bg-surface-muted/60 px-2 py-3"
                    >
                      <dt className="eyebrow text-muted">{cell.label}</dt>
                      <dd
                        className={`readout mt-1 text-xl font-bold ${
                          cell.tone === "positive"
                            ? "text-positive"
                            : cell.tone === "warning"
                              ? "text-warning"
                              : "text-danger"
                        }`}
                      >
                        {cell.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </Panel>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-3">
          <Panel
            className="xl:col-span-2"
            eyebrow="Ledger"
            title="Recent activity"
            action={
              <Link
                href="/log"
                className="inline-flex items-center gap-1 text-sm font-semibold text-accent-text hover:underline"
              >
                View all
                <ChevronRightIcon size={16} />
              </Link>
            }
          >
            {recent.length === 0 ? (
              <EmptyState
                title="Nothing has moved yet"
                description="Once someone takes a part out or puts one back, it shows up here and in the log."
              />
            ) : (
              /* A rail down the left turns six rows into one sequence — the
                 log is a chronology, and a stack of cards does not say so. */
              <ol className="relative space-y-1 before:absolute before:bottom-4 before:left-[7px] before:top-4 before:w-px before:bg-border">
                {recent.map((entry) => {
                  const undone = entry.isReversed;
                  const tone = REASON_TONE[entry.reason] ?? "neutral";

                  return (
                    <li key={entry.id} className="relative flex gap-3 pl-6">
                      <span
                        aria-hidden
                        className={`absolute left-0 top-4 h-3.5 w-3.5 rounded-full border-2 border-background ${
                          undone
                            ? "bg-muted"
                            : tone === "positive"
                              ? "bg-positive"
                              : tone === "warning"
                                ? "bg-warning"
                                : tone === "danger"
                                  ? "bg-danger"
                                  : "bg-accent"
                        }`}
                      />

                      <div className="min-w-0 flex-1 rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-hover/60">
                        <div className="flex items-start justify-between gap-3">
                          <p
                            className={`min-w-0 truncate text-sm font-medium ${
                              undone ? "line-through opacity-60" : ""
                            }`}
                          >
                            <Link
                              href={`/parts/${entry.componentId}`}
                              className="hover:text-accent-text"
                            >
                              {entry.componentName}
                            </Link>
                          </p>

                          <span
                            className={`readout shrink-0 text-sm font-semibold ${
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
                            <Badge tone={tone}>
                              {formatReason(entry.reason)}
                            </Badge>
                            <span className="whitespace-nowrap text-xs text-muted">
                              {formatRelative(entry.createdAt)}
                            </span>
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Panel>

          <Panel
            eyebrow="Needs a reorder"
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
                      className="rounded-lg border border-border bg-surface-muted/60 px-4 py-3 transition-colors hover:border-border-strong"
                    >
                      <Link
                        href={`/parts/${line.componentId}`}
                        className="block truncate text-sm font-medium hover:text-accent-text"
                      >
                        {line.name}
                      </Link>
                      <p className="mt-0.5 truncate text-xs text-muted">
                        {line.locationPath}
                      </p>

                      <div className="mt-2.5 flex items-center justify-between gap-3 text-xs">
                        <span
                          className={`readout font-semibold ${
                            line.onHand <= 0 ? "text-danger" : "text-warning"
                          }`}
                        >
                          {line.onHand} on hand
                        </span>
                        <span className="readout text-muted">
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
                    and {summary.lowStockLines - lowStock.length} more below
                    their minimum
                  </p>
                ) : null}
              </>
            )}
          </Panel>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-3">
          <Panel
            className="xl:col-span-2"
            eyebrow={`Last ${HEATMAP_DAYS} days`}
            title="When the lab moves stock"
            action={
              <span className="hidden items-center gap-2 text-xs text-muted sm:flex">
                Quiet
                <span
                  aria-hidden
                  className="h-2 w-16 rounded-full"
                  style={{
                    background:
                      "linear-gradient(90deg, var(--surface-muted), color-mix(in srgb, var(--accent) 55%, transparent), var(--accent))",
                  }}
                />
                Busy
              </span>
            }
          >
            {windowMovements === 0 && peak.count === 0 ? (
              <EmptyState
                title="No activity to map yet"
                description="Weekday and hour-of-day patterns appear once the ledger has a few weeks behind it."
              />
            ) : (
              <Heatmap
                rows={WEEKDAYS.map((label, index) => ({
                  label,
                  values: heatmap[index] ?? [],
                }))}
                columnLabels={HOUR_LABELS}
              />
            )}
          </Panel>

          <div className="flex flex-col gap-4">
            <Panel eyebrow="Derived from the ledger" title="Signals">
              {signals.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted">
                  Nothing worth flagging yet.
                </p>
              ) : (
                <ul className="space-y-3">
                  {signals.map((signal) => (
                    <li key={signal.label} className="flex gap-3">
                      <span
                        aria-hidden
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                          signal.tone === "positive"
                            ? "bg-positive"
                            : signal.tone === "warning"
                              ? "bg-warning"
                              : signal.tone === "danger"
                                ? "bg-danger"
                                : signal.tone === "accent"
                                  ? "bg-accent"
                                  : "bg-muted"
                        }`}
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium leading-snug">
                          {signal.label}
                        </p>
                        <p className="mt-0.5 text-xs text-muted">
                          {signal.detail}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel eyebrow="Last 30 days" title="Most consumed">
              {topMovers.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted">
                  Nothing has left a shelf yet.
                </p>
              ) : (
                <ul className="space-y-3">
                  {topMovers.map((mover) => {
                    const peakOut = topMovers[0]?.unitsOut ?? 1;

                    return (
                      <li key={mover.componentId}>
                        <div className="flex items-baseline justify-between gap-3">
                          <Link
                            href={`/parts/${mover.componentId}`}
                            className="min-w-0 truncate text-sm font-medium hover:text-accent-text"
                          >
                            {mover.name}
                          </Link>
                          <span className="readout shrink-0 text-sm font-semibold">
                            {mover.unitsOut.toLocaleString("en-IN")}
                          </span>
                        </div>
                        <div className="mt-1.5">
                          <ProgressBar
                            value={mover.unitsOut}
                            max={peakOut}
                            tone="accent"
                            label={`${mover.name}, ${mover.unitsOut} units out`}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </div>
        </div>

        <Card className="mt-4 px-4 py-3 text-xs text-muted sm:px-5">
          Stock is never stored as a number. Every figure on this screen is{" "}
          <span className="font-medium text-foreground">SUM(qty_delta)</span>{" "}
          over the append-only ledger, so nothing here can drift from the
          movements that produced it.
        </Card>
      </Page>
    </div>
  );
}
