"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { findCatalogueClashes } from "@/db/queries/components";
import { components } from "@/db/schema";
import { canManageInventory, getSessionUser } from "@/lib/auth";
import {
  parseComponents,
  type ComponentImportRow,
  type ImportField,
} from "@/lib/component-import";

/**
 * ===========================================================================
 * CATALOGUE IMPORT
 * ===========================================================================
 *
 * The spec leaves migrating the lab's existing stock out of scope but asks for
 * "a simple CSV import for components" in case some of the old lists turn out
 * usable. This is that, in the shape the invoice intake and the BOM import
 * already use:
 *
 * `analyse` reads the text, proposes rows, flags the ones the catalogue already
 * holds, and **writes nothing at all**. `commit` inserts only the rows a person
 * confirmed on screen and never re-reads the uploaded text, so an edit made in
 * the review is the value that lands.
 *
 * The rule that keeps it honest is the catalogue's own: a part exists to be
 * found. A row with no name is not saved, and `search_terms` — the field the
 * whole search rests on — is carried through from the file if it is there and
 * left blank if it is not, never filled with a copy of the name to look complete.
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

  // The unique index is on the normalised MPN, so this is the database saying
  // "you already have this part" — worth reporting as that rather than as a
  // constraint name.
  if (/components_mpn/.test(text)) {
    return {
      ok: false,
      error:
        "One of these part numbers is already in the catalogue. Untick it and save the rest.",
    };
  }

  console.error("[parts import]", error);
  return { ok: false, error: fallback };
}

async function requireAdmin() {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, error: "Your session expired. Sign in again." };
  if (!canManageInventory(user)) {
    return { ok: false as const, error: "Only admins and managers can add parts." };
  }
  return { ok: true as const, user };
}

/* -------------------------------------------------------------------------- */
/* Analyse                                                                     */
/* -------------------------------------------------------------------------- */

const analyseSchema = z.object({
  text: z
    .string()
    .min(1, "Paste a table or choose a CSV file first.")
    .max(500_000, "That file is too large to read in one go."),
});

/** One proposed row, plus what the catalogue already knows about it. */
export type ImportProposal = ComponentImportRow & {
  /** The existing part this row would duplicate, if any. */
  existing: { componentId: string; name: string; via: "mpn" | "name" } | null;
};

export type ImportDraft = {
  rows: ImportProposal[];
  delimiter: string;
  headerSkipped: boolean;
  mappedFields: ImportField[];
  unmappedHeadings: string[];
  droppedLines: number;
  /** Rows already in the catalogue — pre-unticked on the review screen. */
  duplicates: number;
  /** Rows the reviewer must name before they can be saved. */
  needName: number;
  /** Rows arriving with no keywords, which is what makes a part findable. */
  needSearchTerms: number;
};

/**
 * Reads a catalogue file and proposes what it holds.
 *
 * Touches no table. A row that already exists comes back marked rather than
 * silently skipped: the reviewer's file is the thing they are trying to
 * understand, and "12 of these 40 are already here" is the useful answer.
 */
export async function analyseComponentImportAction(
  input: z.input<typeof analyseSchema>,
): Promise<Result<ImportDraft>> {
  try {
    const parsed = analyseSchema.parse(input);

    const auth = await requireAdmin();
    if (!auth.ok) return { ok: false, error: auth.error };

    const table = parseComponents(parsed.text);
    if (table.rows.length === 0) {
      return {
        ok: false,
        error:
          "No parts were found. Each row needs at least a name; a heading row lets the other columns come across too.",
      };
    }

    const clashes = await findCatalogueClashes(db, {
      mpns: [
        ...new Set(
          table.rows.map((row) => row.mpn).filter((v): v is string => v !== null),
        ),
      ],
      names: [
        ...new Set(
          table.rows.map((row) => row.name).filter((v): v is string => v !== null),
        ),
      ],
    });

    // An MPN hit is the stronger statement, so it wins where both fire.
    const byMpn = new Map(clashes.filter((c) => c.via === "mpn").map((c) => [c.key, c]));
    const byName = new Map(clashes.filter((c) => c.via === "name").map((c) => [c.key, c]));

    const rows: ImportProposal[] = table.rows.map((row) => {
      const hit =
        (row.mpn === null ? undefined : byMpn.get(row.mpn)) ??
        (row.name === null ? undefined : byName.get(row.name)) ??
        null;

      return {
        ...row,
        existing: hit
          ? { componentId: hit.componentId, name: hit.name, via: hit.via }
          : null,
      };
    });

    return {
      ok: true,
      data: {
        rows,
        delimiter: table.delimiter,
        headerSkipped: table.headerSkipped,
        mappedFields: table.mappedFields,
        unmappedHeadings: table.unmappedHeadings,
        droppedLines: table.droppedLines,
        duplicates: rows.filter((row) => row.existing !== null).length,
        needName: rows.filter((row) => row.name === null).length,
        needSearchTerms: rows.filter((row) => row.searchTerms === null).length,
      },
    };
  } catch (error) {
    return fail(error, "That file could not be read.");
  }
}

/* -------------------------------------------------------------------------- */
/* Commit                                                                      */
/* -------------------------------------------------------------------------- */

const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

const commitSchema = z.object({
  rows: z
    .array(
      z.object({
        name: z
          .string()
          .trim()
          .min(1, "Every saved part needs a name.")
          .max(200, "Keep names under 200 characters."),
        mpn: optionalText(120),
        manufacturer: optionalText(120),
        category: optionalText(80),
        searchTerms: optionalText(2000),
        productUrl: optionalText(1000),
        datasheetUrl: optionalText(1000),
        notes: optionalText(2000),
      }),
    )
    .min(1, "Tick at least one row before saving.")
    .max(500, "Import at most 500 parts at a time."),
});

export type CommitImportInput = z.input<typeof commitSchema>;

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Creates the parts the reviewer ticked.
 *
 * One statement, so the import either lands whole or not at all — a half-imported
 * catalogue leaves somebody re-reading their own spreadsheet to work out where it
 * stopped. Rows the reviewer unticked are simply not sent, which is how an
 * already-catalogued part is skipped without the file needing to be edited.
 */
export async function commitComponentImportAction(
  input: CommitImportInput,
): Promise<Result<{ created: number }>> {
  try {
    const parsed = commitSchema.parse(input);

    const auth = await requireAdmin();
    if (!auth.ok) return { ok: false, error: auth.error };

    const created = await db
      .insert(components)
      .values(
        parsed.rows.map((row) => ({
          name: row.name,
          mpn: blankToNull(row.mpn),
          manufacturer: blankToNull(row.manufacturer),
          category: blankToNull(row.category),
          searchTerms: blankToNull(row.searchTerms),
          productUrl: blankToNull(row.productUrl),
          datasheetUrl: blankToNull(row.datasheetUrl),
          notes: blankToNull(row.notes),
          createdBy: auth.user.id,
        })),
      )
      .returning({ id: components.id });

    revalidatePath("/admin/parts");
    revalidatePath("/");

    return { ok: true, data: { created: created.length } };
  } catch (error) {
    return fail(error, "Could not save these parts.");
  }
}
