import {
  isNumericCell,
  normaliseHeading,
  readTable,
  type DelimiterName,
} from "@/lib/table-parse";

/**
 * ===========================================================================
 * CATALOGUE IMPORT
 * ===========================================================================
 *
 * The spec keeps migration of the lab's existing stock out of scope — it is
 * scattered and messy, and admins will add parts as they meet them — but asks
 * for one thing in case some of it turns out usable: "a simple CSV import for
 * components". This reads it.
 *
 * It is the BOM import's shape, deliberately: read and propose, write nothing,
 * and let a person confirm on screen. What differs is the question. A BOM row is
 * a quantity that arithmetic can check; a catalogue row is eight free-text
 * columns that nothing can check, so the only safe reading is the one the file
 * actually labels.
 *
 * Hence the rule here: **a column nobody named is a column nobody imported.**
 * With a heading row the columns are mapped by name; without one, every line is
 * read as a bare part name and the row says so. Guessing that the third column
 * is a manufacturer would fill the catalogue with fields no one typed, and an
 * unfindable part is exactly what the catalogue exists to prevent.
 * ===========================================================================
 */

export type ComponentImportRow = {
  /** 1-based line number in the input, for pointing at a bad row. */
  lineNumber: number;
  /** The line exactly as it arrived, so the reviewer can compare. */
  raw: string;
  /** Null when the file carried no name for this row — never invented. */
  name: string | null;
  mpn: string | null;
  manufacturer: string | null;
  category: string | null;
  /** The keyword bag that makes a part findable. */
  searchTerms: string | null;
  productUrl: string | null;
  datasheetUrl: string | null;
  notes: string | null;
  /** Reviewer-facing warnings: a missing name, a dropped field, a repeat. */
  problems: string[];
};

export type ComponentImportResult = {
  rows: ComponentImportRow[];
  delimiter: DelimiterName;
  /** True when the first line was consumed as column headings. */
  headerSkipped: boolean;
  /** Which fields the heading row actually named, in file order. */
  mappedFields: ImportField[];
  /** Headings that matched no field, so nothing vanishes silently. */
  unmappedHeadings: string[];
  /** Lines that carried no usable text at all, e.g. a totals row. */
  droppedLines: number;
};

export type ImportField =
  | "name"
  | "mpn"
  | "manufacturer"
  | "category"
  | "searchTerms"
  | "productUrl"
  | "datasheetUrl"
  | "notes";

/** Guards against somebody pasting a whole workbook. */
const MAX_ROWS = 500;

/**
 * Heading patterns, tried in this order.
 *
 * Order is the whole trick: `partnumber` contains `part`, and `datasheeturl`
 * contains `url`, so the specific patterns have to win before the general ones
 * get a look. Each column is claimed once — a file with two "name" columns fills
 * the field from the first and reports the second as unmapped rather than
 * quietly overwriting.
 */
const FIELD_PATTERNS: Array<[ImportField, RegExp]> = [
  ["mpn", /^(mpn|partnumber|partno|partcode|manufacturerpart|mfrpart|sku|orderingcode|itemcode)/],
  ["datasheetUrl", /(datasheet|specsheet|spec)/],
  ["productUrl", /(producturl|productlink|buylink|buyurl|purchaselink|storelink|shoplink|url|link)/],
  ["searchTerms", /(searchterms|searchkeywords|keywords|keyword|tags|synonyms|aliases|terms)/],
  ["manufacturer", /(manufacturer|mfr|mfg|make|brand|maker)/],
  ["category", /(category|type|group|family|class)/],
  ["notes", /(notes|note|remarks|remark|comments|comment)/],
  ["name", /(name|description|component|item|title|part|desc)/],
];

/** Field lengths that match the column widths in `components`. */
const MAX_LENGTH: Record<ImportField, number> = {
  name: 200,
  mpn: 120,
  manufacturer: 120,
  category: 80,
  searchTerms: 2000,
  productUrl: 1000,
  datasheetUrl: 1000,
  notes: 2000,
};

type ColumnMap = Partial<Record<ImportField, number>>;

/**
 * Reads column roles off a heading row, or returns null when there isn't one.
 *
 * A heading row is accepted only when it names something that identifies a part
 * — a name or an MPN. Anything less and row one is data: losing a real part to an
 * over-eager heading guess is worse than reading one row as a bare name.
 */
function readHeader(
  cells: string[],
): { columns: ColumnMap; unmapped: string[] } | null {
  const columns: ColumnMap = {};
  const unmapped: string[] = [];

  cells.forEach((cell, index) => {
    const heading = normaliseHeading(cell);
    if (heading === "") return;

    const hit = FIELD_PATTERNS.find(
      ([field, pattern]) => pattern.test(heading) && columns[field] === undefined,
    );

    if (hit) columns[hit[0]] = index;
    else unmapped.push(cell.trim());
  });

  if (columns.name === undefined && columns.mpn === undefined) return null;

  return { columns, unmapped };
}

