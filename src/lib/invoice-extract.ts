/**
 * ===========================================================================
 * READING FIELDS AND LINES OFF AN INVOICE
 * ===========================================================================
 *
 * This proposes. It never writes.
 *
 * Everything here feeds a review screen where a person confirms each line and
 * chooses where it goes, and only that confirmation reaches the ledger. That
 * separation is what makes extraction safe to attempt at all: a misread
 * description is obvious to someone reading the screen, and a misread quantity
 * is caught because it is shown in an editable field next to the invoice line it
 * came from.
 *
 * Two mechanisms find the quantity, in this order:
 *
 *   1. **The header row.** `# Item name HSN/ SAC Quantity Price/ Unit GST Amount`
 *      states which column is which, so there is nothing to deduce. This is the
 *      only thing that works on a real invoice whose line reads
 *      `85381010 6 ₹115.00 ₹124.20 (18%) ₹814.20`, where 6 × 115 = 690 and 690
 *      appears nowhere on the line — it is the Sub Total further down.
 *
 *   2. **Arithmetic**, when there is no usable header. Given `4 99.00 396.00`,
 *      the reading is the ordered triple where qty × rate = amount. 4 × 99 = 396
 *      holds, and 40 × 99 = 3960 does not, so "40pin" in a name can never be
 *      mistaken for a quantity.
 *
 * When neither can settle it the quantity comes back null, and the review screen
 * refuses to save until a person types one. A blank field costs a moment; a
 * confident wrong number becomes a wrong receipt and then a wrong on-hand.
 * ===========================================================================
 */

/** Words that mark a line as invoice furniture rather than a product. */
const BOILERPLATE = [
  "invoice",
  "tax invoice",
  "gst",
  "cgst",
  "sgst",
  "igst",
  "hsn",
  "sac",
  "subtotal",
  "sub total",
  "total",
  "grand total",
  "amount in words",
  "amount payable",
  "discount",
  "shipping",
  "freight",
  "courier",
  "round off",
  "rounding",
  "declaration",
  "terms",
  "condition",
  "signature",
  "signatory",
  "authorised",
  "authorized",
  "bank",
  "ifsc",
  "neft",
  "rtgs",
  "account",
  "a/c",
  "taxable",
  "comments",
  "instructions",
  "s & h",
  "s&h",
  "account no",
  "pan",
  "gstin",
  "state code",
  "place of supply",
  "billing address",
  "shipping address",
  "ship to",
  "bill to",
  "sold by",
  "customer",
  "phone",
  "mobile",
  "email",
  "website",
  "page",
  "description",
  "particulars",
  "qty",
  "quantity",
  "rate",
  "unit price",
  "date",
  "due",
  "order no",
  "order id",
  "po no",
  "awb",
  "tracking",
  "payment mode",
  "received",
  "balance",
  "pay to",
  "thank you",
  "e. & o.e",
  "computer generated",
];

const MAX_CANDIDATE_LINES = 40;

/** How many wrapped description lines may accumulate before a figures row. */
const MAX_CONTINUATION_LINES = 4;

/* -------------------------------------------------------------------------- */
/* Tokens and numbers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A token that is purely a number, with optional currency marker, Indian
 * grouping and a trailing unit.
 *
 * Crucially this rejects "40pin" and "ESP32", so a description keeps the digits
 * that belong to it. That is the whole reason for tokenising rather than running
 * one regex at the end of the line.
 */
function isNumericToken(token: string): boolean {
  return (
    /^[₹$]?\d[\d,]*(?:\.\d+)?%?$/.test(token) ||
    /^\d+(?:\.\d+)?\/-$/.test(token)
  );
}

/**
 * A parenthesised figure such as `(18%)`.
 *
 * These annotate a column rather than filling one — a GST amount printed as
 * `₹124.20 (18%)` occupies one column across two tokens. Recognising them keeps
 * the tail scan going and keeps the column count honest.
 */
function isAnnotationToken(token: string): boolean {
  return /^[([]\s*\d[\d,]*(?:\.\d+)?\s*%?\s*[)\]]$/.test(token);
}

/**
 * Unit-of-measure words that sit in the middle of the numeric columns.
 *
 * Indian invoices very often read `... 10 Nos 420.00 4200.00`. Without this the
 * tail scan stops at "Nos", the quantity is left in the description, and the two
 * remaining numbers get misread as a quantity and a total.
 */
