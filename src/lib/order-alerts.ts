import { listOverdueOrders } from "@/db/queries/orders";
import type { Database } from "@/db/types";
import { adminsAndProjectHeads } from "@/lib/alert-recipients";
import { notify } from "@/lib/notify";
import { formatDate } from "@/lib/format";

/**
 * Overdue-delivery alerts — the spec's one scheduled trigger.
 *
 * Everything else in the notification table happens on a write, because a
 * shelf only goes low when somebody takes something off it. Lateness has no
 * write behind it: an order becomes overdue by nobody doing anything, which is
 * exactly why it needs a job. Run daily from
 * [/api/jobs/overdue](../app/api/jobs/overdue/route.ts).
 *
 * Recipients are admins plus that project's heads, the same rule as the stock
 * alerts and for the same reason — a head is accountable for the spend and is
 * the person chasing the vendor.
 */

export type OverdueSweep = {
  /** Orders found past their expected date. */
  checked: number;
  /** Notification rows actually written, after deduplication. */
  notified: number;
};

/**
 * One notification per order, deduplicated for a week.
 *
 * The job runs every day but an order stays late until it arrives, so without a
 * dedupe key a fortnight's delay would be fourteen identical rows in somebody's
 * bell — which is how people learn to ignore the bell. The key is the order, so
 * a week later the same order says so again with a larger number, and a
 * different order is never suppressed by this one.
 *
 * Never throws. It is a courtesy attached to the passage of time; a failure to
 * describe one order must not stop the other orders being described.
 */
export async function checkOverdueOrders(db: Database): Promise<OverdueSweep> {
  const orders = await listOverdueOrders(db);
  let notified = 0;

  for (const order of orders) {
    try {
      const recipients = await adminsAndProjectHeads(db, order.projectId);
      if (recipients.length === 0) continue;

      const who = order.vendorName ?? "An offline purchase";
      const days = order.daysLate === 1 ? "1 day" : `${order.daysLate} days`;

      notified += await notify(db, recipients, {
        type: "order_overdue",
        title: `${who} is ${days} late`,
        body:
          `Expected ${formatDate(order.expectedDate)} and still ${order.status}` +
          (order.projectName ? ` — ${order.projectName}.` : "."),
        linkUrl: `/orders/${order.id}`,
        dedupeKey: `order_overdue:${order.id}`,
      });
    } catch (error) {
      console.error("[overdue orders]", order.id, error);
    }
  }

  return { checked: orders.length, notified };
}
