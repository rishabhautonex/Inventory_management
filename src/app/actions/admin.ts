"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import {
  components,
  locations,
  projectLeads,
  projects,
  stockThresholds,
  users,
} from "@/db/schema";
import {
  canManageInventory,
  canManageUsers,
  requireUser,
  type Role,
} from "@/lib/auth";
import { checkStockAlerts } from "@/lib/stock-alerts";

export type Result = { ok: true } | { ok: false; error: string };

function problem(error: unknown, fallback: string): Result {
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? fallback };
  }
  // Unique-violation text differs per constraint; the message is friendlier
  // than surfacing raw Postgres output to someone standing at a cupboard.
  const text = error instanceof Error ? `${error.message} ${error.cause ?? ""}` : "";
  if (/components_mpn_key/.test(text)) {
    return { ok: false, error: "A part with that MPN already exists." };
  }
  if (/projects_code_key/.test(text)) {
    return { ok: false, error: "That project code is already taken." };
  }
  console.error("[admin action]", error);
  return { ok: false, error: fallback };
}

/* -------------------------------------------------------------------------- */
/* Projects                                                                    */
/* -------------------------------------------------------------------------- */

const projectSchema = z.object({
  name: z.string().trim().min(1, "Give the project a name."),
  code: z
    .string()
    .trim()
    .min(1, "Give the project a short code.")
    .max(16, "Keep the code under 16 characters."),
});

export async function createProjectAction(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return { ok: false, error: "Only admins and managers can create projects." };
  }

  try {
    const data = projectSchema.parse(input);
    await db.insert(projects).values(data);
    revalidatePath("/admin/projects");
    return { ok: true };
  } catch (error) {
    return problem(error, "Could not create the project.");
  }
}

export async function setProjectStatusAction(
  projectId: string,
  status: "active" | "closed",
): Promise<Result> {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return { ok: false, error: "Only admins and managers can change projects." };
  }

  await db.update(projects).set({ status }).where(eq(projects.id, projectId));
  revalidatePath("/admin/projects");
  return { ok: true };
}

/** Project heads are a join table, so this adds one without displacing others. */
export async function assignProjectLeadAction(
  projectId: string,
  userId: string,
): Promise<Result> {
  const user = await requireUser();
  if (!canManageUsers(user)) {
    return { ok: false, error: "Only a manager can assign project heads." };
  }

  try {
    await db
      .insert(projectLeads)
      .values({ projectId, userId })
      .onConflictDoNothing();

    // Someone leading a project needs the role that grants approval rights,
    // but never demote an admin or manager to fit the label.
    const [target] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, userId));

    if (target?.role === "engineer") {
      await db
        .update(users)
        .set({ role: "project_head" })
        .where(eq(users.id, userId));
    }

    revalidatePath("/admin/projects");
    revalidatePath("/admin/users");
    return { ok: true };
  } catch (error) {
    return problem(error, "Could not assign that project head.");
  }
}

export async function removeProjectLeadAction(
  projectId: string,
  userId: string,
): Promise<Result> {
  const user = await requireUser();
  if (!canManageUsers(user)) {
    return { ok: false, error: "Only a manager can change project heads." };
  }

  await db
    .delete(projectLeads)
    .where(
      and(
        eq(projectLeads.projectId, projectId),
        eq(projectLeads.userId, userId),
      ),
    );

  revalidatePath("/admin/projects");
  revalidatePath("/admin/users");
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Locations                                                                   */
/* -------------------------------------------------------------------------- */

const locationSchema = z.object({
  name: z.string().trim().min(1, "Give the location a name."),
  type: z.enum(["cupboard", "shelf", "bin", "general"]),
  parentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
});

export async function createLocationAction(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return { ok: false, error: "Only admins and managers can manage locations." };
  }

  try {
    const data = locationSchema.parse(input);

    if (data.type === "general" && data.projectId) {
      return {
        ok: false,
        error: "The general shelf is shared, so it has no project.",
      };
    }
    if (data.type !== "cupboard" && data.type !== "general" && !data.parentId) {
      return { ok: false, error: "A shelf or bin needs a parent location." };
    }

    await db.insert(locations).values({
      name: data.name,
      type: data.type,
      parentId: data.parentId ?? null,
      projectId: data.type === "general" ? null : (data.projectId ?? null),
    });

    revalidatePath("/admin/locations");
    return { ok: true };
  } catch (error) {
    return problem(error, "Could not create the location.");
  }
}

export async function setLocationActiveAction(
  locationId: string,
  isActive: boolean,
): Promise<Result> {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return { ok: false, error: "Only admins and managers can manage locations." };
  }

  await db
    .update(locations)
    .set({ isActive })
    .where(eq(locations.id, locationId));

  revalidatePath("/admin/locations");
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Components                                                                  */
/* -------------------------------------------------------------------------- */