/** A URL we are willing to put behind a link, or null and a complaint. */
function readUrl(
  value: string,
  label: string,
  problems: string[],
): string | null {
  if (value === "") return null;

  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("protocol");
    }
    return url.toString();
  } catch {
    problems.push(`Ignored ${label} "${truncate(value, 40)}" — not a web address.`);
    return null;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Trims, collapses inner whitespace, and clips to the column width. */
function readText(
  value: string | undefined,
  field: ImportField,
  problems: string[],
): string | null {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  if (cleaned === "") return null;

  if (cleaned.length > MAX_LENGTH[field]) {
    problems.push(`Shortened ${field} to ${MAX_LENGTH[field]} characters.`);
    return cleaned.slice(0, MAX_LENGTH[field]);
  }

  return cleaned;
}

/**
 * Parses a CSV file or a pasted table into proposed catalogue rows.
 *
 * Never throws and never invents. A row it could not fully read still comes
 * back, carrying its problems, so the review screen shows it as work to finish
 * rather than dropping a part somebody meant to catalogue.
 */
export function parseComponents(input: string): ComponentImportResult {
  const { lines, table, delimiter } = readTable(input);

  if (lines.length === 0) {
    return {
      rows: [],
      delimiter: "comma",
      headerSkipped: false,
      mappedFields: [],
      unmappedHeadings: [],
      droppedLines: 0,
    };
  }

  const header = readHeader(table[0]);
  const body = header ? table.slice(1) : table;
  const offset = header ? 2 : 1;

  const rows: ComponentImportRow[] = [];
  let dropped = 0;

  /** Squashed MPNs already seen in this file, for the repeat warning. */
  const seenMpn = new Map<string, number>();

  for (let i = 0; i < body.length && rows.length < MAX_ROWS; i++) {
    const cells = body[i];
    const problems: string[] = [];

    let name: string | null;
    let mpn: string | null = null;
    let manufacturer: string | null = null;
    let category: string | null = null;
    let searchTerms: string | null = null;
    let productUrl: string | null = null;
    let datasheetUrl: string | null = null;
    let notes: string | null = null;

    if (header) {
      const at = (field: ImportField) =>
        header.columns[field] === undefined
          ? null
          : readText(cells[header.columns[field] as number], field, problems);

      name = at("name");
      mpn = at("mpn");
      manufacturer = at("manufacturer");
      category = at("category");
      searchTerms = at("searchTerms");
      notes = at("notes");

      const productCell = at("productUrl");
      const datasheetCell = at("datasheetUrl");
      productUrl = productCell
        ? readUrl(productCell, "product link", problems)
        : null;
      datasheetUrl = datasheetCell
        ? readUrl(datasheetCell, "datasheet link", problems)
        : null;
    } else {
      // No heading row: the first cell with letters in it is the name, and the
      // rest of the line is left alone rather than assigned by position.
      const index = cells.findIndex(
        (cell) => cell !== "" && !isNumericCell(cell),
      );
      name = index === -1 ? null : readText(cells[index], "name", problems);

      if (cells.filter((cell) => cell !== "").length > 1) {
        problems.push(
          "Only the name was read — add a heading row to import the other columns.",
        );
      }
    }

    if (name === null && mpn === null) {
      // Nothing identifying on this line at all: a totals row, a stray note.
      dropped++;
      continue;
    }

    if (name === null) {
      problems.push("No name in the file — type one before saving.");
    }

    if (mpn !== null) {
      const squashed = mpn.toLowerCase().replace(/[^a-z0-9]/g, "");
      const earlier = seenMpn.get(squashed);
      if (earlier !== undefined) {
        problems.push(`Same part number as row ${earlier} of this file.`);
      } else {
        seenMpn.set(squashed, i + offset);
      }
    }

    rows.push({
      lineNumber: i + offset,
      raw: lines[header ? i + 1 : i],
      name,
      mpn,
      manufacturer,
      category,
      searchTerms,
      productUrl,
      datasheetUrl,
      notes,
      problems,
    });
  }

  const mappedFields = header
    ? (Object.entries(header.columns) as Array<[ImportField, number]>)
        .sort((a, b) => a[1] - b[1])
        .map(([field]) => field)
    : ["name" as ImportField];

  return {
    rows,
    delimiter,
    headerSkipped: header !== null,
    mappedFields,
    unmappedHeadings: header?.unmapped ?? [],
    droppedLines: dropped,
  };
}