const UNIT_TOKENS = new Set([
  "no", "nos", "num", "qty",
  "pc", "pcs", "piece", "pieces",
  "ea", "each", "unit", "units",
  "set", "sets", "pair", "pairs",
  "pkt", "pkts", "packet", "packets", "pack", "packs",
  "box", "boxes", "bag", "bags",
  "mtr", "mtrs", "meter", "meters", "metre", "metres",
  "cm", "mm", "kg", "kgs", "gm", "gms", "gram", "grams",
  "ltr", "ltrs", "litre", "litres",
  "roll", "rolls", "reel", "reels",
  "sheet", "sheets", "strip", "strips",
]);

function isUnitToken(token: string): boolean {
  return UNIT_TOKENS.has(token.toLowerCase().replace(/[.,:]+$/, ""));
}

/**
 * Markers that occupy a column without being a figure.
 *
 * Real invoices put a tick in the tax column: `10  3,800.00  x  38,000.00`. The
 * `x` is not a number and not a unit, and stopping the scan there strands the
 * quantity in the description and leaves a single figure to reason from. A dash
 * means the same thing as a zero in a column nobody filled in.
 */
const MARKER_TOKENS = new Set([
  "x", "*", "✓", "✔", "√",
  "-", "–", "—", "na", "n/a", "nil",
]);

function isMarkerToken(token: string): boolean {
  return MARKER_TOKENS.has(token.toLowerCase().replace(/[.,:]+$/, ""));
}

/** A token that fills a column but carries no value of its own. */
function isFillerToken(token: string): boolean {
  return isUnitToken(token) || isMarkerToken(token);
}

