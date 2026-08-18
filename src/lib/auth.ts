import { cache } from "react";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { projectLeads, users } from "@/db/schema";
import { env, isAllowedEmail } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type Role = "engineer" | "project_head" | "admin" | "manager";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: Role;
  isActive: boolean;
  /** Projects this person heads. Empty for everyone except project heads. */
  leadProjectIds: string[];
};

/**
 * Current signed-in user, or null.
 *
 * Wrapped in React's `cache` so the several components that need the role
 * during one render share a single database round trip.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) return null;

  const [row] = await db.select().from(users).where(eq(users.id, authUser.id));
  if (!row || !row.isActive) return null;

  const leads = await db
    .select({ projectId: projectLeads.projectId })
    .from(projectLeads)
    .where(eq(projectLeads.userId, row.id));

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    role: row.role,
    isActive: row.isActive,
    leadProjectIds: leads.map((l) => l.projectId),
  };
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireRole(...allowed: Role[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!allowed.includes(user.role)) redirect("/?denied=1");
  return user;
}

/**
 * Creates the application user row on first sign-in, and keeps the Google
 * profile fields fresh on later ones.
 *
 * Role is deliberately never overwritten here — it is assigned by a manager
 * afterwards, and a re-sync must not quietly demote somebody back to engineer.
 */
export async function syncUserFromAuth(authUser: {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; reason: "domain" | "no_email" }> {
  const email = authUser.email?.toLowerCase();
  if (!email) return { ok: false, reason: "no_email" };
  if (!isAllowedEmail(email)) return { ok: false, reason: "domain" };

  const meta = authUser.user_metadata ?? {};
  const name =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    email.split("@")[0];
  const avatarUrl =
    (typeof meta.avatar_url === "string" && meta.avatar_url) ||
    (typeof meta.picture === "string" && meta.picture) ||
    null;
  const googleSub =
    (typeof meta.provider_id === "string" && meta.provider_id) ||
    (typeof meta.sub === "string" && meta.sub) ||
    authUser.id;

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, authUser.id));

  if (existing) {
    await db
      .update(users)
      .set({ email, name, avatarUrl, googleSub })
      .where(eq(users.id, authUser.id));
    return { ok: true };
  }

  // Somebody has to be able to hand out roles before anyone has one.
  const isBootstrapManager =
    env.BOOTSTRAP_MANAGER_EMAIL !== null &&
    email === env.BOOTSTRAP_MANAGER_EMAIL;

  await db.insert(users).values({
    id: authUser.id,
    googleSub,
    email,
    name,
    avatarUrl,
    role: isBootstrapManager ? "manager" : "engineer",
  });

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Permissions                                                                 */
/* -------------------------------------------------------------------------- */

/** Create and edit parts, create and receive orders, adjust stock, manage locations. */
export function canManageInventory(user: SessionUser): boolean {
  return user.role === "admin" || user.role === "manager";
}

/** Assign roles and project heads. */
export function canManageUsers(user: SessionUser): boolean {
  return user.role === "manager";
}

/** Approve or reject a request — only a head of that very project, or a manager. */
export function canApproveForProject(
  user: SessionUser,
  projectId: string,
): boolean {
  if (user.role === "manager") return true;
  return user.role === "project_head" && user.leadProjectIds.includes(projectId);
}

/** See a project's stock, BOM, spend and requests in full. */
export function canViewProject(user: SessionUser, projectId: string): boolean {
  if (user.role === "manager" || user.role === "admin") return true;
  return user.leadProjectIds.includes(projectId);
}

/**
 * Upload or replace a project's BOM.
 *
 * Wider than `canManageInventory` on purpose: the spec puts this in the hands
 * of "a project head or admin", and a head owns the parts list for the project
 * they run even though they may not touch the catalogue or the ledger.
 */
export function canManageProjectBom(
  user: SessionUser,
  projectId: string,
): boolean {
  if (user.role === "manager" || user.role === "admin") return true;
  return user.role === "project_head" && user.leadProjectIds.includes(projectId);
}

/**
 * Undo a movement.
 *
 * Anyone may undo their own mistake — that is what makes the toast's Undo
 * button safe to offer to every engineer. Undoing somebody else's movement is
 * limited to admins and managers.
 */
export function canUndoMovement(
  user: SessionUser,
  movement: { userId: string | null },
): boolean {
  if (movement.userId === user.id) return true;
  return user.role === "admin" || user.role === "manager";
}
