/**
 * ===========================================================================
 * BOM PARSING
 * ===========================================================================
 *
 * Turns a CSV file, or a table pasted straight out of a spreadsheet, into rows
 * of "what" and "how many". The spec asks for both routes, and they are the
 * same problem with a different separator: a paste from Excel is tab-delimited,
 * a saved file is comma-delimited, and a European export is semicolon-delimited.
 * The delimiter is therefore detected rather than configured — nobody standing
 * in a lab should have to know which one they have. Splitting a line and
 * choosing that delimiter live in [table-parse.ts](./table-parse.ts), shared
 * with the catalogue import so the two cannot disagree about what a cell is.
 *
 * The one rule that shapes everything here: **a quantity that could not be read
 * is `null`, never a guess.** The review screen leaves the field blank and
 * refuses to save until a person types it. The same rule governs the invoice
 * intake, and for the same reason — a number invented by a parser looks
 * identical to a number somebody checked.
 * ===========================================================================
 */

import {
  isNumericCell,
  normaliseHeading,
  readTable,
  type DelimiterName,
} from "@/lib/table-parse";

export type BomParseRow = {
  /** 1-based line number in the input, for pointing at a bad row. */
  lineNumber: number;
  /** The line exactly as it arrived, so the reviewer can compare. */
  raw: string;
  /** Name or MPN — whatever identifies the part. */
  identifier: string;
  /**
   * The other text column when the table carries both an MPN and a name.
   * Matching tries it as a fallback rather than throwing the information away.
   */
  secondary: string | null;
  /** Null when no whole positive number could be read off the row. */
  qty: number | null;
  /** Why the quantity is null, shown next to the blank field. */
  note: string | null;
};

export type BomParseResult = {
  rows: BomParseRow[];
  /** Which separator won, for the "read 14 rows, tab-separated" line. */
  delimiter: DelimiterName;
  /** True when the first line was consumed as column headings. */
  headerSkipped: boolean;
  /** Lines that carried no usable text at all, e.g. a totals row. */
  droppedLines: number;
};

/** Guards against somebody pasting a whole workbook. */
const MAX_ROWS = 500;

const QTY_HEADING = /^(qty|quantity|quantityneeded|qtyneeded|needed|need|count|pcs|nos|amount|reqd|required)/;
// Checked before the name patterns: "partnumber" contains "part".
const MPN_HEADING = /(mpn|partnumber|partno|partcode|manufacturerpart|sku|orderingcode|itemcode)/;
const NAME_HEADING = /(name|description|component|part|item|title)/;

type Columns = {
  identifier: number;
  secondary: number | null;
  qty: number | null;
};

/**
 * Reads column roles off a heading row, or returns null when there isn't one.
 *
 * A heading row is only accepted when it names a quantity column *and* names
 * something to identify the part. Anything less and the row is treated as data
 * — losing a real part to an over-eager heading guess is worse than asking the
 * reviewer to glance at row one.
 */
function readHeader(cells: string[]): Columns | null {
  const headings = cells.map(normaliseHeading);

  const qty = headings.findIndex((h) => QTY_HEADING.test(h));
  const mpn = headings.findIndex((h) => MPN_HEADING.test(h));
  const name = headings.findIndex((h) => NAME_HEADING.test(h) && !MPN_HEADING.test(h));

  if (qty === -1) return null;
  if (mpn === -1 && name === -1) return null;

  // MPN identifies a part exactly and a name only approximately, so when the
  // table offers both, the exact one leads and the name becomes the fallback.
  const identifier = mpn !== -1 ? mpn : name;
  const secondary = mpn !== -1 && name !== -1 ? name : null;

  return { identifier, secondary, qty };
}

/**
 * Reads a quantity out of a cell.
 *
 * Accepts the shapes people actually type — `12`, `12 pcs`, `1,200`, `x4` —
 * and refuses everything else rather than rounding it. A fractional quantity is
 * rejected outright: quantities in this system are whole pieces, so "2.5" is a
 * mistake worth surfacing, not something to floor.
 */
export function readQuantity(cell: string): number | null {
  const cleaned = cell
    .toLowerCase()
    .replace(/[,\s]/g, "")
    .replace(/^x/, "")
    .replace(/(pcs|pieces|piece|nos|no|units|unit|ea|each|x)$/, "");

  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;

  const value = Number(cleaned);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

/**
 * Falls back to reading a row by shape when there was no heading row.
 *
 * The quantity is taken from the *last* numeric cell rather than the first,
 * because a row like `12 ESP32 DevKit 4` puts a line number in front and the
 * quantity at the end. The identifier is the first cell with letters in it.
 */
function readByShape(cells: string[]): Columns {
  let qty: number | null = null;
  for (let i = cells.length - 1; i >= 0; i--) {
    if (isNumericCell(cells[i]) && readQuantity(cells[i]) !== null) {
      qty = i;
      break;
    }
  }

  let identifier = cells.findIndex((cell) => cell !== "" && !isNumericCell(cell));
  if (identifier === -1) identifier = 0;

  return { identifier, secondary: null, qty };
}

/**
 * Parses a CSV file or a pasted table into BOM rows.
 *
 * Never throws and never invents. Rows it could not fully read still come back,
 * carrying a note, so the review screen can show them as work to finish rather
 * than silently dropping parts somebody meant to order.
 */
export function parseBom(input: string): BomParseResult {
  const { lines, table, delimiter } = readTable(input);

  if (lines.length === 0) {
    return {
      rows: [],
      delimiter: "comma",
      headerSkipped: false,
      droppedLines: 0,
    };
  }

  const header = readHeader(table[0]);
  const body = header ? table.slice(1) : table;
  const offset = header ? 2 : 1;

  const rows: BomParseRow[] = [];
  let dropped = 0;

  for (let i = 0; i < body.length && rows.length < MAX_ROWS; i++) {
    const cells = body[i];
    const columns = header ?? readByShape(cells);

    const identifier = (cells[columns.identifier] ?? "").trim();
    if (identifier === "" || isNumericCell(identifier)) {
      // No part on this line — a totals row, a blank separator, a stray note.
      dropped++;
      continue;
    }

    const secondaryCell =
      columns.secondary === null ? null : (cells[columns.secondary] ?? "").trim();

    const qtyCell = columns.qty === null ? "" : (cells[columns.qty] ?? "").trim();
    const qty = qtyCell === "" ? null : readQuantity(qtyCell);

    rows.push({
      lineNumber: i + offset,
      raw: lines[header ? i + 1 : i],
      identifier,
      secondary: secondaryCell === "" ? null : secondaryCell,
      qty,
      note:
        qty !== null
          ? null
          : qtyCell === ""
            ? "No quantity on this row."
            : `Could not read "${qtyCell}" as a whole number of pieces.`,
    });
  }

  return {
    rows,
    delimiter,
    headerSkipped: header !== null,
    droppedLines: dropped,
  };
}