/** "1,23,456.78" -> 123456.78. Returns null for anything unparseable. */
export function parseAmount(token: string): number | null {
  const cleaned = token
    .replace(/[₹$%()[\]]|\/-$/g, "")
    .replace(/,/g, "")
    .trim();
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Joins a currency symbol to the figure it belongs to.
 *
 * `₹ 115.00` is one column printed as two tokens. Merging them before the scan
 * is what keeps the token count equal to the column count, which is the whole
 * basis of the header alignment below.
 */
function normaliseCurrencySpacing(line: string): string {
  return line
    .replace(/([₹$])\s+(?=[\d])/g, "$1")
    .replace(/\bRs\.?\s+(?=[\d])/gi, "Rs.");
}

export function splitLineTokens(line: string): {
  description: string;
  /** The trailing column tokens, fillers included, in the order printed. */
  tail: string[];
} {
  const tokens = normaliseCurrencySpacing(line.trim()).split(/\s+/);

  let boundary = tokens.length;
  while (boundary > 0) {
    const previous = tokens[boundary - 1];

    if (isNumericToken(previous) || isAnnotationToken(previous)) {
      boundary--;
      continue;
    }

    if (
      isFillerToken(previous) &&
      boundary >= 2 &&
      isNumericToken(tokens[boundary - 2])
    ) {
      boundary -= 2;
      continue;
    }

    break;
  }

  return {
    description: tokens
      .slice(0, boundary)
      .join(" ")
      .replace(/[|:;,\-–—\s]+$/, "")
      .trim(),
    tail: tokens.slice(boundary),
  };
}

/**
 * The tail as one slot per column.
 *
 * A figure becomes its value, a filler becomes `null` — the column exists but is
 * empty — and an annotation like `(18%)` disappears, because it shares a column
 * with the figure before it. Getting this count right is what lets the header
 * row be trusted.
 */
function tailSlots(tail: string[]): Array<number | null> {
  const slots: Array<number | null> = [];

  for (const token of tail) {
    if (isAnnotationToken(token)) continue;
    if (isFillerToken(token)) {
      slots.push(null);
      continue;
    }
    slots.push(parseAmount(token));
  }

  return slots;
}

export function splitLine(line: string): {
  description: string;
  numbers: number[];
} {
  const { description, tail } = splitLineTokens(line);

  return {
    description,
    numbers: tailSlots(tail).filter((n): n is number => n !== null),
  };
}

function looksLikeBoilerplate(line: string): boolean {
  const lower = line.toLowerCase();
  return BOILERPLATE.some((word) => lower.includes(word));
}

/* -------------------------------------------------------------------------- */
/* The items table                                                             */
/* -------------------------------------------------------------------------- */

/** The column-header row of the items table, e.g. "ITEM # DESCRIPTION QTY …". */
function isTableHeader(line: string): boolean {
  return (
    /\b(description|particulars|item|product)\b/i.test(line) &&
    /\b(qty|quantity)\b/i.test(line)
  );
}

/**
 * What a column holds.
 *
 * `text` is the description, which is variable-length in the data rows and
 * cannot be aligned against — it is the boundary between the columns that can be
 * matched and the ones that cannot. `code` covers HSN codes and serial numbers:
 * they occupy a numeric slot without being a quantity or a price, so they must be
 * counted even though nothing is read from them.
 */
export type ColumnRole = "qty" | "price" | "tax" | "amount" | "code" | "text";

/** Column labels, longest phrase first, so "unit price" beats "price". */
const COLUMN_LABELS: Array<[string[], ColumnRole]> = [
  [["taxable", "value"], "amount"],
  [["taxable", "amount"], "amount"],
  [["line", "total"], "amount"],
  [["net", "amount"], "amount"],
  [["unit", "price"], "price"],
  [["price", "unit"], "price"],
  [["unit", "rate"], "price"],
  [["rate", "per"], "price"],
  [["tax", "rate"], "tax"],
  [["item", "name"], "text"],
  [["item", "description"], "text"],
  [["item", "code"], "code"],
  [["item", "#"], "code"],
  [["part", "no"], "code"],
  [["hsn", "sac"], "code"],
  [["sl", "no"], "code"],
  [["sr", "no"], "code"],
  [["s", "no"], "code"],

  [["qty"], "qty"],
  [["quantity"], "qty"],
  [["qnty"], "qty"],
  [["nos"], "qty"],
  [["rate"], "price"],
  [["price"], "price"],
  [["mrp"], "price"],
  [["tax"], "tax"],
  [["gst"], "tax"],
  [["cgst"], "tax"],
  [["sgst"], "tax"],
  [["igst"], "tax"],
  [["vat"], "tax"],
  [["total"], "amount"],
  [["amount"], "amount"],
  [["amt"], "amount"],
  [["value"], "amount"],
  [["taxable"], "amount"],
  [["hsn"], "code"],
  [["sac"], "code"],
  [["#"], "code"],
  [["sr"], "code"],
  [["sl"], "code"],

  [["description"], "text"],
  [["particulars"], "text"],
  [["product"], "text"],
  [["goods"], "text"],
  [["item"], "text"],
  [["name"], "text"],
  [["uom"], "code"],
  [["unit"], "code"],
  [["disc"], "code"],
  [["discount"], "code"],
];

function normaliseHeaderToken(token: string): string {
  return token.toLowerCase().replace(/[.,:()/\\]/g, "").trim();
}

/**
 * Reads the header row into the ordered columns that a data row's trailing
 * tokens can be matched against.
 *
 * Only the columns *after* the description survive: anything printed before it —
 * a serial number, an item code — cannot appear in a trailing run of figures, so
 * counting it would shift every alignment by one.
 */
function headerRoles(header: string): ColumnRole[] {
  const tokens = header
    .trim()
    .split(/\s+/)
    .map(normaliseHeaderToken)
    .filter(Boolean);

  const roles: ColumnRole[] = [];
  let at = 0;

  while (at < tokens.length) {
    let matched = false;

    for (const [phrase, role] of COLUMN_LABELS) {
      if (phrase.every((word, offset) => tokens[at + offset] === word)) {
        roles.push(role);
        at += phrase.length;
        matched = true;
        break;
      }
    }

    if (!matched) {
      roles.push("text");
      at += 1;
    }
  }

  return roles;
}

export function parseHeaderColumns(header: string): ColumnRole[] {
  const roles = headerRoles(header);
  const lastText = roles.lastIndexOf("text");
  return roles.slice(lastText + 1).filter((role) => role !== "text");
}

/**
 * Whether the header prints a serial or code column *before* the description.
 *
 * That is what a leading "1 " on a description line is, and on a single-item
 * invoice there is no sequence of numbers to infer it from — so the header is the
 * only evidence available.
 */
export function headerDeclaresSerialColumn(header: string): boolean {
  const roles = headerRoles(header);
  const firstText = roles.indexOf("text");
  if (firstText <= 0) return false;
  return roles.slice(0, firstText).includes("code");
}

/**
 * The first line of the totals block.
 *
 * Nothing below this is ever a purchased item — it is subtotals, tax rows, bank
 * details and footer text. Bounding the scan here is far more reliable than
 * trying to name every kind of footer: it is what stops "Account Number -
 * 41920818356" being read as a part costing forty-one billion rupees.
 */
const TOTALS_BLOCK =
  /\b(sub[\s-]?total|taxable|grand\s+total|total|tax\s+rate|amount\s+in\s+words|amount\s+chargeable)\b/i;

function itemRegion(lines: string[]): string[] {
  const headerAt = lines.findIndex(isTableHeader);
  const body = lines.slice(headerAt === -1 ? 0 : headerAt + 1);

  const totalsAt = body.findIndex((line) => TOTALS_BLOCK.test(line));
  return totalsAt === -1 ? body : body.slice(0, totalsAt);
}

/* -------------------------------------------------------------------------- */
/* Line items                                                                  */
/* -------------------------------------------------------------------------- */

export type Confidence = "high" | "medium" | "low";

export type ExtractedLine = {
  /** The description as it appeared, for the reviewer to compare against. */
  description: string;
  /** The whole original line, so a reviewer can see what was read. */
  raw: string;
  qty: number | null;
  unitPrice: number | null;
  amount: number | null;
  confidence: Confidence;
  /** Why the reading was chosen, shown in the review screen. */
  reason: string;
};

/** 2%, or a rupee, whichever is larger — enough for rounding and paise drift. */
function multipliesOut(qty: number, rate: number, amount: number): boolean {
  return Math.abs(qty * rate - amount) <= Math.max(1, amount * 0.02);
}

function isPlausibleQty(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 100_000;
}

/**
 * Works out quantity, unit price and amount from a line's figures alone.
 *
 * Used when the invoice has no usable header. Tries every ordered triple and
 * keeps the one that multiplies out, preferring the earliest quantity because
 * that is the conventional column order.
 */
export function readLineNumbers(numbers: number[]): {
  qty: number | null;
  unitPrice: number | null;
  amount: number | null;
  confidence: Confidence;
  reason: string;
} {
  for (let i = 0; i < numbers.length; i++) {
    if (!isPlausibleQty(numbers[i])) continue;

    for (let j = i + 1; j < numbers.length; j++) {
      if (numbers[j] <= 0) continue;

      for (let k = j + 1; k < numbers.length; k++) {
        if (multipliesOut(numbers[i], numbers[j], numbers[k])) {
          return {
            qty: numbers[i],
            unitPrice: numbers[j],
            amount: numbers[k],
            confidence: "high",
            reason: `${numbers[i]} × ${numbers[j]} = ${numbers[k]}, so the quantity is ${numbers[i]}.`,
          };
        }
      }
    }
  }

  // Two columns and no third to check them against. This is genuinely
  // ambiguous: "420 4200" is 420 pieces at 10 each, or 10 pieces at 420 each,
  // and the invoice does not say which.
  if (numbers.length === 2) {
    const [first, second] = numbers;
    const alternative =
      first > 0 && second > 0 && Number.isInteger(second / first)
        ? ` It is either ${first} at ${(second / first).toFixed(2)} each, or ${(second / first).toFixed(0)} at ${first.toFixed(2)} each.`
        : "";

    return {
      qty: null,
      unitPrice: null,
      amount: Math.max(first, second),
      confidence: "low",
      reason: `This line has only two figures (${first} and ${second}) and no total to check them against, so the quantity cannot be worked out.${alternative} Enter it yourself.`,
    };
  }

  if (numbers.length === 1) {
    return {
      qty: null,
      unitPrice: null,
      amount: numbers[0],
      confidence: "low",
      reason: `Only one number (${numbers[0]}) was on this line, so the quantity could not be worked out. Enter it yourself.`,
    };
  }

  return {
    qty: null,
    unitPrice: null,
    amount: numbers.length > 0 ? Math.max(...numbers) : null,
    confidence: "low",
    reason:
      "The figures on this line did not resolve into a quantity and a price. Enter the quantity yourself.",
  };
}

/**
 * Reads a line against the header's column layout.
 *
 * Only attempted when the row has exactly as many column slots as the header has
 * matchable columns — that one-to-one correspondence is what makes the mapping
 * trustworthy. Returns null when it cannot be used, so the caller falls back to
 * inferring from arithmetic.
 */
function readByColumns(
  slots: Array<number | null>,
  columns: ColumnRole[],
): {
  qty: number | null;
  unitPrice: number | null;
  amount: number | null;
  confidence: Confidence;
  reason: string;
} | null {
  if (columns.length === 0 || slots.length !== columns.length) return null;

  const qtyAt = columns.indexOf("qty");
  if (qtyAt === -1) return null;

  const qty = slots[qtyAt];
  if (qty === null || !isPlausibleQty(qty)) return null;

  const priceAt = columns.indexOf("price");
  const unitPrice = priceAt === -1 ? null : slots[priceAt];

  // The rightmost amount column is the line's own total; an earlier one is
  // usually the taxable value.
  const amountAt = columns.lastIndexOf("amount");
  const amount = amountAt === -1 ? null : slots[amountAt];

  const figures = slots.filter((n): n is number => n !== null);

  // Cross-checked against any figure on the line, since qty × price may equal
  // the taxable value rather than the grand total. On some invoices it equals
  // neither — the sub-total lives further down the page — and that is exactly
  // when the header is the only thing that can settle the quantity.
  const confirmed =
    unitPrice !== null &&
    figures.some((figure) => multipliesOut(qty, unitPrice, figure));

  return {
    qty,
    unitPrice,
    amount: amount ?? (figures.length > 0 ? Math.max(...figures) : null),
    confidence: confirmed ? "high" : "medium",
    reason: confirmed
      ? `The invoice's quantity column says ${qty}, and ${qty} × ${unitPrice} confirms it.`
      : `Read ${qty} from the invoice's quantity column. Nothing on the line multiplies out to check it against, so it is worth a look.`,
  };
}

type ScannedLine = {
  raw: string;
  description: string;
  slots: Array<number | null>;
  numbers: number[];
};

/** A row that is nothing but a small integer — the "#" column on its own line. */
function isSerialOnlyLine(description: string, slots: Array<number | null>): boolean {
  if (description !== "" || slots.length !== 1) return false;
  const value = slots[0];
  return value !== null && Number.isInteger(value) && value >= 0 && value <= 999;
}

/**
 * Walks the lines that plausibly describe a purchased item.
 *
 * Handles the common case of a description that wraps. On a real invoice the
 * item arrives as four separate lines:
 *
 *     1
 *     INA219 BI-DIRECTIONAL
 *     CURRENT SENSOR
 *     85381010 6 ₹115.00 ₹124.20 (18%) ₹814.20
 *
 * so text-only lines are held back and joined onto the next row that carries
 * figures.
 *
 * They are *prepended* rather than used only when the figures row has no
 * description of its own, because a PDF's text layer may break the same item
 * either way. The same invoice extracts as
 *
 *     INA219 BI-DIRECTIONAL / CURRENT SENSOR / 85381010 6 ₹115.00 …
 *     INA219 BI-DIRECTIONAL / CURRENT SENSOR 85381010 6 ₹115.00 …
 *
 * and dropping the held lines in the second case loses "INA219" — the part
 * number, which is the half that matches the catalogue. Within the item region
 * a text-only line is far more likely to be a wrapped description than noise,
 * so joining is the safer default.
 */
function* scanProductLines(ocrText: string): Generator<ScannedLine> {
  const all = ocrText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const seen = new Set<string>();
  let pending: string[] = [];
  let yielded = 0;

  for (const line of itemRegion(all)) {
    if (yielded >= MAX_CANDIDATE_LINES) return;

    if (looksLikeBoilerplate(line) || /https?:\/\/|www\./i.test(line)) {
      pending = [];
      continue;
    }

    const { description, tail } = splitLineTokens(line);
    const slots = tailSlots(tail);
    const numbers = slots.filter((n): n is number => n !== null);

    if (isSerialOnlyLine(description, slots)) continue;

    // No figures: this is either a wrapped description or noise. Hold it.
    if (numbers.length === 0) {
      if (/[a-z]{3}/i.test(description) && description.length >= 3) {
        pending = [...pending, description].slice(-MAX_CONTINUATION_LINES);
      } else {
        pending = [];
      }
      continue;
    }

    const own = /[a-z]{3}/i.test(description) ? description : "";
    const named = [...pending, own].filter(Boolean).join(" ").trim();

    pending = [];

    if (named.length < 4 || !/[a-z]{3}/i.test(named)) continue;

    const key = named.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    yielded++;

    yield { raw: line, description: named, slots, numbers };
  }
}

/**
 * Whether the descriptions share a leading "Sr. No." column.
 *
 * Decided across the whole set rather than per line, and that matters: "4
 * Channel Relay Module" is a real product name, so stripping a leading digit
 * from a single line would mangle it. A serial column instead shows up as
 * several lines whose leading numbers form a run — 1, 2, 3 — and only then is it
 * safe to remove.
 */
function hasSerialColumn(
  descriptions: string[],
  headerDeclaresSerial: boolean,
): boolean {
  const leading = descriptions.map((text) => {
    const match = text.match(/^(\d{1,3})[.)]?\s+\S/);
    return match ? Number(match[1]) : null;
  });

  const numbered = leading.filter((n): n is number => n !== null);
  if (numbered.length === 0) return false;
  if (numbered.length < descriptions.length) return false;

  // A list that does not start at the top is not a serial column. This is what
  // protects a genuine product called "4 Channel Relay Module".
  if (numbered[0] > 2) return false;

  const sequential = numbered.every(
    (value, index) => index === 0 || value === numbered[index - 1] + 1,
  );
  if (!sequential) return false;

  // One number is not a sequence, so it needs the header to vouch for it.
  return numbered.length >= 2 || headerDeclaresSerial;
}

