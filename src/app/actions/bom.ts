"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { bomLines, boms } from "@/db/schema";
import { runQuery } from "@/db/rows";
import {
  canManageInventory,
  canManageProjectBom,
  getSessionUser,
  type SessionUser,
} from "@/lib/auth";
import { parseBom } from "@/lib/bom-parse";
import { matchBomRows, type BomMatchedRow } from "@/lib/bom-match";
import { getBomShortfall } from "@/db/queries/bom";
import { insertOrderWithLines, resolveVendorByName } from "@/lib/orders";

/**
 * ===========================================================================
 * BOM IMPORT
 * ===========================================================================
 *
 * Two actions, and the split between them is the whole safety property — the
 * same shape the invoice intake uses, for the same reason.
 *
 * `analyse` reads a CSV or a pasted table, proposes catalogue matches, and
 * **writes nothing at all**. `commit` takes only the rows a person confirmed on
 * screen and never re-reads the uploaded text, so an edit made in the review is
 * the value that lands.
 *
 * Nothing here creates a component. The spec is explicit that unmatched rows
 * offer "create new part" rather than inventing one, because a part conjured
 * mid-import arrives with no search keywords, and an unfindable part is the one
 * failure the catalogue exists to prevent. The review screen links out to the
 * proper form instead.
 * ===========================================================================
 */

export type Result<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; error: string };

function fail(error: unknown, fallback: string): { ok: false; error: string } {
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? fallback };
  }
  const text =
    error instanceof Error ? `${error.message} ${error.cause ?? ""}` : "";
  if (/bom_lines_bom_component_key/.test(text)) {
    return {
      ok: false,
      error: "The same part is on two rows. Combine them into one line.",
    };
  }
  console.error("[bom action]", error);
  return { ok: false, error: fallback };
}

type Gate = { ok: true; user: SessionUser } | { ok: false; error: string };

/**
 * Wider than the admin gate used elsewhere: the spec puts BOM upload in the
 * hands of "a project head or admin", and a head owns the parts list for the
 * project they run.
 */
async function requireBomAccess(projectId: string): Promise<Gate> {
  const user = await getSessionUser();
  if (!user) {
    return { ok: false, error: "Your session expired. Sign in again." };
  }
  if (!canManageProjectBom(user, projectId)) {
    return {
      ok: false,
      error: "Only that project's head, or an admin, can change its BOM.",
    };
  }
  return { ok: true, user };
}

/* -------------------------------------------------------------------------- */
/* Analyse                                                                     */
/* -------------------------------------------------------------------------- */

const analyseSchema = z.object({
  projectId: z.string().uuid(),
  text: z
    .string()
    .min(1, "Paste a table or choose a CSV file first.")
    .max(500_000, "That file is too large to read in one go."),
});

export type BomDraft = {
  rows: BomMatchedRow[];
  delimiter: string;
  headerSkipped: boolean;
  droppedLines: number;
  /** Rows the reviewer must still answer before this can be saved. */
  unmatched: number;
  missingQty: number;
};

/**
 * Reads a BOM and proposes what each row means.
 *
 * Touches no table. Everything comes back to the browser for a person to check,
 * which is what the spec's review screen is for — and a row whose quantity
 * could not be read arrives with a null and a reason rather than a plausible
 * guess.
 */
export async function analyseBomAction(
  input: z.input<typeof analyseSchema>,
): Promise<Result<BomDraft>> {
  try {
    const parsed = analyseSchema.parse(input);

    const auth = await requireBomAccess(parsed.projectId);
    if (!auth.ok) return { ok: false, error: auth.error };

    const table = parseBom(parsed.text);
    if (table.rows.length === 0) {
      return {
        ok: false,
        error:
          "No part rows were found. Each row needs something identifying the part and a quantity.",
      };
    }

    const rows = await matchBomRows(db, table.rows);

    return {
      ok: true,
      data: {
        rows,
        delimiter: table.delimiter,
        headerSkipped: table.headerSkipped,
        droppedLines: table.droppedLines,
        unmatched: rows.filter((row) => row.suggestedComponentId === null).length,
        missingQty: rows.filter((row) => row.qty === null).length,
      },
    };
  } catch (error) {
    return fail(error, "That BOM could not be read.");
  }
}

/* -------------------------------------------------------------------------- */
/* Commit                                                                      */
/* -------------------------------------------------------------------------- */

const commitSchema = z.object({
  projectId: z.string().uuid(),
  name: z
    .string()
    .trim()
    .min(1, "Give the BOM a name.")
    .max(200, "Keep the name under 200 characters."),
  version: z.string().trim().max(50).nullable().optional(),
  lines: z
    .array(
      z.object({
        componentId: z.string().uuid("Every saved row needs a catalogue part."),
        qtyNeeded: z
          .number()
          .int("Quantities are whole pieces.")
          .positive("Every line needs a quantity of at least one."),
      }),
    )
    .min(1, "Confirm at least one line before saving."),
});

export type CommitBomInput = z.input<typeof commitSchema>;

