"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { partRequests } from "@/db/schema";
import { runQuery } from "@/db/rows";
import { getBomShortfall } from "@/db/queries/bom";
import {
  canApproveForProject,
  canManageInventory,
  canViewProject,
  getSessionUser,
  type SessionUser,
} from "@/lib/auth";
import { insertOrderWithLines, resolveVendorByName } from "@/lib/orders";
import {
  notifyRequestDecided,
  notifyRequestRaised,
} from "@/lib/request-alerts";

/**
 * ===========================================================================
 * PART REQUESTS
 * ===========================================================================
 *
 *   engineer raises  →  project head approves  →  admin converts to an order
 *
 * Two rules run through everything below.
 *
 * A request is a want, not stock. Nothing here touches the ledger, and nothing
 * here even creates an order until an admin says so — at which point it goes
 * through `insertOrderWithLines()` like any other purchase, so the order it
 * produces is indistinguishable from a hand-typed one and receives the same way.
 *
 * Every state change is guarded on the state it is leaving, inside the UPDATE
 * rather than checked beforehand. Two heads tapping Approve at the same moment
 * therefore produce one approval and one "already decided", instead of two
 * approvals racing over `decided_by`.
 * ===========================================================================
 */

export type Result<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; error: string };

function fail(error: unknown, fallback: string): { ok: false; error: string } {
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? fallback };
  }
  const text = error instanceof Error ? `${error.message} ${error.cause ?? ""}` : "";
  if (/part_requests_target/.test(text)) {
    return {
      ok: false,
      error: "Pick a catalogue part or describe one, but not both.",
    };
  }
  if (/part_requests_rejection_needs_note/.test(text)) {
    return { ok: false, error: "Say why it is being turned down." };
  }
  console.error("[requests action]", error);
  return { ok: false, error: fallback };
}

type Gate = { ok: true; user: SessionUser } | { ok: false; error: string };

async function requireSession(): Promise<Gate> {
  const user = await getSessionUser();
  if (!user) {
    return { ok: false, error: "Your session expired. Sign in again." };
  }
  return { ok: true, user };
}

function refresh(requestId?: string) {
  revalidatePath("/requests");
  if (requestId) revalidatePath(`/requests/${requestId}`);
  revalidatePath("/notifications");
}

/* -------------------------------------------------------------------------- */
/* Raising                                                                     */
/* -------------------------------------------------------------------------- */

const createSchema = z
  .object({
    projectId: z.string().uuid("Choose the project this is for."),
    componentId: z.string().uuid().nullable().optional(),
    freeText: z.string().trim().max(300).nullable().optional(),
    qty: z
      .number()
      .int("Quantities are whole pieces.")
      .positive("Ask for at least one."),
    reason: z.string().trim().max(1000).nullable().optional(),
  })
  .refine(
    (value) => Boolean(value.componentId) !== Boolean(value.freeText?.trim()),
    {
      message:
        "Either pick a part from the catalogue or describe what you need — not both.",
    },
  );

export type CreateRequestInput = z.input<typeof createSchema>;

/**
 * Raises a request.
 *
 * Open to every signed-in person, which is the point: an engineer standing at
 * an empty cupboard is exactly who this is for. The one thing checked beyond
 * the shape is that the project is still open, because a request against a
 * closed project has nobody left to approve it.
 */
export async function createRequestAction(
  input: CreateRequestInput,
): Promise<Result<{ requestId: string }>> {
  const auth = await requireSession();
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const parsed = createSchema.parse(input);

    const projects = await runQuery<{ status: string }>(
      db,
      sql`SELECT status FROM projects WHERE id = ${parsed.projectId}`,
    );
    if (!projects[0]) {
      return { ok: false, error: "That project no longer exists." };
    }
    if (projects[0].status !== "active") {
      return { ok: false, error: "That project is closed." };
    }

    const [row] = await db
      .insert(partRequests)
      .values({
        requestedBy: auth.user.id,
        projectId: parsed.projectId,
        componentId: parsed.componentId ?? null,
        freeText: parsed.freeText?.trim() || null,
        qty: parsed.qty,
        reason: parsed.reason?.trim() || null,
      })
      .returning();

    await notifyRequestRaised(db, row.id);

    refresh(row.id);
    revalidatePath(`/projects/${parsed.projectId}`);
    return { ok: true, data: { requestId: row.id } };
  } catch (error) {
    return fail(error, "That request could not be raised.");
  }
}

