import { notFound, redirect } from "next/navigation";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { runQuery } from "@/db/rows";
import { requireUser } from "@/lib/auth";

/**
 * Stable address for a component at a location.
 *
 * QR scanning is out of scope for v1, but the spec asks that this URL shape
 * exist now so printed labels made later keep working and the scanner drops in
 * without a data-model change. For the moment it simply resolves to the part,
 * which is what a scan should land on anyway.
 */
export default async function ScanPage({
  params,
}: {
  params: Promise<{ locationId: string; componentId: string }>;
}) {
  await requireUser();
  const { locationId, componentId } = await params;

  const rows = await runQuery<{ exists: boolean }>(
    db,
    sql`
      SELECT EXISTS (
        SELECT 1 FROM components c, locations l
        WHERE c.id = ${componentId} AND l.id = ${locationId}
      ) AS exists
    `,
  );

  if (!rows[0]?.exists) notFound();

  redirect(`/parts/${componentId}?location=${locationId}`);
}
