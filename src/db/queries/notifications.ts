import { sql } from "drizzle-orm";

import { runQuery } from "../rows";
import type { Database } from "../types";
import type { NotificationType } from "@/lib/notify";

export type NotificationRow = {
  id: string;
  type: NotificationType | string;
  title: string;
  body: string | null;
  linkUrl: string | null;
  readAt: Date | null;
  createdAt: Date;
};

export async function countUnread(
  db: Database,
  userId: string,
): Promise<number> {
  const rows = await runQuery<{ unread: string | number }>(
    db,
    sql`
      SELECT count(*) AS unread
      FROM notifications
      WHERE user_id = ${userId} AND read_at IS NULL
    `,
  );

  return Number(rows[0]?.unread ?? 0);
}

export async function listNotifications(
  db: Database,
  userId: string,
  options: { limit?: number; offset?: number; unreadOnly?: boolean } = {},
): Promise<NotificationRow[]> {
  const limit = Math.min(options.limit ?? 30, 100);
  const offset = options.offset ?? 0;

  const rows = await runQuery<{
    id: string;
    type: string;
    title: string;
    body: string | null;
    link_url: string | null;
    read_at: string | Date | null;
    created_at: string | Date;
  }>(
    db,
    sql`
      SELECT id, type, title, body, link_url, read_at, created_at
      FROM notifications
      WHERE user_id = ${userId}
        ${options.unreadOnly ? sql`AND read_at IS NULL` : sql``}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
  );

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    linkUrl: r.link_url,
    readAt: r.read_at ? new Date(r.read_at) : null,
    createdAt: new Date(r.created_at),
  }));
}