const componentSchema = z.object({
  name: z.string().trim().min(1, "Give the part a name."),
  mpn: z.string().trim().optional().nullable(),
  manufacturer: z.string().trim().optional().nullable(),
  category: z.string().trim().optional().nullable(),
  searchTerms: z.string().trim().optional().nullable(),
  productUrl: z.string().trim().url("Product link must be a URL.").or(z.literal("")).optional().nullable(),
  datasheetUrl: z.string().trim().url("Datasheet must be a URL.").or(z.literal("")).optional().nullable(),
  photoUrl: z.string().trim().url("Photo must be a URL.").or(z.literal("")).optional().nullable(),
  notes: z.string().trim().optional().nullable(),
});

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function createComponentAction(
  input: unknown,
): Promise<Result & { id?: string }> {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return { ok: false, error: "Only admins and managers can add parts." };
  }

  try {
    const data = componentSchema.parse(input);
    const [row] = await db
      .insert(components)
      .values({
        name: data.name,
        mpn: blankToNull(data.mpn),
        manufacturer: blankToNull(data.manufacturer),
        category: blankToNull(data.category),
        searchTerms: blankToNull(data.searchTerms),
        productUrl: blankToNull(data.productUrl),
        datasheetUrl: blankToNull(data.datasheetUrl),
        photoUrl: blankToNull(data.photoUrl),
        notes: blankToNull(data.notes),
        createdBy: user.id,
      })
      .returning({ id: components.id });

    revalidatePath("/admin/parts");
    return { ok: true, id: row.id };
  } catch (error) {
    return problem(error, "Could not save the part.");
  }
}

export async function updateComponentAction(
  componentId: string,
  input: unknown,
): Promise<Result> {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return { ok: false, error: "Only admins and managers can edit parts." };
  }

  try {
    const data = componentSchema.parse(input);
    await db
      .update(components)
      .set({
        name: data.name,
        mpn: blankToNull(data.mpn),
        manufacturer: blankToNull(data.manufacturer),
        category: blankToNull(data.category),
        searchTerms: blankToNull(data.searchTerms),
        productUrl: blankToNull(data.productUrl),
        datasheetUrl: blankToNull(data.datasheetUrl),
        photoUrl: blankToNull(data.photoUrl),
        notes: blankToNull(data.notes),
      })
      .where(eq(components.id, componentId));

    revalidatePath(`/parts/${componentId}`);
    revalidatePath("/admin/parts");
    return { ok: true };
  } catch (error) {
    return problem(error, "Could not save the part.");
  }
}

/** Low-stock trigger point, per component per location. */
export async function setThresholdAction(input: {
  componentId: string;
  locationId: string;
  minQty: number | null;
}): Promise<Result> {
  const user = await requireUser();
  if (!canManageInventory(user)) {
    return { ok: false, error: "Only admins and managers can set thresholds." };
  }

  if (input.minQty === null) {
    await db
      .delete(stockThresholds)
      .where(
        and(
          eq(stockThresholds.componentId, input.componentId),
          eq(stockThresholds.locationId, input.locationId),
        ),
      );
  } else {
    if (!Number.isInteger(input.minQty) || input.minQty < 0) {
      return { ok: false, error: "Minimum must be a whole number, zero or more." };
    }

    await db
      .insert(stockThresholds)
      .values({
        componentId: input.componentId,
        locationId: input.locationId,
        minQty: input.minQty,
      })
      .onConflictDoUpdate({
        target: [stockThresholds.componentId, stockThresholds.locationId],
        set: { minQty: input.minQty },
      });
  }

  // Setting a minimum above what is already on the shelf breaches it
  // immediately, with no movement involved — so the check belongs here too.
  if (input.minQty !== null) {
    await checkStockAlerts(db, input.componentId, input.locationId);
  }

  revalidatePath(`/parts/${input.componentId}`);
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Users                                                                       */
/* -------------------------------------------------------------------------- */

export async function setUserRoleAction(
  userId: string,
  role: Role,
): Promise<Result> {
  const user = await requireUser();
  if (!canManageUsers(user)) {
    return { ok: false, error: "Only a manager can assign roles." };
  }

  // Losing the last manager would leave nobody able to assign roles at all.
  if (userId === user.id && role !== "manager") {
    const managers = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "manager"), eq(users.isActive, true)));

    if (managers.length <= 1) {
      return {
        ok: false,
        error: "You are the only manager. Promote someone else first.",
      };
    }
  }

  await db.update(users).set({ role }).where(eq(users.id, userId));
  revalidatePath("/admin/users");
  return { ok: true };
}

export async function setUserActiveAction(
  userId: string,
  isActive: boolean,
): Promise<Result> {
  const user = await requireUser();
  if (!canManageUsers(user)) {
    return { ok: false, error: "Only a manager can deactivate people." };
  }
  if (userId === user.id && !isActive) {
    return { ok: false, error: "You cannot deactivate yourself." };
  }

  await db.update(users).set({ isActive }).where(eq(users.id, userId));
  revalidatePath("/admin/users");
  return { ok: true };
}
