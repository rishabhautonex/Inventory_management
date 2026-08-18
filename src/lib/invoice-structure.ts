import { z } from "zod";

import { env } from "@/lib/env";
import {
  extractInvoice,
  isPlausibleQty,
  multipliesOut,
  type Confidence,
  type ExtractedInvoice,
  type ExtractedLine,
} from "@/lib/invoice-extract";

/**
 * ===========================================================================
 * STRUCTURING AN INVOICE, READ TWICE
 * ===========================================================================
 *
 * The deterministic parser in invoice-extract.ts is precise and blind: it reads
 * the templates it was written for very well, and a supplier who prints their
 * quantity column somewhere unexpected defeats it silently. A language model is
 * the mirror image — it copes with any layout and cannot be trusted on its own,
 * because it is structuring OCR text having never seen the page behind it.
 *
 * So both read the invoice, and this module reconciles them. The useful signal
 * is not either reading but their agreement:
 *
 *   - Both found the line and agree on the quantity → `high`. Two independent
 *     readings of the same text landing on the same number is far stronger
 *     evidence than either one alone.
 *   - They disagree → the arithmetic breaks the tie, and if it cannot, the
 *     quantity is null and both readings are shown. A disagreement is exactly
 *     the case where guessing is least excusable.
 *   - Only one found the line → it is kept, capped at `medium`, and labelled.
 *     Dropping it would be worse: the parser's boilerplate filter is a substring
 *     match, so it quietly eats real parts, and those are the lines the model is
 *     most likely to be the only one to see.
 *
 * Two properties carry over from the rest of the intake flow and must not be
 * weakened here:
 *
 *   1. **This writes nothing.** It proposes, `commitInvoiceIntakeAction` takes
 *      only what the reviewer confirmed, and the ledger is reached solely
 *      through `recordMovement()`.
 *   2. **A quantity that could not be read is null.** The model is not exempt.
 *      Every number it returns goes back through `multipliesOut()`, and one the
 *      invoice's own arithmetic contradicts is discarded rather than shown as
 *      fact.
 *
 * The key is optional throughout. Without it the app behaves exactly as it did
 * before this file existed.
 * ===========================================================================
 */

/** Which reading a proposed line came from. */
export type ReadingSource = "both" | "parser" | "model";

export type ReconciledLine = ExtractedLine & {
  source: ReadingSource;
  /** Set when the two readings disagreed, describing what the other said. */
  disagreement: string | null;
};

export type ReconciledInvoice = Omit<ExtractedInvoice, "lines"> & {
  lines: ReconciledLine[];
  /** Whether the model actually contributed, so the UI can say so honestly. */
  usedModel: boolean;
  /** Why it did not, when it did not. Shown to an admin, not swallowed. */
  modelNote: string | null;
  /** Header fields the two readings did not agree on. */
  disagreements: string[];
};

export interface InvoiceStructurer {
  readonly name: string;
  /** Returns a null reading when it cannot help. Never throws. */
  structure(
    ocrText: string,
    knownVendors: string[],
  ): Promise<{ reading: ExtractedInvoice | null; note: string | null }>;
}

/* -------------------------------------------------------------------------- */
/* The model's answer, validated before it is believed                         */
/* -------------------------------------------------------------------------- */

/**
 * Deliberately permissive about types and strict about meaning.
 *
 * A model that returns the string "4" instead of the number 4 is being
 * unhelpful rather than wrong, and coercing that is cheaper than discarding a
 * whole invoice over it. What is never coerced is a missing quantity into a
 * present one.
 */
const nullableNumber = z
  .union([z.number(), z.string(), z.null()])
  .transform((value) => {
    if (value === null) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const cleaned = value.replace(/[₹$,\s]/g, "").trim();
    if (cleaned === "") return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  });

const nullableText = z.union([z.string(), z.null()]).transform((value) => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
});

const modelResponseSchema = z.object({
  vendorName: nullableText,
  invoiceDate: nullableText,
  totalAmount: nullableNumber,
  trackingNumber: nullableText,
  trackingUrl: nullableText,
  lines: z
    .array(
      z.object({
        raw: z.union([z.string(), z.null()]).optional(),
        description: z.string(),
        qty: nullableNumber,
        unitPrice: nullableNumber,
        amount: nullableNumber,
      }),
    )
    .default([]),
});

