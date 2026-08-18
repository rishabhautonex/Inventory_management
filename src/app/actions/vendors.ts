"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { runQuery } from "@/db/rows";
import { orders, vendors } from "@/db/schema";
import { canManageInventory, getSessionUser } from "@/lib/auth";

/**
 * ===========================================================================
 * VENDORS
 * ===========================================================================
 *
 * Vendors are created by name while somebody types an invoice, which is right —
 * stopping to catalogue a supplier mid-receipt is how receipts stop happening —
 * and has one consequence that needed fixing: "Robu", "robu.in" and "Robu India"
 * become three suppliers, and every spend figure is then split three ways.
 *
 * So the two writes here are rename and merge, and nothing else. There is no
 * delete: a vendor with orders behind it is part of the record, and one without
 * any is harmless. Merging is the honest way to remove a duplicate, because it
 * says where the orders went.
 * ===========================================================================
 */

export type Result<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; error: string };

async function requireAdmin() {
  const user = await getSessionUser();
  if (!user) {
    return { ok: false as const, error: "Your session expired. Sign in again." };
  }
  if (!canManageInventory(user)) {
    return {
      ok: false as const,
      error: "Only admins and managers can edit vendors.",
    };
  }
  return { ok: true as const, user };
}

function fail(error: unknown, fallback: string): { ok: false; error: string } {
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? fallback };
  }
  console.error("[vendors action]", error);
  return { ok: false, error: fallback };
}

const updateSchema = z.object({
  vendorId: z.string().uuid(),
  name: z
    .string()
    .trim()
    .min(1, "A vendor needs a name.")
    .max(200, "Keep the name under 200 characters."),
  website: z
    .string()
    .trim()
    .max(2000, "That link is too long.")
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .refine(
      (value) => value === null || /^https?:\/\/\S+$/i.test(value),
      "The website needs to start with http:// or https://.",
    ),
});

/**
 * Renames a vendor, and records its website.
 *
 * Case-insensitively unique, matching `resolveVendorByName`: that function looks
 * up `lower(name)` before creating anything, so allowing two vendors to differ
 * only in case would mean the next invoice picking one of them arbitrarily.
 */
export async function updateVendorAction(
  input: z.input<typeof updateSchema>,
): Promise<Result> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const parsed = updateSchema.parse(input);

    const clash = await runQuery<{ id: string }>(
      db,
      sql`
        SELECT id FROM vendors
        WHERE lower(name) = lower(${parsed.name}) AND id <> ${parsed.vendorId}
        LIMIT 1
      `,
    );

    if (clash[0]) {
      return {
        ok: false,
        error: "Another vendor already has that name. Merge them instead.",
      };
    }

    const updated = await db
      .update(vendors)
      .set({ name: parsed.name, website: parsed.website })
      .where(eq(vendors.id, parsed.vendorId))
      .returning({ id: vendors.id });

    if (updated.length === 0) {
      return { ok: false, error: "That vendor no longer exists." };
    }

    revalidatePath("/admin/vendors");
    revalidatePath("/orders");
    return { ok: true };
  } catch (error) {
    return fail(error, "That vendor could not be saved.");
  }
}

const mergeSchema = z.object({
  /** The duplicate, which disappears. */
  fromId: z.string().uuid(),
  /** The one to keep. */
  intoId: z.string().uuid(),
});

/**
 * Folds one vendor into another.
 *
 * Every order moves first and the duplicate is deleted second, both inside one
 * transaction — `orders.vendor_id` is `ON DELETE restrict`, so a half-done merge
 * cannot leave an order pointing at a vendor that is gone. If the delete fails the
 * reassignment rolls back with it, and the two vendors are exactly as they were.
 *
 * Orders are not rewritten in any other way. What was bought and for how much is
 * untouched; only the supplier's identity is corrected, which is the whole point
 * of calling it a duplicate.
 */
export async function mergeVendorsAction(
  input: z.input<typeof mergeSchema>,
): Promise<Result<{ movedOrders: number; name: string }>> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const parsed = mergeSchema.parse(input);

    if (parsed.fromId === parsed.intoId) {
      return { ok: false, error: "Pick two different vendors." };
    }

    const rows = await runQuery<{ id: string; name: string }>(
      db,
      sql`
        SELECT id, name FROM vendors
        WHERE id IN (${parsed.fromId}, ${parsed.intoId})
      `,
    );

    if (rows.length < 2) {
      return { ok: false, error: "One of those vendors no longer exists." };
    }

    const keep = rows.find((r) => r.id === parsed.intoId)!;

    const movedOrders = await db.transaction(async (tx) => {
      const moved = await tx
        .update(orders)
        .set({ vendorId: parsed.intoId })
        .where(eq(orders.vendorId, parsed.fromId))
        .returning({ id: orders.id });

      await tx.delete(vendors).where(eq(vendors.id, parsed.fromId));

      return moved.length;
    });

    revalidatePath("/admin/vendors");
    revalidatePath("/orders");
    return { ok: true, data: { movedOrders, name: keep.name } };
  } catch (error) {
    return fail(error, "Those vendors could not be merged.");
  }
}
