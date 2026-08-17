import { sql } from "drizzle-orm";

import { runQuery } from "@/db/rows";
import type { Database } from "@/db/types";

/**
 * ===========================================================================
 * NOTIFICATIONS
 * ===========================================================================
 *
 * Delivery sits behind `NotificationChannel` so that email — explicitly a
 * later concern in the spec, not a v1 one — can be added as a second
 * implementation without touching a single trigger. Triggers build a draft and
 * hand it to `notify()`; they know nothing about how it is delivered.
 * ===========================================================================
 */

export type NotificationType =
  | "low_stock"
  | "out_of_stock"
  | "order_overdue"
  | "request_pending"
  | "request_decided";

export type NotificationDraft = {
  type: NotificationType;
  title: string;
  body?: string | null;
  /** Where tapping the notification should land. */
  linkUrl?: string | null;
  /**
   * Stable identity of the underlying condition. When set, a recipient who
   * already has a notification with this key inside the window is skipped.
   */
  dedupeKey?: string | null;
  dedupeWindowDays?: number;
};

/** The spec's rule for low stock: at most one per condition per seven days. */
export const DEFAULT_DEDUPE_WINDOW_DAYS = 7;

export interface NotificationChannel {
  readonly name: string;
  /** Returns how many recipients were actually notified. */
  deliver(
    db: Database,
    userIds: string[],
    draft: NotificationDraft,
  ): Promise<number>;
}

/**
 * In-app delivery: one row per recipient in `notifications`.
 *
 * The dedupe check is part of the INSERT rather than a read followed by a
 * write, so two movements landing at the same instant cannot both decide the
 * condition is un-notified and each insert a row.
 */
export const inAppChannel: NotificationChannel = {
  name: "in-app",

  async deliver(db, userIds, draft) {
    if (userIds.length === 0) return 0;

    const dedupeKey = draft.dedupeKey ?? null;
    const windowDays = draft.dedupeWindowDays ?? DEFAULT_DEDUPE_WINDOW_DAYS;

    const rows = await runQuery<{ id: string }>(
      db,
      sql`
        INSERT INTO notifications (user_id, type, title, body, link_url, dedupe_key)
        SELECT
          recipient,
          ${draft.type}::text,
          ${draft.title}::text,
          ${draft.body ?? null}::text,
          ${draft.linkUrl ?? null}::text,
          ${dedupeKey}::text
        FROM unnest(${sql.param(userIds)}::uuid[]) AS recipient
        WHERE ${dedupeKey}::text IS NULL
           OR NOT EXISTS (
                SELECT 1
                FROM notifications n
                WHERE n.user_id = recipient
                  AND n.dedupe_key = ${dedupeKey}::text
                  AND n.created_at > now() - make_interval(days => ${windowDays})
              )
        RETURNING id
      `,
    );

    return rows.length;
  },
};

let channel: NotificationChannel = inAppChannel;

/** Swaps the delivery channel. Used by tests; the app uses the default. */
export function setNotificationChannel(next: NotificationChannel): void {
  channel = next;
}

export function getNotificationChannel(): NotificationChannel {
  return channel;
}

/**
 * Send one notification to many recipients.
 *
 * Never throws. A notification is a courtesy attached to some real action —
 * taking a part out, receiving an order — and a failure to deliver one must not
 * roll back or report failure for the thing that actually happened.
 */
export async function notify(
  db: Database,
  userIds: string[],
  draft: NotificationDraft,
): Promise<number> {
  try {
    const unique = [...new Set(userIds)];
    return await channel.deliver(db, unique, draft);
  } catch (error) {
    console.error("[notify]", draft.type, error);
    return 0;
  }
}
