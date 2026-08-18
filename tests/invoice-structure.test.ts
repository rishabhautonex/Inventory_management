import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import type {
  ExtractedInvoice,
  ExtractedLine,
} from "../src/lib/invoice-extract";
import { deepseekStructurer, reconcile } from "../src/lib/invoice-structure";

/**
 * Two readers, and the thing being tested is what happens when they differ.
 *
 * The intake flow's safety property is that a quantity nobody could establish
 * arrives as null rather than as a plausible number. Adding a second reader is
 * only an improvement if it keeps that property when the two readers conflict —
 * so most of these tests are about disagreement, not agreement.
 *
 * Nothing here touches the network. The model's half is exercised by stubbing
 * `fetch`, which also lets the documented failures (an empty answer, an empty
 * account) be pinned rather than discovered in production.
 */

function line(over: Partial<ExtractedLine> = {}): ExtractedLine {
  return {
    raw: "ESP32 DevKit V1 WROOM 10 420.00 4200.00",
    description: "ESP32 DevKit V1 WROOM",
    qty: 10,
    unitPrice: 420,
    amount: 4200,
    confidence: "high",
    reason: "10 × 420 = 4200, so the quantity is 10.",
    ...over,
  };
}

function invoice(over: Partial<ExtractedInvoice> = {}): ExtractedInvoice {
  return {
    vendorName: "Rajguru Electronics Pvt Ltd",
    invoiceDate: "2026-02-12",
    totalAmount: 9523.78,
    trackingNumber: null,
    trackingUrl: null,
    lines: [line()],
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                              */
/* -------------------------------------------------------------------------- */

describe("when both readings agree", () => {
  test("the line is promoted to high confidence and marked as agreed", () => {
    const result = reconcile(invoice(), invoice());

    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].qty, 10);
    assert.equal(result.lines[0].confidence, "high");
    assert.equal(result.lines[0].source, "both");
    assert.equal(result.lines[0].disagreement, null);
    assert.match(result.lines[0].reason, /Both readings/);
  });

  test("the longer description wins, since it carries the part number", () => {
    const result = reconcile(
      invoice({ lines: [line({ description: "DevKit V1" })] }),
      invoice({ lines: [line({ description: "ESP32 DevKit V1 WROOM" })] }),
    );

    assert.equal(result.lines[0].description, "ESP32 DevKit V1 WROOM");
  });
});

describe("when the two readings disagree on a quantity", () => {
  test("the reading the arithmetic confirms is the one shown", () => {
    const result = reconcile(
      invoice({ lines: [line({ qty: 420, unitPrice: 10, amount: 4200 })] }),
      invoice({ lines: [line({ qty: 10, unitPrice: 420, amount: 4200 })] }),
    );

    // Both multiply out here, so neither is proven over the other.
    assert.equal(result.lines[0].qty, null);
    assert.equal(result.lines[0].confidence, "low");
  });

  test("only one multiplying out settles it, at reduced confidence", () => {
    const result = reconcile(
      invoice({ lines: [line({ qty: 40, unitPrice: 420, amount: 4200 })] }),
      invoice({ lines: [line({ qty: 10, unitPrice: 420, amount: 4200 })] }),
    );

    assert.equal(result.lines[0].qty, 10);
    assert.equal(result.lines[0].confidence, "medium");
    assert.match(result.lines[0].disagreement ?? "", /read 40.*read 10/);
  });

  test("neither multiplying out proposes no quantity at all", () => {
    const result = reconcile(
      invoice({ lines: [line({ qty: 7, unitPrice: null, amount: null })] }),
      invoice({ lines: [line({ qty: 9, unitPrice: null, amount: null })] }),
    );

    assert.equal(result.lines[0].qty, null);
    assert.equal(result.lines[0].confidence, "low");
    assert.match(result.lines[0].reason, /disagree/);
    assert.match(result.lines[0].reason, /Enter the quantity yourself/);
  });

  test("neither finding a quantity is reported, not hidden", () => {
    const result = reconcile(
      invoice({ lines: [line({ qty: null, confidence: "low" })] }),
      invoice({ lines: [line({ qty: null, confidence: "low" })] }),
    );

    assert.equal(result.lines[0].qty, null);
    assert.equal(result.lines[0].confidence, "low");
    assert.equal(result.lines[0].disagreement, null);
  });
});

