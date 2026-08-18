"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { orders } from "@/db/schema";
import { getOrder, listVendors } from "@/db/queries/orders";
import {
  canManageInventory,
  getSessionUser,
  type SessionUser,
} from "@/lib/auth";
import { type Confidence } from "@/lib/invoice-extract";
import {
  structureInvoice,
  type ReadingSource,
} from "@/lib/invoice-structure";
import { matchDescription, type MatchCandidate } from "@/lib/invoice-match";
import { LedgerError, recordMovement } from "@/lib/ledger";
import { extractInvoiceText } from "@/lib/ocr";
import { insertOrderWithLines, resolveVendorByName } from "@/lib/orders";
import { checkStockAlerts } from "@/lib/stock-alerts";
import { promoteStagedInvoice, stageInvoiceFile } from "@/lib/storage";

/**
 * ===========================================================================
 * INVOICE INTAKE
 * ===========================================================================
 *
 * Upload an invoice, read what is on it, and let a person confirm it before any
 * of it becomes stock.
 *
 * Two actions, and the split between them is the safety property: `analyse`
 * reads and proposes and writes nothing to the database at all, while `commit`
 * takes only what the reviewer confirmed on screen. Nothing extracted reaches
 * the ledger without passing through a human's hands, which is what makes
 * extraction worth attempting at all.
 * ===========================================================================
 */

export type Result<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; error: string };

type AdminGate =
  | { ok: true; user: SessionUser }
  | { ok: false; error: string };

async function requireAdmin(): Promise<AdminGate> {
  const user = await getSessionUser();
  if (!user) {
    return { ok: false, error: "Your session expired. Sign in again." };
  }
  if (!canManageInventory(user)) {
    return { ok: false, error: "Only admins and managers can record orders." };
  }
  return { ok: true, user };
}

function fail(error: unknown, fallback: string): { ok: false; error: string } {
  if (error instanceof LedgerError) return { ok: false, error: error.message };
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? fallback };
  }
  console.error("[invoice intake]", error);
  return { ok: false, error: fallback };
}

/* -------------------------------------------------------------------------- */
/* Analyse                                                                     */
/* -------------------------------------------------------------------------- */

export type IntakeLine = {
  /** The invoice line as read, so the reviewer can compare. */
  raw: string;
  description: string;
  qty: number | null;
  unitPrice: number | null;
  amount: number | null;
  confidence: Confidence;
  reason: string;
  /** Which of the two readings proposed this line. */
  source: ReadingSource;
  /** What the other reading said, when the two disagreed on the quantity. */
  disagreement: string | null;
  /** Ranked catalogue matches; the first is pre-selected in the review. */
  matches: MatchCandidate[];
};

export type IntakeDraft = {
  stagedPath: string;
  mime: string;
  ocrText: string;
  ocrMethod: string;
  ocrNote: string | null;
  vendorName: string | null;
  invoiceDate: string | null;
  totalAmount: number | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  /** Whether the second reading ran, so the review screen can say so. */
  usedModel: boolean;
  /** Why it did not run, when it did not. */
  modelNote: string | null;
  /** Header fields the two readings did not agree on. */
  disagreements: string[];
  lines: IntakeLine[];
};

/**
 * Reads an uploaded invoice and proposes an order from it.
 *
 * Touches no table. The file is stored so the review can be committed without
 * re-uploading, and everything else comes back to the browser for a person to
 * check. A line whose numbers could not be read confidently arrives with a null
 * quantity and a reason, rather than a plausible guess.
 */
export async function analyseInvoiceAction(
  formData: FormData,
): Promise<Result<IntakeDraft>> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return { ok: false, error: "Choose an invoice file to read." };
    }

    const stored = await stageInvoiceFile(file);
    if (!stored.ok) return { ok: false, error: stored.error };

    // The bytes are already in hand, so read them here rather than downloading
    // what was just uploaded.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const outcome = await extractInvoiceText(bytes, stored.data.mime);

    if (!outcome.text) {
      return {
        ok: false,
        error:
          outcome.note ??
          "No text could be read from that file, so there is nothing to fill in. The invoice can still be attached to an order by hand.",
      };
    }

    const vendors = await listVendors(db);
    const extracted = await structureInvoice(
      outcome.text,
      vendors.map((v) => v.name),
    );

    const lines: IntakeLine[] = await Promise.all(
      extracted.lines.map(async (line) => ({
        raw: line.raw,
        description: line.description,
        qty: line.qty,
        unitPrice: line.unitPrice,
        amount: line.amount,
        confidence: line.confidence,
        reason: line.reason,
        source: line.source,
        disagreement: line.disagreement,
        matches: await matchDescription(db, line.description, 4),
      })),
    );

    return {
      ok: true,
      data: {
        stagedPath: stored.data.path,
        mime: stored.data.mime,
        ocrText: outcome.text,
        ocrMethod: outcome.method,
        ocrNote: outcome.note,
        vendorName: extracted.vendorName,
        invoiceDate: extracted.invoiceDate,
        totalAmount: extracted.totalAmount,
        trackingNumber: extracted.trackingNumber,
        trackingUrl: extracted.trackingUrl,
        usedModel: extracted.usedModel,
        modelNote: extracted.modelNote,
        disagreements: extracted.disagreements,
        lines,
      },
    };
  } catch (error) {
    return fail(error, "That invoice could not be read.");
  }
}