function stripSerial(description: string): string {
  return description.replace(/^\d{1,3}[.)]?\s+/, "").trim();
}

function productLines(ocrText: string): {
  lines: ScannedLine[];
  columns: ColumnRole[];
} {
  const all = ocrText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const header = all.find(isTableHeader);
  const columns = header ? parseHeaderColumns(header) : [];
  const declaresSerial = header ? headerDeclaresSerialColumn(header) : false;

  const found = [...scanProductLines(ocrText)];
  const lines = hasSerialColumn(
    found.map((line) => line.description),
    declaresSerial,
  )
    ? found.map((line) => ({
        ...line,
        description: stripSerial(line.description),
      }))
    : found;

  return { lines, columns };
}

/** Just the descriptions, for the read-only suggestion panel. */
export function candidateLines(ocrText: string): string[] {
  return productLines(ocrText)
    .lines.map((line) => line.description)
    .filter((description) => description.length >= 4);
}

export function extractLines(ocrText: string): ExtractedLine[] {
  const { lines, columns } = productLines(ocrText);

  return lines
    .filter(({ description }) => description.length >= 4)
    .map(({ raw, description, slots, numbers }) => ({
      raw,
      description,
      // The header is the invoice telling us which column is which; arithmetic
      // is only needed when it has not told us, or the row does not line up.
      ...(readByColumns(slots, columns) ?? readLineNumbers(numbers)),
    }));
}