describe("when only one reading found a line", () => {
  test("a line only the model saw still reaches the reviewer", () => {
    // Exactly the parser's substring-boilerplate blind spot: "Microphone"
    // contains "phone", so the built-in reader drops it silently.
    const result = reconcile(
      invoice({ lines: [] }),
      invoice({
        lines: [
          line({
            description: "Microphone Module MAX9814",
            qty: 5,
            unitPrice: 180,
            amount: 900,
          }),
        ],
      }),
    );

    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].description, "Microphone Module MAX9814");
    assert.equal(result.lines[0].source, "model");
    assert.equal(result.lines[0].confidence, "medium", "capped, not trusted");
    assert.match(result.lines[0].reason, /Only DeepSeek/);
  });

  test("a line only the parser saw is capped too", () => {
    const result = reconcile(invoice(), invoice({ lines: [] }));

    assert.equal(result.lines[0].source, "parser");
    assert.equal(result.lines[0].confidence, "medium");
    assert.match(result.lines[0].reason, /Only the built-in parser/);
  });

  test("descriptions that differ in punctuation still count as one line", () => {
    const result = reconcile(
      invoice({ lines: [line({ description: "ESP32 DevKit V1 (WROOM)" })] }),
      invoice({ lines: [line({ description: "ESP32 DevKit V1 WROOM" })] }),
    );

    assert.equal(result.lines.length, 1, "not counted twice");
    assert.equal(result.lines[0].source, "both");
  });
});

describe("header fields", () => {
  test("a disagreement is recorded rather than silently resolved", () => {
    const result = reconcile(
      invoice({ totalAmount: 9523.78 }),
      invoice({ totalAmount: 8071 }),
    );

    assert.deepEqual(result.disagreements, ["total"]);
    assert.equal(result.totalAmount, 9523.78, "the tested parser is preferred");
  });

  test("whichever reader found a field is used when the other did not", () => {
    const result = reconcile(
      invoice({ trackingNumber: null }),
      invoice({ trackingNumber: "SF1234567890IN" }),
    );

    assert.equal(result.trackingNumber, "SF1234567890IN");
    assert.deepEqual(result.disagreements, []);
  });

  test("a vendor already on file wins from either reader", () => {
    const result = reconcile(
      invoice({ vendorName: "Rajguru Electronics" }),
      invoice({ vendorName: "Robu.in" }),
      ["Robu.in"],
    );

    assert.equal(result.vendorName, "Robu.in");
  });
});

describe("without the model", () => {
  test("the result is the parser's reading, unchanged and labelled", () => {
    const result = reconcile(invoice(), null);

    assert.equal(result.usedModel, false);
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].qty, 10);
    assert.equal(result.lines[0].confidence, "high", "not capped");
    assert.equal(result.lines[0].source, "parser");
  });
});

/* -------------------------------------------------------------------------- */
/* The DeepSeek half                                                           */
/* -------------------------------------------------------------------------- */

const realFetch = globalThis.fetch;
const realKey = process.env.DEEPSEEK_API_KEY;

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function answering(...contents: Array<string | null>): () => Promise<Response> {
  let at = 0;
  return async () =>
    reply({ choices: [{ message: { content: contents[at++] ?? null } }] });
}

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = "sk-test";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = realKey;
});

