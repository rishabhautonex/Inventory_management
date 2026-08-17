"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { notifications } from "@/db/schema";
import { getSessionUser } from "@/lib/auth";

export type Result = { ok: true } | { ok: false; error: string };

/**
 * Marks one notification read.
 *
 * Scoped to the signed-in user in the WHERE clause rather than checked first
 * and updated after: an id belonging to somebody else simply matches nothing,
 * so there is no window in which it could be read and then acted on.
 */
export async function markNotificationReadAction(
  id: string,
): Promise<Result> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Your session expired. Sign in again." };

  await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(notifications.id, id),
        eq(notifications.userId, user.id),
        isNull(notifications.readAt),
      ),
    );

  revalidatePath("/notifications");
  return { ok: true };
}

export async function markAllNotificationsReadAction(): Promise<Result> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Your session expired. Sign in again." };

  await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      and(eq(notifications.userId, user.id), isNull(notifications.readAt)),
    );

  revalidatePath("/notifications");
  return { ok: true };
}