/* -------------------------------------------------------------------------- */
/* Header fields                                                               */
/* -------------------------------------------------------------------------- */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const full = year < 100 ? 2000 + year : year;
  if (full < 2000 || full > 2100) return null;
  return `${full}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Finds a date in one line.
 *
 * Day-first where ambiguous, because the lab and its suppliers are in India.
 * A first component above 12 settles it as a day; a second above 12 settles it
 * the other way, which is how an occasional US-formatted invoice still reads
 * correctly.
 */
function findDate(line: string): string | null {
  const isoMatch = line.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (isoMatch) {
    return iso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const numeric = line.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = Number(numeric[3]);
    return b > 12 ? iso(year, a, b) : iso(year, b, a);
  }

  const dayFirst = line.match(
    /\b(\d{1,2})\s*[-\s]\s*([a-z]{3})[a-z]*\.?\s*[-,\s]\s*(\d{2,4})\b/i,
  );
  if (dayFirst) {
    const month = MONTHS[dayFirst[2].toLowerCase()];
    if (month) return iso(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }

  const monthFirst = line.match(
    /\b([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i,
  );
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    if (month) return iso(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }

  return null;
}

/** Invoice date, preferring a line that names itself as one. */
function extractDate(lines: string[]): string | null {
  const labelled = ["invoice date", "bill date", "dated", "date of issue", "date"];

  for (const label of labelled) {
    for (const line of lines) {
      const lower = line.toLowerCase();
      // A due date is a different date; do not let it win.
      if (!lower.includes(label) || lower.includes("due")) continue;
      const found = findDate(line);
      if (found) return found;
    }
  }

  for (const line of lines) {
    if (line.toLowerCase().includes("due")) continue;
    const found = findDate(line);
    if (found) return found;
  }

  return null;
}

/**
 * Total, preferring the most specific label present.
 *
 * Matched on word boundaries, not substrings, and the *last* matching line wins.
 * Both details come from real invoices: `"subtotal".includes("total")` is true,
 * and a bare "Total" appears twice — once footing the items table and again as
 * the amount actually payable, which is the one further down.
 */
const TOTAL_LABELS: RegExp[] = [
  /\bgrand\s+total\b/i,
  /\bamount\s+payable\b/i,
  /\bnet\s+payable\b/i,
  /\bnet\s+amount\b/i,
  /\binvoice\s+total\b/i,
  /\btotal\s+amount\b/i,
  /\btotal\b/i,
];

/** "Sub Total" and "Subtotal" both contain the word "total". Neither is it. */
const SUBTOTAL = /\bsub[\s-]?total\b/i;

function figuresOn(line: string): number[] {
  const { numbers } = splitLine(line);
  if (numbers.length > 0) return numbers;

  // Labels sometimes precede the figure mid-line.
  return (line.match(/[\d][\d,]*(?:\.\d+)?/g) ?? [])
    .map(parseAmount)
    .filter((n): n is number => n !== null);
}

function extractTotal(lines: string[]): number | null {
  for (const label of TOTAL_LABELS) {
    // Backwards: the payable total sits below the table's own total row.
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (!label.test(line)) continue;
      if (SUBTOTAL.test(line)) continue;

      const figures = figuresOn(line);
      if (figures.length > 0) return Math.max(...figures);
    }
  }

  return null;
}

/**
 * Where the buyer's details start.
 *
 * Everything from here down describes us, not the supplier. Without this bound
 * the search happily returns "AUTONEX AI 360 PRIVATE LIMITED" — a perfectly
 * company-shaped name that happens to be the customer.
 */
const BUYER_MARKER =
  /\b(bill\s*to|billed\s*to|ship\s*to|shipped\s*to|buyer|consignee|deliver\s*to|customer\s*(?:name|details|address))\b/i;

function sellerBlock(lines: string[]): string[] {
  const at = lines.findIndex((line) => BUYER_MARKER.test(line));
  return at === -1 ? lines.slice(0, 14) : lines.slice(0, at);
}

/** Words that make a line the supplier's trading name. */
const COMPANY_SUFFIX =
  /\b(pvt\.?\s*ltd\.?|private\s+limited|p\.?\s*ltd\.?|ltd\.?|limited|llp|inc\.?|incorporated|corp\.?|corporation|company|technologies|technology|electronics|electricals|enterprises?|industries|traders|trading|solutions|systems|instruments|labs|laboratories|robotics|automation)\b/i;

/** Address and contact lines that can otherwise look company-shaped. */
const ADDRESS_NOISE =
  /\b(road|street|floor|layout|block|sector|nagar|phase|plot|shop|building|apartments?|phone|tel|mobile|fax|gst|gstin|e-?mail|pin|\d{6})\b/i;

function cleanCompanyName(line: string): string {
  return line
    .replace(/\b(tax\s+)?invoice\b.*$/i, "")
    // "For :NEW SILIKON ELECTRONICS" is a signature block, not the name.
    .replace(/^\s*(?:for|sold\s+by|seller|supplier|vendor)\s*:?\s*/i, "")
    .replace(/^m\/s\.?\s*/i, "")
    .replace(/[|:#,\-–—\s]+$/, "")
    .trim();
}

/**
 * Vendor.
 *
 * A name already in the vendors table wins outright — it also means the order
 * attaches to the existing vendor rather than creating a near-duplicate. Failing
 * that, the supplier's trading name from the letterhead beats a website domain:
 * "Vacus Tech Pvt Ltd" is what the invoice says, while "Vacustech.com" is
 * something this code assembled from a URL.
 *
 * Every step searches only the seller block.
 */
function extractVendor(lines: string[], knownVendors: string[]): string | null {
  const seller = sellerBlock(lines);
  const sellerText = seller.join("\n").toLowerCase();

  const known = knownVendors
    .filter((name) => name.trim().length >= 3)
    .filter((name) => sellerText.includes(name.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (known) return known;

  for (const line of seller) {
    if (!COMPANY_SUFFIX.test(line)) continue;
    if (ADDRESS_NOISE.test(line)) continue;

    const name = cleanCompanyName(line);
    if (name.length >= 3 && name.length <= 120) return name;
  }

  for (const line of seller) {
    const domain = line.match(
      /\b([a-z][a-z0-9-]{1,})\.(in|com|co\.in|net|org|shop|store)\b/i,
    );
    if (domain) {
      const label = domain[1];
      return `${label[0].toUpperCase()}${label.slice(1).toLowerCase()}.${domain[2].toLowerCase()}`;
    }
  }

  for (const line of lines) {
    const labelled = line.match(
      /\b(?:sold by|seller|supplier|vendor)\s*[:\-]\s*(.+)$/i,
    );
    if (labelled) {
      const name = cleanCompanyName(labelled[1]);
      if (name.length >= 3) return name.slice(0, 120);
    }
  }

  // Last resort: the first substantial seller-block line that is not furniture.
  for (const line of seller) {
    if (looksLikeBoilerplate(line)) continue;
    if (ADDRESS_NOISE.test(line)) continue;
    if (!/[a-z]{3}/i.test(line)) continue;
    if (line.length < 3 || line.length > 60) continue;
    return cleanCompanyName(line);
  }

  return null;
}

/**
 * Tracking number.
 *
 * Keyword-driven rather than pattern-driven: every courier has its own format,
 * and a bare "looks like a reference" regex would happily return the invoice
 * number or a GSTIN. If no line says it is a tracking number, none is offered.
 */
function extractTrackingNumber(lines: string[]): string | null {
  const keywords = [
    "tracking no",
    "tracking number",
    "tracking id",
    "tracking",
    "awb no",
    "awb",
    "air waybill",
    "consignment no",
    "consignment",
    "docket no",
    "docket",
    "shipment id",
    "waybill",
  ];

  for (const keyword of keywords) {
    for (const line of lines) {
      const lower = line.toLowerCase();
      const at = lower.indexOf(keyword);
      if (at === -1) continue;

      const tail = line.slice(at + keyword.length);
      const token = tail
        .split(/\s+/)
        .map((t) => t.replace(/^[:\-#.]+/, "").replace(/[.,;]+$/, ""))
        .find(
          (t) =>
            t.length >= 8 &&
            t.length <= 25 &&
            /\d/.test(t) &&
            /^[A-Za-z0-9-]+$/.test(t),
        );

      if (token) return token;
    }
  }

  return null;
}

const COURIERS =
  /delhivery|bluedart|blue\s?dart|dtdc|shiprocket|xpressbees|ekart|gati|safexpress|india\s?post|speedpost|fedex|dhl|aramex|professional\s?courier/i;

/**
 * A tracking link, or nothing.
 *
 * There is deliberately no "first URL on the page" fallback. Most invoices carry
 * the supplier's own website, and returning `https://www.vacustech.com` as a
 * tracking link is worse than an empty field — it looks filled in, so nobody
 * checks it, and it never leads anywhere useful.
 */