/**
 * Saves the BOM the reviewer confirmed.
 *
 * Rows the reviewer skipped simply are not sent, so an import with three
 * uncatalogued parts still saves the rest — a BOM that refuses to save until
 * the whole catalogue is complete is a BOM nobody uploads.
 *
 * Two rows pointing at the same component are merged rather than rejected: a
 * spreadsheet listing the same resistor under two sub-assemblies means it needs
 * both, and the database's unique index would otherwise reject the whole
 * upload over a detail with an obvious right answer.
 */
export async function commitBomAction(
  input: CommitBomInput,
): Promise<Result<{ bomId: string; lines: number; merged: number }>> {
  try {
    const parsed = commitSchema.parse(input);

    const auth = await requireBomAccess(parsed.projectId);
    if (!auth.ok) return { ok: false, error: auth.error };

    const merged = new Map<string, number>();
    for (const line of parsed.lines) {
      merged.set(
        line.componentId,
        (merged.get(line.componentId) ?? 0) + line.qtyNeeded,
      );
    }

    const bomId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(boms)
        .values({
          projectId: parsed.projectId,
          name: parsed.name,
          version: parsed.version?.trim() || null,
          uploadedBy: auth.user.id,
        })
        .returning();

      await tx.insert(bomLines).values(
        [...merged.entries()].map(([componentId, qtyNeeded]) => ({
          bomId: row.id,
          componentId,
          qtyNeeded,
        })),
      );

      return row.id;
    });

    revalidatePath("/projects");
    revalidatePath(`/projects/${parsed.projectId}`);

    return {
      ok: true,
      data: {
        bomId,
        lines: merged.size,
        merged: parsed.lines.length - merged.size,
      },
    };
  } catch (error) {
    return fail(error, "That BOM could not be saved.");
  }
}

/* -------------------------------------------------------------------------- */
/* Removing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Deletes a BOM and its lines.
 *
 * Safe to delete outright, unlike almost everything else here: a BOM records an
 * intention and nothing downstream depends on it. Orders, requests and the
 * ledger all stand on their own, so removing a mistaken upload loses only the
 * mistake.
 */
export async function deleteBomAction(bomId: string): Promise<Result> {
  try {
    const rows = await runQuery<{ project_id: string }>(
      db,
      sql`SELECT project_id FROM boms WHERE id = ${bomId}`,
    );
    const projectId = rows[0]?.project_id;
    if (!projectId) return { ok: false, error: "That BOM no longer exists." };

    const auth = await requireBomAccess(projectId);
    if (!auth.ok) return { ok: false, error: auth.error };

    await db.delete(boms).where(eq(boms.id, bomId));

    revalidatePath("/projects");
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error, "That BOM could not be removed.");
  }
}

/* -------------------------------------------------------------------------- */
/* Ordering the gaps                                                           */
/* -------------------------------------------------------------------------- */

const orderGapsSchema = z.object({
  bomId: z.string().uuid(),
  componentIds: z.array(z.string().uuid()).min(1, "Pick at least one line."),
  vendorName: z.string().trim().max(200).nullable().optional(),
});

/**
 * The other half of the spec's one-click path: buy the gaps outright.
 *
 * Quantities are re-derived from the ledger here rather than taken from the
 * browser, exactly as the request path does. A tab left open while somebody
 * else put a delivery away would otherwise order parts that are already on the
 * shelf, and this is the screen most likely to be left open.
 *
 * What it produces is an ordinary order. Nothing becomes stock until its lines
 * are put away.
 */
export async function orderShortfallAction(
  input: z.input<typeof orderGapsSchema>,
): Promise<Result<{ orderId: string; lines: number }>> {
  try {
    const parsed = orderGapsSchema.parse(input);

    const user = await getSessionUser();
    if (!user) {
      return { ok: false, error: "Your session expired. Sign in again." };
    }
    if (!canManageInventory(user)) {
      return { ok: false, error: "Only admins and managers can order parts." };
    }

    const shortfall = await getBomShortfall(db, parsed.bomId);
    if (!shortfall) return { ok: false, error: "That BOM no longer exists." };

    const wanted = new Set(parsed.componentIds);
    const gaps = shortfall.lines.filter(
      (line) => wanted.has(line.componentId) && line.toBuy > 0,
    );

    if (gaps.length === 0) {
      return { ok: false, error: "Nothing is short on those lines any more." };
    }

    const vendorId = await resolveVendorByName(db, parsed.vendorName);

    const { orderId } = await insertOrderWithLines(
      db,
      {
        vendorId,
        projectId: shortfall.projectId,
        channel: "online",
        orderDate: new Date(),
        expectedDate: null,
        trackingNumber: null,
        trackingUrl: null,
        totalAmount: null,
        createdBy: user.id,
      },
      gaps.map((line) => ({
        componentId: line.componentId,
        qty: line.toBuy,
        unitPrice: null,
      })),
    );

    revalidatePath("/orders");
    revalidatePath(`/orders/${orderId}`);
    revalidatePath(`/projects/${shortfall.projectId}`);

    return { ok: true, data: { orderId, lines: gaps.length } };
  } catch (error) {
    return fail(error, "That order could not be created.");
  }
}
