import { sql } from "drizzle-orm";

import { runQuery } from "@/db/rows";
import type { Database } from "@/db/types";
import { adminsAndProjectHeads } from "@/lib/alert-recipients";
import { notify, type NotificationType } from "@/lib/notify";

/**
 * Low-stock and out-of-stock alerts.
 *
 * Called after a ledger write, never inside it: on-hand is only knowable once
 * the movement has committed, and a notification must not be able to fail the
 * movement that prompted it.
 *
 * Recipients are admins plus the heads of the cupboard's project. Managers are
 * deliberately excluded — the spec gives them a weekly digest instead of a ping
 * for every shelf in the lab.
 */

type StockLine = {
  componentName: string;
  locationPath: string;
  projectId: string | null;
  onHand: number;
  minQty: number | null;
};

async function readLine(
  db: Database,
  componentId: string,
  locationId: string,
): Promise<StockLine | null> {
  const rows = await runQuery<{
    component_name: string;
    location_path: string;
    project_id: string | null;
    on_hand: string | number;
    min_qty: number | null;
  }>(
    db,
    sql`
      SELECT
        c.name                  AS component_name,
        lt.path                 AS location_path,
        lt.effective_project_id AS project_id,
        COALESCE(soh.on_hand, 0) AS on_hand,
        st.min_qty
      FROM components c
      CROSS JOIN location_tree lt
      LEFT JOIN stock_on_hand soh
        ON soh.component_id = c.id AND soh.location_id = lt.id
      LEFT JOIN stock_thresholds st
        ON st.component_id = c.id AND st.location_id = lt.id
      WHERE c.id = ${componentId} AND lt.id = ${locationId}
    `,
  );

  const row = rows[0];
  if (!row) return null;

  return {
    componentName: row.component_name,
    locationPath: row.location_path,
    projectId: row.project_id,
    onHand: Number(row.on_hand),
    minQty: row.min_qty === null ? null : Number(row.min_qty),
  };
}

/**
 * Checks one component/location line and notifies if it has fallen too far.
 *
 * Only the more severe of the two conditions fires: at zero, a shelf is out of
 * stock rather than merely low, and sending both would mean two notifications
 * for one event. Each condition carries its own dedupe key, so a shelf that
 * goes low and later empties still produces both alerts in turn.
 */
export async function checkStockAlerts(
  db: Database,
  componentId: string,
  locationId: string,
): Promise<void> {
  try {
    const line = await readLine(db, componentId, locationId);
    if (!line) return;

    let type: NotificationType;
    let title: string;
    let body: string;

    if (line.onHand <= 0) {
      type = "out_of_stock";
      title = `${line.componentName} is out of stock`;
      body = `Nothing left at ${line.locationPath}.`;
    } else if (line.minQty !== null && line.onHand <= line.minQty) {
      type = "low_stock";
      title = `${line.componentName} is running low`;
      body =
        `${line.onHand} left at ${line.locationPath}, ` +
        `and the minimum is ${line.minQty}.`;
    } else {
      return;
    }

    const recipients = await adminsAndProjectHeads(db, line.projectId);
    if (recipients.length === 0) return;

    await notify(db, recipients, {
      type,
      title,
      body,
      linkUrl: `/parts/${componentId}`,
      dedupeKey: `${type}:${componentId}:${locationId}`,
    });
  } catch (error) {
    // Swallowed on purpose: see the note at the top of the file.
    console.error("[stock alerts]", error);
  }
}
