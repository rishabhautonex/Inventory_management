import { db } from "@/db";
import { getThresholdCoverage } from "@/db/queries/thresholds";
import { canManageInventory, requireUser } from "@/lib/auth";
import { AlertIcon, BellIcon, CubeIcon } from "@/components/icons";
import {
  Card,
  EmptyState,
  NoAccess,
  Page,
  PageHeader,
  Panel,
  StatCard,
  TableWrap,
  thClass,
  theadClass,
} from "@/components/ui";
import { ThresholdRow } from "./threshold-row";

export const metadata = { title: "Minimums · LabStock" };

/**
 * Where the low-stock alerts come from.
 *
 * The spec's first two notification triggers both depend on `min_qty`, which the
 * app could previously only set one part at a time from a part's own page. The
 * effect was quiet: a shelf with no minimum cannot raise an alert, so the parts
 * nobody had got round to configuring were exactly the ones that would run out
 * without saying so.
 *
 * This screen therefore leads with the gap rather than the breaches. "Nine
 * shelves have no minimum" is the more useful sentence, because the breaches are
 * already on the dashboard and in somebody's bell.
 */
export default async function ThresholdsPage() {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return <NoAccess>Only admins and managers can set minimums.</NoAccess>;
  }

  const coverage = await getThresholdCoverage(db);

  return (
    <Page>
      <PageHeader
        title="Minimums"
        description="A low-stock alert can only fire for a shelf that has a minimum. These are the shelves that have one, and the ones that do not."
        back={{ href: "/admin", label: "Admin" }}
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          icon={<BellIcon />}
          tone="accent"
          label="Watched shelves"
          value={coverage.counts.watched}
          hint="Component and location pairs with a minimum set"
        />
        <StatCard
          icon={<AlertIcon />}
          tone={coverage.counts.breaching > 0 ? "warning" : "positive"}
          label="At or below"
          value={coverage.counts.breaching}
          hint="Already alerted, and waiting to be restocked"
        />
        <StatCard
          icon={<CubeIcon />}
          tone={coverage.counts.unwatched > 0 ? "warning" : "positive"}
          label="Unwatched"
          value={coverage.counts.unwatched}
          hint="Holding stock with no minimum — these can empty in silence"
        />
      </div>

      <div className="space-y-4">
        <Panel
          title="No minimum set"
          action={
            <span className="text-xs text-muted">
              {coverage.unwatched.length} shown
            </span>
          }
        >
          {coverage.unwatched.length === 0 ? (
            <EmptyState
              title="Every stocked shelf has a minimum"
              description="Nothing in the lab can now run out without somebody being told."
            />
          ) : (
            <TableWrap minWidth={760}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>Part</th>
                  <th className={thClass}>Where</th>
                  <th className={`${thClass} text-right`}>On hand</th>
                  <th className={`${thClass} text-right`}>Minimum</th>
                  <th className={thClass}>State</th>
                </tr>
              </thead>
              <tbody>
                {coverage.unwatched.map((line) => (
                  <ThresholdRow
                    key={`${line.componentId}-${line.locationId}`}
                    line={line}
                  />
                ))}
              </tbody>
            </TableWrap>
          )}
        </Panel>

        <Panel
          title="Watched shelves"
          action={
            <span className="text-xs text-muted">worst first</span>
          }
        >
          {coverage.watched.length === 0 ? (
            <Card>
              <EmptyState
                title="No minimums anywhere yet"
                description="Set one on a shelf above and the low-stock alerts start working — admins and that project's heads hear about it the moment it is breached."
              />
            </Card>
          ) : (
            <TableWrap minWidth={760}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>Part</th>
                  <th className={thClass}>Where</th>
                  <th className={`${thClass} text-right`}>On hand</th>
                  <th className={`${thClass} text-right`}>Minimum</th>
                  <th className={thClass}>State</th>
                </tr>
              </thead>
              <tbody>
                {coverage.watched.map((line) => (
                  <ThresholdRow
                    key={`${line.componentId}-${line.locationId}`}
                    line={line}
                  />
                ))}
              </tbody>
            </TableWrap>
          )}
        </Panel>
      </div>

      <p className="mt-4 text-xs text-muted">
        Clearing a minimum stops the alerts for that shelf. Setting one above what
        is already there fires immediately — nothing has to move for a shelf to be
        below its minimum.
      </p>
    </Page>
  );
}