/* -------------------------------------------------------------------------- */
/* Deciding                                                                    */
/* -------------------------------------------------------------------------- */

async function readForDecision(
  requestId: string,
): Promise<{ projectId: string; status: string; qty: number } | null> {
  const rows = await runQuery<{
    project_id: string;
    status: string;
    qty: number | string;
  }>(
    db,
    sql`SELECT project_id, status, qty FROM part_requests WHERE id = ${requestId}`,
  );
  const row = rows[0];
  return row
    ? { projectId: row.project_id, status: row.status, qty: Number(row.qty) }
    : null;
}

/**
 * Approves a request, optionally for fewer than were asked for.
 *
 * "Four, not ten" is a real decision and used to have nowhere to go: the head's
 * only options were yes to the whole ask or a rejection, which sends the engineer
 * back to raise the same request again with a smaller number.
 *
 * The amendment is recorded in `approved_qty` and the ask is left alone. What was
 * wanted and what was granted are two facts, and overwriting `qty` to record the
 * second would erase the evidence that a decision happened. An approval for the
 * full amount writes nothing, so the common case stays a plain approval.
 */
export async function approveRequestAction(
  requestId: string,
  options: { qty?: number | null; note?: string | null } = {},
): Promise<Result> {
  const auth = await requireSession();
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const existing = await readForDecision(requestId);
    if (!existing) return { ok: false, error: "That request no longer exists." };

    if (!canApproveForProject(auth.user, existing.projectId)) {
      return {
        ok: false,
        error: "Only a head of that project, or a manager, can approve this.",
      };
    }

    let approvedQty: number | null = null;
    if (options.qty !== undefined && options.qty !== null) {
      if (!Number.isInteger(options.qty) || options.qty <= 0) {
        return {
          ok: false,
          error: "Approve a whole number of pieces, at least one.",
        };
      }
      // Approving exactly what was asked for is not an amendment, so it is not
      // recorded as one — otherwise every request would read "approved for 10 of
      // 10" and the badge would stop meaning anything.
      approvedQty = options.qty === existing.qty ? null : options.qty;
    }

    const updated = await db
      .update(partRequests)
      .set({
        status: "approved",
        decidedBy: auth.user.id,
        decidedAt: new Date(),
        approvedQty,
        decisionNote: options.note?.trim() || null,
      })
      .where(
        and(eq(partRequests.id, requestId), eq(partRequests.status, "pending")),
      )
      .returning({ id: partRequests.id });

    if (updated.length === 0) {
      return { ok: false, error: "That request has already been decided." };
    }

    await notifyRequestDecided(db, requestId);

    refresh(requestId);
    revalidatePath(`/projects/${existing.projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error, "That request could not be approved.");
  }
}

const rejectSchema = z.object({
  requestId: z.string().uuid(),
  note: z
    .string()
    .trim()
    .min(1, "Say why it is being turned down.")
    .max(1000, "Keep the note under 1000 characters."),
});

/**
 * Turns a request down.
 *
 * The note is not optional — the spec asks for it and the database refuses a
 * rejection without one — because "no" with no reason sends the requester
 * straight back to raise the same thing again.
 */
export async function rejectRequestAction(
  input: z.input<typeof rejectSchema>,
): Promise<Result> {
  const auth = await requireSession();
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const parsed = rejectSchema.parse(input);

    const existing = await readForDecision(parsed.requestId);
    if (!existing) return { ok: false, error: "That request no longer exists." };

    if (!canApproveForProject(auth.user, existing.projectId)) {
      return {
        ok: false,
        error: "Only a head of that project, or a manager, can decide this.",
      };
    }

    const updated = await db
      .update(partRequests)
      .set({
        status: "rejected",
        decidedBy: auth.user.id,
        decidedAt: new Date(),
        decisionNote: parsed.note,
      })
      .where(
        and(
          eq(partRequests.id, parsed.requestId),
          eq(partRequests.status, "pending"),
        ),
      )
      .returning({ id: partRequests.id });

    if (updated.length === 0) {
      return { ok: false, error: "That request has already been decided." };
    }

    await notifyRequestDecided(db, parsed.requestId);

    refresh(parsed.requestId);
    revalidatePath(`/projects/${existing.projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error, "That request could not be turned down.");
  }
}