/** ISO dates only — a model that returns "12/02/2026" has not answered. */
function cleanDate(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return value;
}

/**
 * Puts the model's numbers back through the invoice's own arithmetic.
 *
 * This is the whole reason a text-only model is safe to use here. It reads OCR
 * output with no sight of the page, so a digit tesseract mangled is a digit it
 * will structure confidently and wrongly. `qty × rate = amount` is evidence the
 * model did not author, and a reading that fails it does not keep its quantity.
 */
function validateModelLine(line: {
  raw?: string | null;
  description: string;
  qty: number | null;
  unitPrice: number | null;
  amount: number | null;
}): ExtractedLine | null {
  const description = line.description.trim();
  if (description.length < 3) return null;

  const raw = line.raw?.trim() || description;
  const unitPrice = line.unitPrice;
  const amount = line.amount;
  const qty = line.qty !== null && isPlausibleQty(line.qty) ? line.qty : null;

  if (qty === null) {
    return {
      raw,
      description,
      qty: null,
      unitPrice,
      amount,
      confidence: "low",
      reason:
        line.qty === null
          ? "The model could not find a quantity on this line. Enter it yourself."
          : `The model read a quantity of ${line.qty}, which is not a whole number of pieces. Enter it yourself.`,
    };
  }

  if (unitPrice !== null && amount !== null) {
    if (multipliesOut(qty, unitPrice, amount)) {
      return {
        raw,
        description,
        qty,
        unitPrice,
        amount,
        confidence: "high",
        reason: `The model read ${qty}, and ${qty} × ${unitPrice} = ${amount} confirms it.`,
      };
    }

    // The invoice's own figures contradict the reading. Keeping the quantity
    // here is exactly the wrong-receipt failure this system exists to prevent.
    return {
      raw,
      description,
      qty: null,
      unitPrice,
      amount,
      confidence: "low",
      reason: `The model read ${qty} at ${unitPrice}, but that does not come to ${amount}. Enter the quantity yourself.`,
    };
  }

  return {
    raw,
    description,
    qty,
    unitPrice,
    amount,
    confidence: "medium",
    reason: `The model read ${qty} from this line. There is no price and total on it to check that against, so it is worth a look.`,
  };
}

/* -------------------------------------------------------------------------- */
/* DeepSeek                                                                    */
/* -------------------------------------------------------------------------- */

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

/** Generous: the text is small, but a busy endpoint must not fail an upload. */
const REQUEST_TIMEOUT_MS = 60_000;

/** OCR text is a page or two; this bounds a pathological upload's cost. */
const MAX_TEXT_CHARS = 24_000;

/** Vendor hints are a nudge, not a catalogue dump. */
const MAX_VENDOR_HINTS = 60;

const SYSTEM_PROMPT = [
  "You read the text of a supplier invoice and return it as json.",
  "",
  "The invoice comes from OCR, so it may be misaligned and columns may run",
  "together. Work out which figures are quantities, unit prices and line totals",
  "from the invoice's own layout and arithmetic.",
  "",
  "Rules, in order of importance:",
  "1. Never guess. If you cannot read a value, return null for it. A null costs",
  "   somebody ten seconds; a wrong quantity becomes wrong stock on a shelf.",
  "2. Quantities are whole numbers of pieces, never a length, weight or volume.",
  "3. Only return rows that are purchased goods. Skip subtotals, taxes, shipping",
  "   charges, discounts, round-offs, bank details, addresses and footer text.",
  "4. Keep each description exactly as printed, including part numbers and codes",
  "   such as ESP32 or 40pin. Do not tidy, expand or translate it.",
  "5. Dates must be YYYY-MM-DD. Indian invoices are day-first, so 12/02/2026 is",
  "   2026-02-12. Return the invoice date, never the due date.",
  "6. totalAmount is the amount actually payable, not the pre-tax subtotal.",
  "7. Only return a trackingNumber or trackingUrl if the invoice says that is",
  "   what it is. A supplier's own website is not a tracking link.",
  "",
  "Return only the json object, matching this shape exactly:",
  "{",
  '  "vendorName": "Rajguru Electronics Pvt Ltd",',
  '  "invoiceDate": "2026-02-12",',
  '  "totalAmount": 9523.78,',
  '  "trackingNumber": "SF1234567890IN",',
  '  "trackingUrl": "https://www.delhivery.com/track/package/SF1234567890IN",',
  '  "lines": [',
  '    { "raw": "ESP32 DevKit V1 WROOM 10 420.00 4200.00",',
  '      "description": "ESP32 DevKit V1 WROOM",',
  '      "qty": 10, "unitPrice": 420.00, "amount": 4200.00 },',
  '    { "raw": "Assorted Resistor Pack 1 - 250.00",',
  '      "description": "Assorted Resistor Pack",',
  '      "qty": null, "unitPrice": null, "amount": 250.00 }',
  "  ]",
  "}",
].join("\n");