describe("reading the model's answer", () => {
  test("a quantity the arithmetic confirms comes through as high", async () => {
    globalThis.fetch = answering(
      JSON.stringify({
        vendorName: "Robu.in",
        invoiceDate: "2026-02-12",
        totalAmount: 9523.78,
        trackingNumber: null,
        trackingUrl: null,
        lines: [
          {
            description: "ESP32 DevKit V1",
            qty: 10,
            unitPrice: 420,
            amount: 4200,
          },
        ],
      }),
    ) as typeof fetch;

    const { reading } = await deepseekStructurer.structure("invoice text", []);

    assert.equal(reading?.lines[0].qty, 10);
    assert.equal(reading?.lines[0].confidence, "high");
    assert.equal(reading?.invoiceDate, "2026-02-12");
  });

  test("a quantity the arithmetic contradicts is discarded, not shown", async () => {
    globalThis.fetch = answering(
      JSON.stringify({
        vendorName: null,
        invoiceDate: null,
        totalAmount: null,
        trackingNumber: null,
        trackingUrl: null,
        lines: [
          {
            description: "ESP32 DevKit V1",
            qty: 40,
            unitPrice: 420,
            amount: 4200,
          },
        ],
      }),
    ) as typeof fetch;

    const { reading } = await deepseekStructurer.structure("invoice text", []);

    assert.equal(reading?.lines[0].qty, null);
    assert.equal(reading?.lines[0].confidence, "low");
    assert.match(reading?.lines[0].reason ?? "", /does not come to 4200/);
  });

  test("a fractional quantity is never accepted", async () => {
    globalThis.fetch = answering(
      JSON.stringify({
        vendorName: null,
        invoiceDate: null,
        totalAmount: null,
        trackingNumber: null,
        trackingUrl: null,
        lines: [
          { description: "Copper Wire", qty: 2.5, unitPrice: 100, amount: 250 },
        ],
      }),
    ) as typeof fetch;

    const { reading } = await deepseekStructurer.structure("invoice text", []);

    assert.equal(reading?.lines[0].qty, null);
    assert.match(reading?.lines[0].reason ?? "", /whole number of pieces/);
  });

  test("a date that is not ISO is dropped rather than half-read", async () => {
    globalThis.fetch = answering(
      JSON.stringify({
        vendorName: null,
        invoiceDate: "12/02/2026",
        totalAmount: null,
        trackingNumber: null,
        trackingUrl: null,
        lines: [],
      }),
    ) as typeof fetch;

    const { reading } = await deepseekStructurer.structure("invoice text", []);

    assert.equal(reading?.invoiceDate, null);
  });

  test("figures returned as strings are still understood", async () => {
    globalThis.fetch = answering(
      JSON.stringify({
        vendorName: null,
        invoiceDate: null,
        totalAmount: "₹9,523.78",
        trackingNumber: null,
        trackingUrl: null,
        lines: [
          {
            description: "ESP32 DevKit V1",
            qty: "10",
            unitPrice: "420.00",
            amount: "4200.00",
          },
        ],
      }),
    ) as typeof fetch;

    const { reading } = await deepseekStructurer.structure("invoice text", []);

    assert.equal(reading?.totalAmount, 9523.78);
    assert.equal(reading?.lines[0].qty, 10);
    assert.equal(reading?.lines[0].confidence, "high");
  });
});

describe("when DeepSeek does not answer", () => {
  test("an empty answer is retried once", async () => {
    globalThis.fetch = answering(
      "",
      JSON.stringify({
        vendorName: "Robu.in",
        invoiceDate: null,
        totalAmount: null,
        trackingNumber: null,
        trackingUrl: null,
        lines: [],
      }),
    ) as typeof fetch;

    const { reading, note } = await deepseekStructurer.structure("text", []);

    assert.equal(reading?.vendorName, "Robu.in");
    assert.equal(note, null);
  });

  test("two empty answers give up and say so", async () => {
    globalThis.fetch = answering("", "") as typeof fetch;

    const { reading, note } = await deepseekStructurer.structure("text", []);

    assert.equal(reading, null);
    assert.match(note ?? "", /empty answer/);
  });

  test("an empty account is named as a billing problem", async () => {
    globalThis.fetch = (async () =>
      reply({ error: { message: "Insufficient Balance" } }, 402)) as typeof fetch;

    const { reading, note } = await deepseekStructurer.structure("text", []);

    assert.equal(reading, null);
    assert.match(note ?? "", /out of credit/);
  });

  test("a rejected key is named as a key problem", async () => {
    globalThis.fetch = (async () =>
      reply({ error: { message: "Authentication Fails" } }, 401)) as typeof fetch;

    const { note } = await deepseekStructurer.structure("text", []);

    assert.match(note ?? "", /DEEPSEEK_API_KEY/);
  });

  test("unusable json is reported, never thrown", async () => {
    globalThis.fetch = answering("{ not json at all") as typeof fetch;

    const { reading, note } = await deepseekStructurer.structure("text", []);

    assert.equal(reading, null);
    assert.match(note ?? "", /could not be read/);
  });

  test("a network failure is reported, never thrown", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const { reading, note } = await deepseekStructurer.structure("text", []);

    assert.equal(reading, null);
    assert.match(note ?? "", /could not be reached/);
  });

  test("no key at all is silent, because it is a choice and not a fault", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    globalThis.fetch = (async () => {
      throw new Error("should never be called");
    }) as typeof fetch;

    const { reading, note } = await deepseekStructurer.structure("text", []);

    assert.equal(reading, null);
    assert.equal(note, null);
  });
});
