"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { stockMovements } from "@/db/schema";
import {
  canManageInventory,
  canUndoMovement,
  getSessionUser,
} from "@/lib/auth";
import {
  LedgerError,
  adjustToCount,
  issueStock,
  recordMovement,
  reverseMovement,
} from "@/lib/ledger";
import { checkStockAlerts } from "@/lib/stock-alerts";

export type ActionResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; error: string; available?: number };

function fail(error: unknown): { ok: false; error: string; available?: number } {
  if (error instanceof LedgerError) {
    return { ok: false, error: error.message, available: error.available };
  }
  console.error("[stock action]", error);
  return { ok: false, error: "Something went wrong. Please try again." };
}

/**
 * Flow 1 — taking a part out.
 *
 * Person comes from the session and project from the cupboard, so neither is a
 * parameter. The spec is emphatic that the user is never asked for either.
 */
export async function takeOutAction(input: {
  componentId: string;
  locationId: string;
  qty: number;
}): Promise<ActionResult<{ movementId: string }>> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Your session expired. Sign in again." };

  try {
    const movement = await issueStock(db, {
      componentId: input.componentId,
      locationId: input.locationId,
      qty: input.qty,
      userId: user.id,
    });

    // After the movement, not inside it: this is what makes the shelf low.
    await checkStockAlerts(db, input.componentId, input.locationId);

    revalidatePath("/");
    revalidatePath("/log");
    revalidatePath(`/parts/${input.componentId}`);

    return { ok: true, data: { movementId: movement.id } };
  } catch (error) {
    return fail(error);
  }
}

/** Flow 4 — undo. Appends a reversal; never edits or deletes anything. */
export async function undoMovementAction(
  movementId: string,
): Promise<ActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Your session expired. Sign in again." };

  const [movement] = await db
    .select()
    .from(stockMovements)
    .where(eq(stockMovements.id, movementId));

  if (!movement) return { ok: false, error: "That movement no longer exists." };

  if (!canUndoMovement(user, movement)) {
    return {
      ok: false,
      error: "Only an admin or manager can undo someone else's movement.",
    };
  }

  try {
    await reverseMovement(db, movementId, user.id);

    // Undoing a receipt takes stock back off the shelf, so this can newly
    // breach a minimum just as an issue can.
    await checkStockAlerts(db, movement.componentId, movement.locationId);

    revalidatePath("/");
    revalidatePath("/log");
    revalidatePath(`/parts/${movement.componentId}`);

    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Admin correction of a miscount — "the shelf actually holds N".
 *
 * Recorded as `adjustment` rather than an issue or receipt, because it means
 * something different in the log and in per-project consumption history: no
 * part physically moved, the record was simply wrong.
 */
export async function setStockCountAction(input: {
  componentId: string;
  locationId: string;
  targetCount: number;
  note: string;
}): Promise<ActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Your session expired. Sign in again." };

  if (!canManageInventory(user)) {
    return { ok: false, error: "Only admins and managers can correct counts." };
  }

  if (!input.note.trim()) {
    return { ok: false, error: "Say why the count is being corrected." };
  }

  try {
    await adjustToCount(db, {
      componentId: input.componentId,
      locationId: input.locationId,
      targetCount: input.targetCount,
      userId: user.id,
      note: input.note.trim(),
    });

    await checkStockAlerts(db, input.componentId, input.locationId);

    revalidatePath("/");
    revalidatePath("/log");
    revalidatePath(`/parts/${input.componentId}`);

    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

/** Putting an unused part back. */
export async function returnStockAction(input: {
  componentId: string;
  locationId: string;
  qty: number;
  note?: string;
}): Promise<ActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Your session expired. Sign in again." };

  if (!Number.isInteger(input.qty) || input.qty <= 0) {
    return { ok: false, error: "Enter a whole number of pieces, at least 1." };
  }

  try {
    await recordMovement(db, {
      componentId: input.componentId,
      locationId: input.locationId,
      qtyDelta: input.qty,
      reason: "return",
      userId: user.id,
      note: input.note?.trim() || null,
    });

    // A return adds stock, but a partial one can still leave the shelf under
    // its minimum — and if it does, that is still worth saying.
    await checkStockAlerts(db, input.componentId, input.locationId);

    revalidatePath("/");
    revalidatePath("/log");
    revalidatePath(`/parts/${input.componentId}`);

    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
