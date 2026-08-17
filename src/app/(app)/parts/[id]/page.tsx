import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { runQuery } from "@/db/rows";
import { components } from "@/db/schema";
import { listMovements } from "@/db/queries/movements";
import { canManageInventory, canUndoMovement, requireUser } from "@/lib/auth";
import { getOnHandByLocation } from "@/lib/ledger";
import { ExternalLinkIcon, PencilIcon } from "@/components/icons";
import {
  Badge,
  Card,
  Page,
  Panel,
  secondaryButtonClass,
} from "@/components/ui";
import { MovementRow } from "../../log/movement-row";
import { PartActions } from "./part-actions";
import { StockPanel } from "./stock-panel";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [component] = await db
    .select({ name: components.name })
    .from(components)
    .where(eq(components.id, id));

  return { title: component ? `${component.name} · LabStock` : "Part · LabStock" };
}

export default async function PartDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const [component] = await db
    .select()
    .from(components)
    .where(eq(components.id, id));

  if (!component) notFound();

  const [stock, recent, allLocations] = await Promise.all([
    getOnHandByLocation(db, component.id),
    listMovements(db, { componentId: component.id, limit: 15 }),
    // Every active location, so a part can be put back somewhere it has never
    // been — which is exactly what happens the first time one is moved.
    runQuery<{ id: string; path: string }>(
      db,
      sql`SELECT id, path FROM location_tree WHERE is_active ORDER BY path`,
    ),
  ]);

  const total = stock.reduce((sum, row) => sum + row.onHand, 0);
  const stocked = stock.filter((row) => row.onHand > 0);
  const isAdmin = canManageInventory(user);

  return (
    <Page>
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start gap-5">
          {component.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={component.photoUrl}
              alt=""
              className="h-24 w-24 shrink-0 rounded-xl border border-border object-cover"
            />
          ) : null}

          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl">
              {component.name}
            </h1>

            {component.mpn ? (
              <p className="mt-1.5 font-mono text-sm text-muted">
                {component.mpn}
              </p>
            ) : null}

            {component.manufacturer || component.category ? (
              <div className="mt-2.5 flex flex-wrap gap-2">
                {component.manufacturer ? (
                  <Badge tone="neutral">{component.manufacturer}</Badge>
                ) : null}
                {component.category ? (
                  <Badge tone="accent">{component.category}</Badge>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="shrink-0 text-right">
            <p className="text-4xl font-bold tabular-nums tracking-tight">
              {total}
            </p>
            <p className="text-xs text-muted">in total</p>
          </div>
        </div>

        <PartActions
          componentId={component.id}
          componentName={component.name}
          locations={stocked.map((row) => ({
            locationId: row.locationId,
            locationLabel: row.locationPath,
            onHand: row.onHand,
          }))}
        />

        {component.productUrl || component.datasheetUrl || isAdmin ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {component.productUrl ? (
              <ExternalLink href={component.productUrl}>Buy again</ExternalLink>
            ) : null}
            {component.datasheetUrl ? (
              <ExternalLink href={component.datasheetUrl}>Datasheet</ExternalLink>
            ) : null}
            {isAdmin ? (
              <Link
                href={`/admin/parts/${component.id}`}
                className={secondaryButtonClass}
              >
                <PencilIcon size={16} />
                Edit part
              </Link>
            ) : null}
          </div>
        ) : null}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <StockPanel
            componentId={component.id}
            isAdmin={isAdmin}
            stock={stock.map((row) => ({
              locationId: row.locationId,
              locationPath: row.locationPath,
              projectName: row.projectName,
              onHand: row.onHand,
              minQty: row.minQty,
            }))}
            locations={allLocations}
          />

          <Panel title="Recent movements" bodyClassName="pb-2">
            {recent.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-muted sm:px-5">
                Nothing recorded yet.
              </p>
            ) : (
              <ul className="divide-y divide-border border-t border-border">
                {recent.map((entry) => (
                  <MovementRow
                    key={entry.id}
                    entry={entry}
                    canUndo={canUndoMovement(user, entry)}
                  />
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {component.notes ? (
          <Panel title="Notes">
            <p className="whitespace-pre-wrap text-sm text-muted">
              {component.notes}
            </p>
          </Panel>
        ) : null}
      </div>
    </Page>
  );
}

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={secondaryButtonClass}
    >
      {children}
      <ExternalLinkIcon size={16} />
    </a>
  );
}