function extractTrackingUrl(ocrText: string, lines: string[]): string | null {
  const normalise = (url: string) => {
    const trimmed = url.replace(/[.,;)\]]+$/, "");
    return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
  };

  const urlPattern = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi;
  const urls = ocrText.match(urlPattern) ?? [];

  const looksLikeTracking = urls.find(
    (url) => /track|awb|consign|shipment|parcel/i.test(url) || COURIERS.test(url),
  );
  if (looksLikeTracking) return normalise(looksLikeTracking);

  // A plain URL counts when its own line is about tracking.
  for (const line of lines) {
    if (!/\b(track|tracking|awb|consignment|shipment)\b/i.test(line)) continue;
    const match = line.match(urlPattern);
    if (match?.[0]) return normalise(match[0]);
  }

  return null;
}

export type ExtractedInvoice = {
  vendorName: string | null;
  invoiceDate: string | null;
  totalAmount: number | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  lines: ExtractedLine[];
};

/**
 * Everything readable off one invoice's text.
 *
 * Any field may come back null, and null is the honest answer — the review
 * screen leaves the input empty rather than pre-filling a guess the reviewer
 * would then have to notice and undo.
 */
export function extractInvoice(
  ocrText: string,
  knownVendors: string[] = [],
): ExtractedInvoice {
  const lines = ocrText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  return {
    vendorName: extractVendor(lines, knownVendors),
    invoiceDate: extractDate(lines),
    totalAmount: extractTotal(lines),
    trackingNumber: extractTrackingNumber(lines),
    trackingUrl: extractTrackingUrl(ocrText, lines),
    lines: extractLines(ocrText),
  };
}