function userPrompt(ocrText: string, knownVendors: string[]): string {
  const vendors =
    knownVendors.length > 0
      ? [
          "",
          "Suppliers already on file. If the invoice is from one of these, return",
          "its name exactly as written here so the order joins the existing record:",
          ...knownVendors
            .slice(0, MAX_VENDOR_HINTS)
            .map((name) => `- ${name}`),
        ].join("\n")
      : "";

  return [
    "Invoice text follows, between the markers.",
    vendors,
    "",
    "-----BEGIN INVOICE-----",
    ocrText.slice(0, MAX_TEXT_CHARS),
    "-----END INVOICE-----",
  ].join("\n");
}

/**
 * Turns a DeepSeek failure into something an admin can act on.
 *
 * A 402 is worth naming in particular: the platform is prepaid, and an empty
 * account fails every call with a message that says nothing about billing unless
 * somebody reads the status code.
 */
function describeFailure(status: number, body: string): string {
  if (status === 401) {
    return "DeepSeek rejected the API key, so only the built-in parser was used. Check DEEPSEEK_API_KEY in .env.local and restart the dev server.";
  }
  if (status === 402) {
    return "The DeepSeek account is out of credit, so only the built-in parser was used. Top it up at platform.deepseek.com.";
  }
  if (status === 429) {
    return "DeepSeek is rate limiting us, so only the built-in parser was used.";
  }
  if (status >= 500) {
    return "DeepSeek is unavailable, so only the built-in parser was used.";
  }
  return `DeepSeek refused the request (${status}): ${body.slice(0, 200)}`;
}

async function callDeepSeek(
  apiKey: string,
  body: unknown,
): Promise<{ content: string | null; note: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(
        "[invoice structure] deepseek returned",
        response.status,
        text.slice(0, 400),
      );
      return { content: null, note: describeFailure(response.status, text) };
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };

    return {
      content: payload.choices?.[0]?.message?.content ?? null,
      note: null,
    };
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === "AbortError";
    console.error("[invoice structure] deepseek call failed", cause);
    return {
      content: null,
      note: aborted
        ? "DeepSeek took too long, so only the built-in parser was used."
        : "DeepSeek could not be reached, so only the built-in parser was used.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The DeepSeek reading.
 *
 * `json_object` mode is prompt-guided rather than schema-constrained, and the
 * documentation is explicit that it can return empty content, so the answer is
 * validated with zod and one empty response is retried before giving up.
 */
export const deepseekStructurer: InvoiceStructurer = {
  name: "deepseek",

  async structure(ocrText, knownVendors) {
    const apiKey = env.DEEPSEEK_API_KEY;
    if (!apiKey) return { reading: null, note: null };

    const body = {
      model: env.DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(ocrText, knownVendors) },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 8000,
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const { content, note } = await callDeepSeek(apiKey, body);
      if (note) return { reading: null, note };
      // Documented failure mode: json mode can come back empty. Try once more.
      if (!content?.trim()) continue;

      try {
        const parsed = modelResponseSchema.parse(JSON.parse(content));

        const lines = parsed.lines
          .map(validateModelLine)
          .filter((line): line is ExtractedLine => line !== null);

        return {
          reading: {
            vendorName: parsed.vendorName,
            invoiceDate: cleanDate(parsed.invoiceDate),
            totalAmount: parsed.totalAmount,
            trackingNumber: parsed.trackingNumber,
            trackingUrl: parsed.trackingUrl,
            lines,
          },
          note: null,
        };
      } catch (cause) {
        console.error(
          "[invoice structure] deepseek returned unusable json",
          cause,
        );
        return {
          reading: null,
          note: "DeepSeek's answer could not be read, so only the built-in parser was used.",
        };
      }
    }

    return {
      reading: null,
      note: "DeepSeek returned an empty answer twice, so only the built-in parser was used.",
    };
  },
};