/* -------------------------------------------------------------------------- */
/* Converting to an order                                                      */
/* -------------------------------------------------------------------------- */

const convertSchema = z.object({
  requestId: z.string().uuid(),
  vendorName: z.string().trim().max(200).nullable().optional(),
  channel: z.enum(["online", "offline"]).default("online"),
  unitPrice: z.number().nonnegative().nullable().optional(),
  expectedDate: z.string().nullable().optional(),
  /** Lets an admin buy more or less than was asked for. */
  qty: z.number().int().positive().nullable().optional(),
  /**
   * Which catalogue part to buy, for a request that was raised as free text.
   *
   * Only consulted when the request names no part of its own: a request that
   * points at one is an approval for *that* part, and quietly buying a
   * different one would overrule the decision the request exists to record.
   */
  componentId: z.string().uuid().nullable().optional(),
});

export type ConvertRequestInput = z.input<typeof convertSchema>;

/** A date input gives "YYYY-MM-DD" with no zone; read it as a Kolkata day. */
function parseLabDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00+05:30`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Turns one approved request into a purchase.
 *
 * The order it creates is an ordinary order — same table, same lines, same
 * receiving flow — so nothing downstream needs to know a request was involved.
 * The link back is `part_requests.order_id`, which is what lets the requester
 * be told when it eventually lands.
 *
 * A free-text request still cannot be converted on its own, because an order
 * line needs a real catalogue part — but the admin can now say which part it
 * turned out to be, `componentId`, catalogued from the request screen. Nothing
 * is invented here: the component already exists by the time this runs, created
 * by a person who typed its name and keywords.
 *
 * The request's own wording is left exactly as it was raised. What was asked for
 * and what was bought are two facts, and the order line records the second, so
 * `part_requests.free_text` stays the evidence of the first.
 */
export async function convertRequestToOrderAction(
  input: ConvertRequestInput,
): Promise<Result<{ orderId: string }>> {
  const auth = await requireSession();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!canManageInventory(auth.user)) {
    return { ok: false, error: "Only admins and managers can order parts." };
  }

  try {
    const parsed = convertSchema.parse(input);

    const rows = await runQuery<{
      project_id: string;
      component_id: string | null;
      qty: string | number;
      approved_qty: string | number | null;
      status: string;
    }>(
      db,
      sql`
        SELECT project_id, component_id, qty, approved_qty, status
        FROM part_requests
        WHERE id = ${parsed.requestId}
      `,
    );

    const existing = rows[0];
    if (!existing) return { ok: false, error: "That request no longer exists." };
    if (existing.status === "ordered") {
      return { ok: false, error: "That request has already been ordered." };
    }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an approved request can be ordered." };
    }
    /**
     * Which part to buy. A request that names one is an approval for that part
     * and nothing else, so a `componentId` disagreeing with it is refused
     * rather than silently ignored — being told is how somebody discovers they
     * had the wrong request open.
     */
    if (
      existing.component_id &&
      parsed.componentId &&
      parsed.componentId !== existing.component_id
    ) {
      return {
        ok: false,
        error:
          "This request asks for a particular part. Order that one, or raise a fresh request for the other.",
      };
    }

    const componentId = existing.component_id ?? parsed.componentId ?? null;
    if (!componentId) {
      return {
        ok: false,
        error:
          "This asks for something not in the catalogue yet. Catalogue the part on this screen, then order it.",
      };
    }

    /**
     * What to buy, in order of authority: the admin typing a number on the
     * order form, then the quantity the head approved, then the ask.
     *
     * Ordering the full ask when the head cut it down would quietly overrule the
     * decision this request exists to record.
     */
    const approved =
      existing.approved_qty === null ? null : Number(existing.approved_qty);
    const qty = parsed.qty ?? approved ?? Number(existing.qty);
    const vendorId = await resolveVendorByName(db, parsed.vendorName);

    const { orderId } = await insertOrderWithLines(
      db,
      {
        vendorId,
        projectId: existing.project_id,
        channel: parsed.channel,
        orderDate: new Date(),
        expectedDate: parseLabDate(parsed.expectedDate),
        trackingNumber: null,
        trackingUrl: null,
        totalAmount:
          parsed.unitPrice === null || parsed.unitPrice === undefined
            ? null
            : parsed.unitPrice * qty,
        createdBy: auth.user.id,
      },
      [{ componentId, qty, unitPrice: parsed.unitPrice ?? null }],
    );

    // Guarded on `approved` so a second click cannot attach a second order to
    // the same request and orphan the first.
    const linked = await db
      .update(partRequests)
      .set({ status: "ordered", orderId })
      .where(
        and(
          eq(partRequests.id, parsed.requestId),
          eq(partRequests.status, "approved"),
        ),
      )
      .returning({ id: partRequests.id });

    if (linked.length === 0) {
      return {
        ok: false,
        error:
          "Somebody ordered this at the same moment. Check the request before ordering again.",
      };
    }

    await notifyRequestDecided(db, parsed.requestId);

    refresh(parsed.requestId);
    revalidatePath("/orders");
    revalidatePath(`/orders/${orderId}`);
    revalidatePath(`/projects/${existing.project_id}`);
    return { ok: true, data: { orderId } };
  } catch (error) {
    return fail(error, "That request could not be turned into an order.");
  }
}

/* -------------------------------------------------------------------------- */
/* Raising requests from a BOM shortfall                                       */
/* -------------------------------------------------------------------------- */

const shortfallSchema = z.object({
  bomId: z.string().uuid(),
  componentIds: z.array(z.string().uuid()).min(1, "Pick at least one line."),
});

/**
 * The BOM's "raise requests for the gaps" button.
 *
 * Quantities come from the shortfall computed on the server, never from the
 * browser: the page that offers this button is showing numbers derived from the
 * ledger, and re-deriving them here is what stops a stale tab from asking for a
 * gap that has since been filled. The client only says which lines it meant.
 *
 * Parts already fully in the cupboard are skipped rather than rejected, so a
 * partially-stale selection still does the useful part of what was asked.
 */
export async function raiseShortfallRequestsAction(
  input: z.input<typeof shortfallSchema>,
): Promise<Result<{ raised: number; skipped: number }>> {
  const auth = await requireSession();
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const parsed = shortfallSchema.parse(input);

    const shortfall = await getBomShortfall(db, parsed.bomId);
    if (!shortfall) return { ok: false, error: "That BOM no longer exists." };

    if (!canViewProject(auth.user, shortfall.projectId)) {
      return {
        ok: false,
        error: "Only that project's head, or an admin, can raise these.",
      };
    }

    const wanted = new Set(parsed.componentIds);
    const gaps = shortfall.lines.filter(
      (line) => wanted.has(line.componentId) && line.toBuy > 0,
    );

    if (gaps.length === 0) {
      return {
        ok: false,
        error: "Nothing is short on those lines any more.",
      };
    }

    const raised = await db
      .insert(partRequests)
      .values(
        gaps.map((line) => ({
          requestedBy: auth.user.id,
          projectId: shortfall.projectId,
          componentId: line.componentId,
          freeText: null,
          qty: line.toBuy,
          reason: `Short against BOM "${shortfall.name}".`,
        })),
      )
      .returning({ id: partRequests.id });

    // Notified one at a time so each carries its own part name; a single
    // "5 requests raised" tells an approver nothing about what to approve.
    for (const row of raised) await notifyRequestRaised(db, row.id);

    refresh();
    revalidatePath(`/projects/${shortfall.projectId}`);

    return {
      ok: true,
      data: { raised: gaps.length, skipped: wanted.size - gaps.length },
    };
  } catch (error) {
    return fail(error, "Those requests could not be raised.");
  }
}