/* -------------------------------------------------------------------------- */
/* Commit                                                                      */
/* -------------------------------------------------------------------------- */

const commitSchema = z.object({
  stagedPath: z.string().min(1),
  mime: z.string().min(1),
  ocrText: z.string(),

  vendorName: z.string().trim().max(200).nullable(),
  projectId: z.string().uuid().nullable(),
  channel: z.enum(["online", "offline"]),
  orderDate: z.string().nullable(),
  expectedDate: z.string().nullable(),
  trackingNumber: z.string().trim().max(200).nullable(),
  trackingUrl: z.string().trim().max(2000).nullable(),
  totalAmount: z.number().nonnegative().nullable(),

  /** True when the parts are in hand and going onto shelves right now. */
  putAway: z.boolean(),

  lines: z
    .array(
      z.object({
        componentId: z.string().uuid("Choose a catalogue part for every line."),
        qty: z
          .number()
          .int("Quantities are whole pieces.")
          .positive("Every line needs a quantity of at least one."),
        unitPrice: z.number().nonnegative().nullable(),
        locationId: z.string().uuid().nullable(),
      }),
    )
    .min(1, "Confirm at least one line before saving."),
});

export type CommitIntakeInput = z.input<typeof commitSchema>;

/** A date input gives "YYYY-MM-DD" with no zone; read it as a Kolkata day. */
function parseLabDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00+05:30`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Creates the order the reviewer confirmed, and optionally puts it away.
 *
 * Only the confirmed values are used — nothing is re-read from the invoice here,
 * so an edit made on the review screen is the edit that lands. Putting away goes
 * through `recordMovement` exactly as the manual flow does; there is no second
 * write path into the ledger for this feature.
 */
export async function commitInvoiceIntakeAction(
  input: CommitIntakeInput,
): Promise<Result<{ orderId: string; putAway: boolean }>> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const parsed = commitSchema.parse(input);

    const componentIds = parsed.lines.map((line) => line.componentId);
    if (new Set(componentIds).size !== componentIds.length) {
      return {
        ok: false,
        error:
          "The same part is on two lines. Combine them into one before saving.",
      };
    }

    if (parsed.putAway && parsed.lines.some((line) => !line.locationId)) {
      return {
        ok: false,
        error: "Choose a shelf for every line, or save without putting away.",
      };
    }

    const vendorId = await resolveVendorByName(db, parsed.vendorName);

    const { orderId, lineIdByComponent } = await insertOrderWithLines(
      db,
      {
        vendorId,
        projectId: parsed.projectId,
        channel: parsed.channel,
        orderDate: parseLabDate(parsed.orderDate),
        expectedDate: parseLabDate(parsed.expectedDate),
        trackingNumber: parsed.trackingNumber || null,
        trackingUrl: parsed.trackingUrl || null,
        totalAmount: parsed.totalAmount,
        createdBy: auth.user.id,
        invoiceFileUrl: parsed.stagedPath,
        invoiceMime: parsed.mime,
        invoiceOcrText: parsed.ocrText || null,
      },
      parsed.lines.map((line) => ({
        componentId: line.componentId,
        qty: line.qty,
        unitPrice: line.unitPrice,
      })),
    );

    // Now that the order has an id, the invoice can live under it.
    const finalPath = await promoteStagedInvoice(parsed.stagedPath, orderId);
    if (finalPath !== parsed.stagedPath) {
      await db
        .update(orders)
        .set({ invoiceFileUrl: finalPath })
        .where(eq(orders.id, orderId));
    }

    if (parsed.putAway) {
      // Sequential: each call takes an advisory lock on its component+location,
      // and two lines landing in the same bin would otherwise contend.
      for (const line of parsed.lines) {
        const orderLineId = lineIdByComponent.get(line.componentId);
        if (!orderLineId || !line.locationId) continue;

        await recordMovement(db, {
          componentId: line.componentId,
          locationId: line.locationId,
          qtyDelta: line.qty,
          reason: "receipt",
          userId: auth.user.id,
          orderLineId,
        });
      }

      // Re-read rather than assume: shelved quantities come from the ledger.
      const after = await getOrder(db, orderId);
      const complete =
        after !== null && after.lines.every((line) => line.remainingQty === 0);

      const now = new Date();
      await db
        .update(orders)
        .set(
          complete
            ? { status: "shelved", deliveredAt: now, shelvedAt: now }
            : { status: "delivered", deliveredAt: now },
        )
        .where(eq(orders.id, orderId));

      for (const line of parsed.lines) {
        if (line.locationId) {
          await checkStockAlerts(db, line.componentId, line.locationId);
        }
      }
    }

    revalidatePath("/orders");
    revalidatePath(`/orders/${orderId}`);
    revalidatePath("/log");
    revalidatePath("/dashboard");
    revalidatePath("/");

    return { ok: true, data: { orderId, putAway: parsed.putAway } };
  } catch (error) {
    return fail(error, "The order could not be saved.");
  }
}
