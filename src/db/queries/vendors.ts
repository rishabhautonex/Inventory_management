import { sql } from "drizzle-orm";

import { runQuery } from "@/db/rows";
import type { Database } from "@/db/types";

/**
 * The vendor list, with what has been bought from each.
 *
 * Vendors are created by name as a side effect of raising an order
 * (`resolveVendorByName`), which is the right trade for the person typing an
 * invoice — but it means a typo silently forks "Robu" into two suppliers, and
 * until the admin screen existed nothing could ever put them back together.
 * Spend per vendor is the other half: it is the only figure that answers "who do
 * we actually buy from", which is the question behind negotiating with them.
 */

export type VendorRow = {
  id: string;
  name: string;
  website: string | null;
  orderCount: number;
  /** Non-cancelled spend, invoice totals where present, line sums otherwise. */
  spend: number;
  lastOrderAt: Date | null;
};

export async function listVendorsWithSpend(
  db: Database,
): Promise<VendorRow[]> {
  const rows = await runQuery<{
    id: string;
    name: string;
    website: string | null;
    order_count: string | number;
    spend: string | number;
    last_order_at: string | Date | null;
  }>(
    db,
    sql`
      SELECT
        v.id,
        v.name,
        v.website,
        (SELECT count(*) FROM orders o WHERE o.vendor_id = v.id) AS order_count,
        COALESCE((
          SELECT SUM(
            COALESCE(
              o.total_amount,
              (SELECT SUM(ol.qty * COALESCE(ol.unit_price, 0))
                 FROM order_lines ol WHERE ol.order_id = o.id)
            )
          )
          FROM orders o
          WHERE o.vendor_id = v.id AND o.status <> 'cancelled'
        ), 0) AS spend,
        (
          SELECT MAX(COALESCE(o.order_date, o.created_at))
          FROM orders o WHERE o.vendor_id = v.id
        ) AS last_order_at
      FROM vendors v
      ORDER BY v.name
    `,
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    website: r.website,
    orderCount: Number(r.order_count),
    spend: Number(r.spend),
    lastOrderAt: r.last_order_at ? new Date(r.last_order_at) : null,
  }));
}
