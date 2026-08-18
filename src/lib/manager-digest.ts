import { getWeeklyDigest, type WeeklyDigest } from "@/db/queries/digest";
import type { Database } from "@/db/types";
import { activeManagers } from "@/lib/alert-recipients";
import { INR } from "@/lib/format";
import { notify } from "@/lib/notify";

/**
 * The manager's weekly digest.
 *
 * The spec is explicit that managers are *not* pinged for every low shelf, and
 * equally explicit that they are owed a digest instead — so until this existed a
 * manager received nothing at all. Run weekly from
 * [/api/jobs/digest](../app/api/jobs/digest/route.ts).
 *
 * Every clause is built from a figure that was counted, and a figure of zero
 * drops its clause rather than being written out: "0 shelves low" and "no
 * shelves low" read the same to a person, but a digest of eight zeroes teaches
 * the reader that the digest is noise. A week where nothing at all happened is
 * therefore not sent.
 */

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** The digest's sentences, in the order a manager would ask for them. */
export function digestLines(digest: WeeklyDigest): string[] {
  const lines: string[] = [];

  if (digest.movements > 0) {
    const parts = [
      `${plural(digest.movements, "movement")} this week`,
      `${digest.unitsOut} out`,
      `${digest.unitsIn} in`,
    ];
    if (digest.activePeople > 0) {
      parts.push(`${plural(digest.activePeople, "person", "people")}`);
    }
    lines.push(parts.join(" · "));
  }

  if (digest.topParts.length > 0) {
    lines.push(
      "Most used: " +
        digest.topParts.map((p) => `${p.name} (${p.unitsOut})`).join(", "),
    );
  }

  if (digest.outOfStockLines > 0 || digest.lowStockLines > 0) {
    const parts: string[] = [];
    if (digest.outOfStockLines > 0) {
      parts.push(`${plural(digest.outOfStockLines, "shelf", "shelves")} empty`);
    }
    if (digest.lowStockLines > 0) {
      parts.push(`${digest.lowStockLines} below minimum`);
    }
    lines.push("Stock: " + parts.join(", "));
  }

  if (digest.ordersPlaced > 0) {
    lines.push(
      `Purchasing: ${plural(digest.ordersPlaced, "order")} placed, ` +
        `${INR.format(digest.spend)}`,
    );
  }

  if (digest.overdueOrders > 0) {
    lines.push(`${plural(digest.overdueOrders, "order")} past the expected date`);
  }

  if (digest.pendingRequests > 0 || digest.requestsToOrder > 0) {
    const parts: string[] = [];
    if (digest.pendingRequests > 0) {
      parts.push(`${digest.pendingRequests} awaiting approval`);
    }
    if (digest.requestsToOrder > 0) {
      parts.push(`${digest.requestsToOrder} approved and waiting to be ordered`);
    }
    lines.push("Requests: " + parts.join(", "));
  }

  return lines;
}

/** Headline: the two figures a manager scans for. */
function digestTitle(digest: WeeklyDigest): string {
  const attention = digest.outOfStockLines + digest.overdueOrders;

  if (attention > 0) {
    return `Weekly digest — ${plural(digest.movements, "movement")}, ${plural(attention, "thing", "things")} to look at`;
  }

  return `Weekly digest — ${plural(digest.movements, "movement")}, nothing overdue`;
}

export type DigestSend = {
  sent: number;
  /** Absent when the week was empty, or when no manager holds an account. */
  skipped?: "quiet_week" | "no_managers";
};

export async function sendManagerDigest(db: Database): Promise<DigestSend> {
  const digest = await getWeeklyDigest(db);
  const lines = digestLines(digest);

  // Nothing measured means nothing to say. A digest that arrives every week
  // whether or not the lab was open is a digest nobody opens.
  if (lines.length === 0) return { sent: 0, skipped: "quiet_week" };

  const managers = await activeManagers(db);
  if (managers.length === 0) return { sent: 0, skipped: "no_managers" };

  // Keyed on the week, so re-running the job — a retry, a manual trigger, a
  // second cron region — cannot deliver Monday's digest twice.
  const sent = await notify(db, managers, {
    type: "weekly_digest",
    title: digestTitle(digest),
    body: lines.join("\n"),
    linkUrl: "/dashboard",
    dedupeKey: `weekly_digest:${digest.weekKey}`,
    dedupeWindowDays: 30,
  });

  return { sent };
}
