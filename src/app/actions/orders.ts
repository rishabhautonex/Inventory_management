"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { orders } from "@/db/schema";
import { getOrder, type OrderStatus } from "@/db/queries/orders";
import { insertOrderWithLines, resolveVendorByName } from "@/lib/orders";
import {
  canManageInventory,
  canViewOrder,
  getSessionUser,
  type SessionUser,
} from "@/lib/auth";
import { LedgerError, recordMovement } from "@/lib/ledger";
import { extractInvoiceText } from "@/lib/ocr";
import { suggestComponents, type LineSuggestion } from "@/lib/invoice-match";
import { checkStockAlerts } from "@/lib/stock-alerts";
import {
  readInvoiceBytes,
  signInvoiceUrl,
  storeInvoiceFile,
} from "@/lib/storage";

export type Result<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; error: string };

function fail(error: unknown, fallback: string): { ok: false; error: string } {
  if (error instanceof LedgerError) return { ok: false, error: error.message };
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? fallback };
  }
  console.error("[orders action]", error);
  return { ok: false, error: fallback };
}

/** A date input gives "YYYY-MM-DD" with no zone; read it as a Kolkata day. */
function parseLabDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00+05:30`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type AdminGate =
  | { ok: true; user: SessionUser }
  | { ok: false; error: string };

async function requireAdmin(): Promise<AdminGate> {
  const user = await getSessionUser();
  if (!user) {
    return { ok: false, error: "Your session expired. Sign in again." };
  }
  if (!canManageInventory(user)) {
    return { ok: false, error: "Only admins and managers can manage orders." };
  }
  return { ok: true, user };
}

/* -------------------------------------------------------------------------- */
/* Creating                                                                    */
/* -------------------------------------------------------------------------- */

const lineSchema = z.object({
  componentId: z.string().uuid("Pick a part for every line."),
  qty: z
    .number()
    .int("Quantities are whole pieces.")
    .positive("Every line needs at least one piece."),
  unitPrice: z.number().nonnegative().nullable(),
});

const createSchema = z.object({
  vendorName: z.string().trim().max(200).optional(),
  vendorId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable(),
  channel: z.enum(["online", "offline"]),
  orderDate: z.string().nullable().optional(),
  expectedDate: z.string().nullable().optional(),
  trackingNumber: z.string().trim().max(200).nullable().optional(),
  trackingUrl: z.string().trim().max(2000).nullable().optional(),
  totalAmount: z.number().nonnegative().nullable().optional(),
  lines: z.array(lineSchema).min(1, "An order needs at least one line."),
});

export type CreateOrderInput = z.input<typeof createSchema>;

/**
 * Creates an order and its lines. No stock moves here.
 *
 * Ordering something does not put it on a shelf, so nothing touches the ledger
 * until the `shelved` transition — see `shelveLinesAction`.
 */
export async function createOrderAction(
  input: CreateOrderInput,
): Promise<Result<{ orderId: string }>> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const parsed = createSchema.parse(input);

    // One line per part: two lines for the same component would each need their
    // own receipt and make "how much of this line is shelved" ambiguous.
    const ids = parsed.lines.map((l) => l.componentId);
    if (new Set(ids).size !== ids.length) {
      return {
        ok: false,
        error: "The same part appears twice. Combine the quantities into one line.",
      };
    }

    const vendorId =
      parsed.vendorId ?? (await resolveVendorByName(db, parsed.vendorName));

    const { orderId } = await insertOrderWithLines(
      db,
      {
        vendorId,
        projectId: parsed.projectId,
        channel: parsed.channel,
        orderDate: parseLabDate(parsed.orderDate),
        expectedDate: parseLabDate(parsed.expectedDate),
        trackingNumber: parsed.trackingNumber?.trim() || null,
        trackingUrl: parsed.trackingUrl?.trim() || null,
        totalAmount: parsed.totalAmount ?? null,
        createdBy: auth.user.id,
      },
      parsed.lines,
    );

    revalidatePath("/orders");
    return { ok: true, data: { orderId } };
  } catch (error) {
    return fail(error, "The order could not be created.");
  }
}

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `shelved` is deliberately absent from every list.
 *
 * It is not a button — it is what becomes true once every line has been put
 * away, and it is set by `shelveLinesAction`. Offering it here would let an
 * order be marked shelved with no receipts behind it, which is exactly the
 * disagreement between the record and the shelf that this design exists to
 * prevent.
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  ordered: ["shipped", "delivered", "cancelled"],
  shipped: ["delivered", "cancelled"],
  delivered: [],
  shelved: [],
  cancelled: [],
};

export async function setOrderStatusAction(
  orderId: string,
  next: OrderStatus,
): Promise<Result> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (!order) return { ok: false, error: "That order no longer exists." };

    if (next === "shelved") {
      return {
        ok: false,
        error:
          "An order becomes shelved by putting its lines away, which is what records the stock.",
      };
    }

    if (!ALLOWED_TRANSITIONS[order.status].includes(next)) {
      return {
        ok: false,
        error: `An order that is ${order.status} cannot become ${next}.`,
      };
    }

    await db
      .update(orders)
      .set({
        status: next,
        deliveredAt:
          next === "delivered" ? (order.deliveredAt ?? new Date()) : order.deliveredAt,
      })
      .where(eq(orders.id, orderId));

    revalidatePath("/orders");
    revalidatePath(`/orders/${orderId}`);
    return { ok: true };
  } catch (error) {
    return fail(error, "The status could not be changed.");
  }
}

/* -------------------------------------------------------------------------- */
/* Shelving — the only place an order touches stock                            */
/* -------------------------------------------------------------------------- */

const shelveSchema = z.object({
  orderId: z.string().uuid(),
  allocations: z
    .array(
      z.object({
        orderLineId: z.string().uuid(),
        locationId: z.string().uuid("Choose where each line is going."),
        qty: z.number().int().positive(),
      }),
    )
    .min(1, "Nothing was selected to put away."),
});

export type ShelveInput = z.input<typeof shelveSchema>;

/**
 * Puts some or all of an order's lines onto shelves.
 *
 * One `receipt` movement per allocation, through `recordMovement` like every
 * other stock change, carrying `order_line_id` so the ledger row and the
 * purchase stay joined. Receiving can be partial: the order only becomes
 * `shelved` once every line's full quantity has arrived, and because that is
 * derived from the ledger, undoing a receipt reopens the line on its own.
 */
export async function shelveLinesAction(
  input: ShelveInput,
): Promise<Result<{ shelvedComplete: boolean }>> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const parsed = shelveSchema.parse(input);

    const order = await getOrder(db, parsed.orderId);
    if (!order) return { ok: false, error: "That order no longer exists." };

    if (order.status === "cancelled") {
      return { ok: false, error: "This order was cancelled." };
    }
    if (order.status === "shelved") {
      return { ok: false, error: "Every line on this order is already put away." };
    }

    // An online order should have reached reception before anything is put
    // away; an offline purchase is carried in by hand and skips straight there.
    if (order.channel === "online" && order.status !== "delivered") {
      return {
        ok: false,
        error:
          "Mark the order delivered first — that is the point at which the box has actually arrived.",
      };
    }

    const byId = new Map(order.lines.map((line) => [line.id, line]));

    for (const allocation of parsed.allocations) {
      const line = byId.get(allocation.orderLineId);
      if (!line) {
        return { ok: false, error: "One of those lines is not on this order." };
      }
      if (allocation.qty > line.remainingQty) {
        return {
          ok: false,
          error: `${line.componentName}: only ${line.remainingQty} of ${line.qty} still to come.`,
        };
      }
    }

    // Sequential rather than concurrent: each call takes an advisory lock on its
    // component+location, and two allocations landing in the same bin would
    // otherwise contend for it.
    for (const allocation of parsed.allocations) {
      const line = byId.get(allocation.orderLineId);
      if (!line) continue;

      await recordMovement(db, {
        componentId: line.componentId,
        locationId: allocation.locationId,
        qtyDelta: allocation.qty,
        reason: "receipt",
        userId: auth.user.id,
        orderLineId: line.id,
      });
    }

    // Re-read rather than compute: shelved quantities come from the ledger, and
    // this is the same derivation the detail page will show.
    const after = await getOrder(db, parsed.orderId);
    const complete =
      after !== null && after.lines.every((line) => line.remainingQty === 0);

    if (complete) {
      await db
        .update(orders)
        .set({
          status: "shelved",
          shelvedAt: new Date(),
          deliveredAt: order.deliveredAt ?? new Date(),
        })
        .where(eq(orders.id, parsed.orderId));
    }

    for (const allocation of parsed.allocations) {
      const line = byId.get(allocation.orderLineId);
      if (line) {
        await checkStockAlerts(db, line.componentId, allocation.locationId);
      }
    }

    revalidatePath("/orders");
    revalidatePath(`/orders/${parsed.orderId}`);
    revalidatePath("/log");
    revalidatePath("/dashboard");

    return { ok: true, data: { shelvedComplete: complete } };
  } catch (error) {
    return fail(error, "The stock could not be recorded.");
  }
}

/* -------------------------------------------------------------------------- */
/* Invoice                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Stores an uploaded invoice against an order.
 *
 * The original file is kept exactly as uploaded and text extraction is a
 * separate step, so a slow or failed OCR pass never costs somebody their upload.
 */
export async function uploadInvoiceAction(formData: FormData): Promise<Result> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const orderId = String(formData.get("orderId") ?? "");
    const file = formData.get("file");

    if (!z.string().uuid().safeParse(orderId).success) {
      return { ok: false, error: "That order could not be identified." };
    }
    if (!(file instanceof File)) {
      return { ok: false, error: "Choose a file to upload." };
    }

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (!order) return { ok: false, error: "That order no longer exists." };

    const stored = await storeInvoiceFile(orderId, file);
    if (!stored.ok) return { ok: false, error: stored.error };

    await db
      .update(orders)
      .set({
        invoiceFileUrl: stored.data.path,
        invoiceMime: stored.data.mime,
        // A new file makes the old text wrong; clear it rather than leave a
        // stale blob that would match searches against the previous invoice.
        invoiceOcrText: null,
      })
      .where(eq(orders.id, orderId));

    revalidatePath(`/orders/${orderId}`);
    return { ok: true };
  } catch (error) {
    return fail(error, "The invoice could not be uploaded.");
  }
}

/**
 * Runs text extraction over a stored invoice and saves the result.
 *
 * Separate from the upload and triggered from the client, because tesseract on a
 * multi-page scan takes seconds and there is no reason to make somebody watch a
 * spinner for it. Failure is reported, not thrown: the file is still stored, it
 * is simply not searchable.
 */
export async function extractInvoiceTextAction(
  orderId: string,
): Promise<Result<{ characters: number; method: string; note: string | null }>> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (!order) return { ok: false, error: "That order no longer exists." };
    if (!order.invoiceFileUrl) {
      return { ok: false, error: "There is no invoice on this order yet." };
    }

    const bytes = await readInvoiceBytes(order.invoiceFileUrl);
    if (!bytes) {
      return { ok: false, error: "The stored invoice could not be read back." };
    }

    const outcome = await extractInvoiceText(
      bytes,
      order.invoiceMime ?? "application/octet-stream",
    );

    await db
      .update(orders)
      .set({ invoiceOcrText: outcome.text || null })
      .where(eq(orders.id, orderId));

    revalidatePath(`/orders/${orderId}`);

    return {
      ok: true,
      data: {
        characters: outcome.text.length,
        method: outcome.method,
        note: outcome.note,
      },
    };
  } catch (error) {
    return fail(error, "Text extraction failed.");
  }
}

/**
 * A short-lived URL for viewing the stored invoice.
 *
 * The only order action a project head may call, and the check is therefore
 * `canViewOrder` against the order's own project rather than the admin gate the
 * writes use. The bill is the evidence behind the spend figure on their project
 * page, and the spec gives them that figure.
 */
export async function getInvoiceUrlAction(
  orderId: string,
): Promise<Result<{ url: string }>> {
  const user = await getSessionUser();
  if (!user) {
    return { ok: false, error: "Your session expired. Sign in again." };
  }

  try {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));

    // Same answer whether the order is missing or simply not theirs — a
    // distinct "not allowed" would confirm the order exists.
    if (!order || !canViewOrder(user, order.projectId)) {
      return { ok: false, error: "That order could not be found." };
    }

    if (!order.invoiceFileUrl) {
      return { ok: false, error: "There is no invoice on this order yet." };
    }

    const url = await signInvoiceUrl(order.invoiceFileUrl);
    if (!url) return { ok: false, error: "The invoice link could not be created." };

    return { ok: true, data: { url } };
  } catch (error) {
    return fail(error, "The invoice link could not be created.");
  }
}

/**
 * Catalogue matches suggested from the invoice text.
 *
 * Returns suggestions and nothing else — no order lines are created here. The
 * spec forbids populating lines from OCR, and this is the shape that respects
 * that while still saving the admin from typing part names they can confirm.
 */
export async function suggestFromInvoiceAction(
  orderId: string,
): Promise<Result<{ suggestions: LineSuggestion[] }>> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (!order) return { ok: false, error: "That order no longer exists." };

    if (!order.invoiceOcrText) {
      return {
        ok: false,
        error: "Read the invoice text first — there is nothing to match against yet.",
      };
    }

    const suggestions = await suggestComponents(db, order.invoiceOcrText);
    return { ok: true, data: { suggestions } };
  } catch (error) {
    return fail(error, "Matches could not be worked out.");
  }
}