let structurer: InvoiceStructurer = deepseekStructurer;

/** Swaps the structurer. Used by tests, which must not make network calls. */
export function setInvoiceStructurer(next: InvoiceStructurer): void {
  structurer = next;
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                              */
/* -------------------------------------------------------------------------- */

/** Comparison key for a description: case, spacing and punctuation removed. */
function descriptionKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenSet(description: string): Set<string> {
  return new Set(descriptionKey(description).split(" ").filter(Boolean));
}

/**
 * Whether two descriptions name the same thing.
 *
 * The two readers rarely agree character for character — one keeps an HSN code
 * in the description, the other drops it — so exact equality would report a
 * disagreement on nearly every line. Overlap is measured against the *smaller*
 * token set, so a description one reader padded with extra tokens still matches.
 */
function sameItem(a: string, b: string): boolean {
  const keyA = descriptionKey(a);
  const keyB = descriptionKey(b);
  if (keyA === "" || keyB === "") return false;
  if (keyA === keyB) return true;
  if (keyA.includes(keyB) || keyB.includes(keyA)) return true;

  const setA = tokenSet(a);
  const setB = tokenSet(b);
  const smaller = Math.min(setA.size, setB.size);
  if (smaller === 0) return false;

  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;

  return shared / smaller >= 0.6;
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function cap(confidence: Confidence, ceiling: Confidence): Confidence {
  return RANK[confidence] > RANK[ceiling] ? ceiling : confidence;
}

/**
 * Merges the two readings of one line.
 *
 * Agreement promotes; disagreement demotes to whatever the arithmetic can prove
 * and, failing that, to nothing at all.
 */
function mergeLine(parser: ExtractedLine, model: ExtractedLine): ReconciledLine {
  // The longer description usually carries the part number, which is the half
  // that matches the catalogue.
  const description =
    model.description.length > parser.description.length
      ? model.description
      : parser.description;

  const unitPrice = parser.unitPrice ?? model.unitPrice;
  const amount = parser.amount ?? model.amount;

  if (parser.qty !== null && parser.qty === model.qty) {
    return {
      ...parser,
      description,
      unitPrice,
      amount,
      confidence: "high",
      reason: `Both readings of this line found ${parser.qty}. ${parser.reason}`,
      source: "both",
      disagreement: null,
    };
  }

  if (parser.qty === null && model.qty === null) {
    return {
      ...parser,
      description,
      unitPrice,
      amount,
      confidence: "low",
      reason: `Neither reading could settle the quantity. ${parser.reason}`,
      source: "both",
      disagreement: null,
    };
  }

  // Exactly one produced a quantity, or they produced different ones. The
  // arithmetic is the only referee neither reader authored.
  const candidates = [
    { side: "the built-in parser", line: parser },
    { side: "DeepSeek", line: model },
  ].filter((candidate) => candidate.line.qty !== null);

  const proven = candidates.filter(({ line }) => {
    const price = line.unitPrice ?? unitPrice;
    const total = line.amount ?? amount;
    return (
      line.qty !== null &&
      price !== null &&
      total !== null &&
      multipliesOut(line.qty, price, total)
    );
  });

  const summary = candidates
    .map(({ side, line }) => `${side} read ${line.qty}`)
    .join(", and ");

  if (proven.length === 1) {
    const winner = proven[0];
    return {
      ...winner.line,
      description,
      unitPrice: winner.line.unitPrice ?? unitPrice,
      amount: winner.line.amount ?? amount,
      confidence: "medium",
      reason: `The two readings differ — ${summary} — and only ${winner.side}'s reading multiplies out, so that is the one shown. Worth a look.`,
      source: "both",
      disagreement: summary,
    };
  }

  return {
    ...parser,
    description,
    qty: null,
    unitPrice,
    amount,
    confidence: "low",
    reason: `The two readings disagree — ${summary} — and the arithmetic cannot settle it. Enter the quantity yourself.`,
    source: "both",
    disagreement: summary,
  };
}

/** Prefers agreement; otherwise keeps whichever reader has an answer. */
function mergeField<T>(
  label: string,
  parser: T | null,
  model: T | null,
  disagreements: string[],
): T | null {
  if (parser === null) return model;
  if (model === null) return parser;
  if (parser === model) return parser;

  disagreements.push(label);
  return parser;
}

export function reconcile(
  parserReading: ExtractedInvoice,
  modelReading: ExtractedInvoice | null,
  knownVendors: string[] = [],
): ReconciledInvoice {
  if (!modelReading) {
    return {
      ...parserReading,
      lines: parserReading.lines.map((line) => ({
        ...line,
        source: "parser" as const,
        disagreement: null,
      })),
      usedModel: false,
      modelNote: null,
      disagreements: [],
    };
  }

  const disagreements: string[] = [];
  const unmatched = [...modelReading.lines];
  const lines: ReconciledLine[] = [];

  for (const parserLine of parserReading.lines) {
    const at = unmatched.findIndex((candidate) =>
      sameItem(parserLine.description, candidate.description),
    );

    if (at === -1) {
      lines.push({
        ...parserLine,
        confidence: cap(parserLine.confidence, "medium"),
        reason: `Only the built-in parser found this line. ${parserLine.reason}`,
        source: "parser",
        disagreement: null,
      });
      continue;
    }

    lines.push(mergeLine(parserLine, unmatched[at]));
    unmatched.splice(at, 1);
  }

  // Whatever the model saw and the parser did not. These matter: a real part
  // dropped by the parser's substring boilerplate filter surfaces here and
  // nowhere else.
  for (const modelLine of unmatched) {
    lines.push({
      ...modelLine,
      confidence: cap(modelLine.confidence, "medium"),
      reason: `Only DeepSeek found this line, so check it against the invoice. ${modelLine.reason}`,
      source: "model",
      disagreement: null,
    });
  }

  // A name already on file wins outright, whichever reader produced it: it is
  // what makes the order join the existing vendor instead of a near-duplicate.
  const known = knownVendors.find(
    (name) =>
      name.toLowerCase() === parserReading.vendorName?.toLowerCase() ||
      name.toLowerCase() === modelReading.vendorName?.toLowerCase(),
  );

  return {
    vendorName:
      known ??
      mergeField(
        "vendor",
        parserReading.vendorName,
        modelReading.vendorName,
        disagreements,
      ),
    invoiceDate: mergeField(
      "invoice date",
      parserReading.invoiceDate,
      modelReading.invoiceDate,
      disagreements,
    ),
    totalAmount: mergeField(
      "total",
      parserReading.totalAmount,
      modelReading.totalAmount,
      disagreements,
    ),
    trackingNumber: mergeField(
      "tracking number",
      parserReading.trackingNumber,
      modelReading.trackingNumber,
      disagreements,
    ),
    trackingUrl: mergeField(
      "tracking link",
      parserReading.trackingUrl,
      modelReading.trackingUrl,
      disagreements,
    ),
    lines,
    usedModel: true,
    modelNote: null,
    disagreements,
  };
}

/**
 * Reads one invoice with both readers and reconciles them.
 *
 * The deterministic parser always runs, so this degrades to exactly the previous
 * behaviour when there is no API key, no credit, or no network.
 */
export async function structureInvoice(
  ocrText: string,
  knownVendors: string[] = [],
): Promise<ReconciledInvoice> {
  const parserReading = extractInvoice(ocrText, knownVendors);
  const { reading, note } = await structurer.structure(ocrText, knownVendors);
  const merged = reconcile(parserReading, reading, knownVendors);

  return { ...merged, modelNote: note };
}
