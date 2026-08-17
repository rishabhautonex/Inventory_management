import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  extractInvoice,
  headerDeclaresSerialColumn,
  parseHeaderColumns,
  readLineNumbers,
  splitLine,
} from "../src/lib/invoice-extract";

/**
 * The extractor proposes values for a human to confirm, so these tests care
 * about two things above all:
 *
 *   1. that a confident reading is actually right, and
 *   2. that an unconfident one says so instead of inventing a quantity.
 *
 * A wrong quantity presented as fact is the failure that would reach the ledger.
 */

const ROBU_INVOICE = [
  "ROBU.IN",
  "Rajguru Electronics Pvt Ltd",
  "https://robu.in",
  "Tax Invoice",
  "Invoice No: RBU-2026-4471    Invoice Date: 12/02/2026",
  "GSTIN: 27ABCDE1234F1Z5",
  "Tracking No: SF1234567890IN",
  "Track at https://www.delhivery.com/track/package/SF1234567890IN",
  "",
  "Description                 Qty    Rate      Amount",
  "ESP32 DevKit V1 WROOM       10     420.00    4200.00",
  "SG90 Micro Servo Motor      25     139.00    3475.00",
  "Jumper Wire Set 40pin        4      99.00     396.00",
  "",
  "Subtotal                                     8071.00",
  "CGST 9%                                       726.39",
  "SGST 9%                                       726.39",
  "Grand Total                                  9523.78",
  "Authorised Signatory",
].join("\n");

describe("splitting a line into description and columns", () => {
  test("digits inside a name stay with the name", () => {
    assert.deepEqual(splitLine("Jumper Wire Set 40pin 4 99.00 396.00"), {
      description: "Jumper Wire Set 40pin",
      numbers: [4, 99, 396],
    });
  });

  test("a name ending in letters is not truncated", () => {
    // A regex character class containing R and s under /i eats the "r" from
    // "Motor". Tokenising cannot.
    assert.deepEqual(splitLine("SG90 Micro Servo Motor 25 139.00 3475.00"), {
      description: "SG90 Micro Servo Motor",
      numbers: [25, 139, 3475],
    });
  });

  test("Indian digit grouping and rupee markers are understood", () => {
    assert.deepEqual(splitLine("Oscilloscope DS1054Z 1 ₹1,23,456.78"), {
      description: "Oscilloscope DS1054Z",
      numbers: [1, 123456.78],
    });
  });

  test("a line with no numeric tail keeps everything", () => {
    assert.deepEqual(splitLine("Assorted resistor pack"), {
      description: "Assorted resistor pack",
      numbers: [],
    });
  });

  test("a unit column between the figures is not mistaken for the name", () => {
    // Very common on Indian invoices. Without this the quantity is left in the
    // description and the remaining two numbers get misread.
    assert.deepEqual(splitLine("ESP32 DevKit V1 10 Nos 420.00 4200.00"), {
      description: "ESP32 DevKit V1",
      numbers: [10, 420, 4200],
    });
  });

  test("a description ending in a unit word keeps that word", () => {
    // "Set" is a unit token, but nothing numeric precedes it here, so it
    // belongs to the name.
    assert.deepEqual(splitLine("Jumper Wire Set 4 99.00 396.00"), {
      description: "Jumper Wire Set",
      numbers: [4, 99, 396],
    });
  });
});

describe("a serial-number column", () => {
  test("is stripped when the lines are numbered in sequence", () => {
    const ocr = [
      "Description Qty Rate Amount",
      "1 ESP32 DevKit V1 10 420.00 4200.00",
      "2 SG90 Micro Servo 25 139.00 3475.00",
      "3 Breadboard 830pt 6 85.00 510.00",
    ].join("\n");

    assert.deepEqual(
      extractInvoice(ocr).lines.map((l) => l.description),
      ["ESP32 DevKit V1", "SG90 Micro Servo", "Breadboard 830pt"],
    );
  });

  test("is left alone when a product name simply starts with a number", () => {
    // "4 Channel Relay Module" and "8 Channel..." are real names, not a serial
    // column — they are not sequential from 1.
    const ocr = [
      "Description Qty Rate Amount",
      "4 Channel Relay Module 2 260.00 520.00",
      "8 Channel Relay Module 1 430.00 430.00",
    ].join("\n");

    assert.deepEqual(
      extractInvoice(ocr).lines.map((l) => l.description),
      ["4 Channel Relay Module", "8 Channel Relay Module"],
    );
  });

  test("is left alone when only some lines are numbered", () => {
    const ocr = [
      "Description Qty Rate Amount",
      "1 ESP32 DevKit V1 10 420.00 4200.00",
      "SG90 Micro Servo 25 139.00 3475.00",
    ].join("\n");

    assert.deepEqual(
      extractInvoice(ocr).lines.map((l) => l.description),
      ["1 ESP32 DevKit V1", "SG90 Micro Servo"],
    );
  });
});

describe("reading a line's numbers", () => {
  test("the triple that multiplies out wins", () => {
    const read = readLineNumbers([4, 99, 396]);
    assert.equal(read.qty, 4);
    assert.equal(read.unitPrice, 99);
    assert.equal(read.amount, 396);
    assert.equal(read.confidence, "high");
  });

  test("a quantity-shaped number that fails the arithmetic is rejected", () => {
    // 40 is present and integer, but 40 x 99 is 3960, not 396.
    const read = readLineNumbers([40, 4, 99, 396]);
    assert.equal(read.qty, 4, "the arithmetic picks 4 over 40");
    assert.equal(read.confidence, "high");
  });

  test("extra tax columns do not break the reading", () => {
    // qty, rate, taxable, gst, total
    const read = readLineNumbers([10, 420, 4200, 756, 4956]);
    assert.equal(read.qty, 10);
    assert.equal(read.unitPrice, 420);
    assert.equal(read.confidence, "high");
  });

  test("paise rounding is tolerated", () => {
    const read = readLineNumbers([3, 33.33, 99.99]);
    assert.equal(read.qty, 3);
    assert.equal(read.confidence, "high");
  });

  test("two columns are ambiguous, so no quantity is proposed", () => {
    // "5 250" is 5 at 50 each, or 50 at 5 each. Nothing on the line settles it,
    // and a confident guess here is what would reach the ledger.
    const read = readLineNumbers([5, 250]);
    assert.equal(read.qty, null);
    assert.equal(read.confidence, "low");
    assert.match(read.reason, /only two figures/i);
    assert.match(read.reason, /either 5 at 50\.00 each, or 50 at 5\.00 each/);
  });

  test("one column proposes no quantity at all", () => {
    const read = readLineNumbers([499]);
    assert.equal(read.qty, null, "better empty than wrong");
    assert.equal(read.amount, 499);
    assert.equal(read.confidence, "low");
  });

  test("no columns proposes nothing", () => {
    const read = readLineNumbers([]);
    assert.equal(read.qty, null);
    assert.equal(read.amount, null);
    assert.equal(read.confidence, "low");
  });

  test("a fractional quantity is never proposed", () => {
    // Pieces are whole, per the spec. 2.5 x 40 = 100 multiplies out but must
    // not be offered as a quantity.
    const read = readLineNumbers([2.5, 40, 100]);
    assert.notEqual(read.qty, 2.5);
  });
});

describe("reading a whole invoice", () => {
  const result = extractInvoice(ROBU_INVOICE, ["Robu.in"]);

  test("the invoice date is found and is not the due date", () => {
    assert.equal(result.invoiceDate, "2026-02-12");
  });

  test("a day-first date is read day-first", () => {
    const indian = extractInvoice("Invoice Date: 03/04/2026");
    assert.equal(indian.invoiceDate, "2026-04-03", "3 April, not 4 March");
  });

  test("an unambiguous month-second date still reads correctly", () => {
    const us = extractInvoice("Invoice Date: 04/17/2026");
    assert.equal(us.invoiceDate, "2026-04-17");
  });

  test("a written-out month is understood", () => {
    assert.equal(
      extractInvoice("Invoice Date: 12 Feb 2026").invoiceDate,
      "2026-02-12",
    );
  });

  test("a known vendor is preferred so the order joins the existing one", () => {
    assert.equal(result.vendorName, "Robu.in");
  });

  test("an unknown vendor is read as the trading name on the letterhead", () => {
    // "Rajguru Electronics Pvt Ltd" is the legal supplier on this bill; "Robu.in"
    // is only its brand, and would be assembled from a URL rather than read.
    const unknown = extractInvoice(ROBU_INVOICE, []);
    assert.equal(unknown.vendorName, "Rajguru Electronics Pvt Ltd");
  });

  test("the domain is still the fallback when no trading name is printed", () => {
    const bare = extractInvoice(
      ["ROBU.IN", "https://robu.in", "Grand Total 500.00"].join("\n"),
      [],
    );
    assert.equal(bare.vendorName, "Robu.in");
  });

  test("the grand total beats the subtotal", () => {
    assert.equal(result.totalAmount, 9523.78);
  });

  test("the tracking number comes from a line that says so", () => {
    assert.equal(result.trackingNumber, "SF1234567890IN");
  });

  test("no tracking number is invented when none is labelled", () => {
    const plain = extractInvoice(
      "Invoice No: RBU-2026-4471\nGSTIN: 27ABCDE1234F1Z5\nGrand Total 500.00",
    );
    assert.equal(
      plain.trackingNumber,
      null,
      "an invoice number is not a tracking number",
    );
  });

  test("a tracking link is preferred over any other URL", () => {
    assert.equal(
      result.trackingUrl,
      "https://www.delhivery.com/track/package/SF1234567890IN",
    );
  });

  test("every product line is found, and only the product lines", () => {
    const descriptions = result.lines.map((l) => l.description);

    assert.deepEqual(descriptions, [
      "ESP32 DevKit V1 WROOM",
      "SG90 Micro Servo Motor",
      "Jumper Wire Set 40pin",
    ]);
  });

  test("every product line reads confidently and correctly", () => {
    assert.deepEqual(
      result.lines.map((l) => [l.qty, l.unitPrice, l.confidence]),
      [
        [10, 420, "high"],
        [25, 139, "high"],
        [4, 99, "high"],
      ],
    );
  });

  test("several distinct components on one invoice all come through", () => {
    assert.equal(result.lines.length, 3);
    assert.equal(new Set(result.lines.map((l) => l.description)).size, 3);
  });
});

/**
 * A real supplier invoice, kept verbatim.
 *
 * Every assertion below corresponds to something this document originally got
 * wrong, so it is the regression test for the whole class of problem: a tax-column
 * tick, a subtotal beating the total, a website standing in for a tracking link,
 * bank details read as parts, and the customer's name read as the supplier's.
 */
const VACUS_INVOICE = [
  "Vacus Tech Pvt Ltd INVOICE",
  "No. 1010, 3rd Floor, 7th A Main Road, DATE 21-07-2026",
  "ST Bed Layout, Koramangala 1st Block, Koramangala INVOICE # FY26-27-210726-1",
  "Bangalore, Karnataka - 560034 CUSTOMER ID NA",
  "Phone: +91-7204705645",
  "GST: 29AAFCV7451G1ZZ",
  "Website: www.vacustech.com",
  "BILL TO: SHIP TO:",
  "AUTONEX AI 360 PRIVATE LIMITED AUTONEX AI 360 PRIVATE LIMITED",
  "703, Lodha Supremus, 703, Lodha Supremus,",
  "Saki Vihar Road, Powai Saki Vihar Road, Powai",
  "Mumbai, 400072 Mumbai, 400072",
  "Tel: 93999 52997 Tel: 93999 52997",
  "GST: 27ABDCA3903H1ZX GST: 27ABDCA3903H1ZX",
  "SALESPERSON P.O. # SHIP DATE SHIP VIA F.O.B. TERMS",
  "NA 21-07-2026 BlueDart NA AS PER AGREEMENT",
  "ITEM # DESCRIPTION QTY UNIT PRICE TAX TOTAL",
  "VT-DW1000-REV1.1 ESP32-DW1000 Evaluation Board 10 3,800.00 x 38,000.00",
  "-",
  "-",
  "S & H X 500.00",
  "[42]",
  "SUBTOTAL 38,500.00",
  "Other Comments or Special Instructions TAXABLE 38,500.00",
  "TAX RATE",
  "CGST 0.000%",
  "SGST 0.000%",
  "IGST 18.000%",
  "TAX 6,930.00",
  "S & H -",
  "OTHER -",
  "TOTAL ₹ 45,430.00",
  "You can make NEFT/ RTGS to",
  "Account Name - Vacus Tech Private Limited",
  "Account Number - 41920818356",
  "Bank Name - State Bank of India",
  "Branch - Koramangala",
  "IFSC Code - SBIN0064074 City - Bangalore",
  "If you have any questions about this invoice, please contact",
  "[Venugopal Kapre, e-mail: venugopal.k@vacustech.com]",
  "Thank You For Your Business!",
].join("\n");

describe("reading the quantity from the invoice's own QTY column", () => {
  test("the header row is parsed into its value columns", () => {
    assert.deepEqual(
      parseHeaderColumns("ITEM # DESCRIPTION QTY UNIT PRICE TAX TOTAL"),
      ["qty", "price", "tax", "amount"],
    );
  });

  test("multi-word labels beat their single-word parts", () => {
    // "TAXABLE VALUE" is one amount column, not a tax column then a value one.
    // HSN is counted: it holds a figure in the data row, so leaving it out would
    // shift every column after it by one. "Sr No" is dropped because it comes
    // before the description and so can never be in a trailing run.
    assert.deepEqual(
      parseHeaderColumns("Sr No Particulars HSN Qty Rate Taxable Value GST Amount"),
      ["code", "qty", "price", "amount", "tax", "amount"],
    );
  });

  test("two ambiguous figures are resolved when the header names the columns", () => {
    // On its own, "2 500.00" could be 2 at 250 or 250 at 2. The header settles
    // it, so no guessing is involved.
    const ocr = [
      "Description Qty Amount",
      "Mystery Widget 2 500.00",
    ].join("\n");

    const [line] = extractInvoice(ocr).lines;
    assert.equal(line.qty, 2);
    assert.equal(line.amount, 500);
    assert.match(line.reason, /quantity column/);
  });

  test("the column reading is cross-checked against the arithmetic", () => {
    const ocr = [
      "Description Qty Rate Amount",
      "Widget A 4 25.00 100.00",
    ].join("\n");

    const [line] = extractInvoice(ocr).lines;
    assert.equal(line.qty, 4);
    assert.equal(line.unitPrice, 25);
    assert.equal(line.confidence, "high");
    assert.match(line.reason, /confirms it/);
  });

  test("a column reading the figures contradict is flagged, not hidden", () => {
    // 4 x 25 is 100, not 999. The QTY column is still believed, because the
    // invoice said it — but it is surfaced for checking rather than called high.
    const ocr = [
      "Description Qty Rate Amount",
      "Widget B 4 25.00 999.00",
    ].join("\n");

    const [line] = extractInvoice(ocr).lines;
    assert.equal(line.qty, 4);
    assert.equal(line.confidence, "medium");
    assert.match(line.reason, /multiplies out to check it against/);
  });

  test("a row that does not line up with the header falls back to arithmetic", () => {
    // Four value columns in the header, three figures on the row.
    const ocr = [
      "Description Qty Rate Tax Amount",
      "Widget C 6 50.00 300.00",
    ].join("\n");

    const [line] = extractInvoice(ocr).lines;
    assert.equal(line.qty, 6);
    assert.equal(line.confidence, "high");
    assert.match(line.reason, /6 × 50 = 300/);
  });

  test("a header with no QTY column falls back to arithmetic", () => {
    const ocr = ["Description Rate Amount", "Widget D 7 30.00 210.00"].join("\n");

    const [line] = extractInvoice(ocr).lines;
    assert.equal(line.qty, 7);
    assert.equal(line.confidence, "high");
  });
});

/**
 * A second real invoice, kept verbatim, from a different billing system.
 *
 * This one wraps the item description across two lines, puts the serial on a
 * third, and leaves the figures on a fourth with no description at all. It also
 * defeats arithmetic entirely: the line reads 6 × ₹115.00 → ₹814.20, and 6 × 115
 * is 690, which appears only in the Sub Total further down the page. The header
 * row is the sole thing that can settle the quantity here.
 */
const SILIKON_INVOICE = [
  "For :NEW SILIKON ELECTRONICS",
  "Authorized Signatory",
  "ORIGINAL FOR RECIPIENT",
  "NEW SILIKON ELECTRONICS",
  "Shivoham Apartments Shop No 6, Proctor Road, Grant Road",
  "Mumbai 400007",
  "Phone no. : 9833862543",
  "Email : silikonelectronics@yahoo.com",
  "GSTIN : 27BBBPA9517K1ZM",
  "State: 27-Maharashtra",
  "Pan Card No:: BBBPA9517K",
  "Tax Invoice",
  "Bill To",
  "AUTONEX AI 360 PVT LTD",
  "Flat No 14 Ramtirth park Sadhu Vaswani Road Nashik",
  "Nashik, Maharashtra-422008",
  "India",
  "Contact No. : 9021112432",
  "GSTIN : 27ABDCA3903H1ZX",
  "State: 27-Maharashtra",
  "Invoice Details",
  "Invoice No. : 6369",
  "Date : 24-07-2026",
  "Place of supply: 27-Maharashtra",
  "# Item name HSN/ SAC Quantity Price/ Unit GST Amount",
  "1",
  "INA219 BI-DIRECTIONAL",
  "CURRENT SENSOR",
  "85381010 6 ₹ 115.00 ₹ 124.20 (18%) ₹ 814.20",
  "Total 6 ₹ 124.20 ₹ 814.20",
  "Invoice Amount In Words",
  "Eight Hundred Fourteen Rupees only",
  "Sub Total ₹ 690.00",
  "SGST@9% ₹ 62.10",
  "CGST@9% ₹ 62.10",
  "Round off - ₹ 0.20",
  "Total ₹ 814.00",
  "Received ₹ 0.00",
  "Balance ₹ 814.00",
  "Payment mode Credit",
  "Pay To:",
  "Bank Name : CANARA BANK",
  "Bank Account No. : 0135201002909",
  "Bank IFSC code : CNRB0000135",
].join("\n");

describe("an invoice whose description wraps across lines", () => {
  const result = extractInvoice(SILIKON_INVOICE);

  test("the header's columns are read past the serial and code columns", () => {
    // "#" and "Item name" precede the description, so they cannot appear in a
    // trailing run of figures and must not be counted.
    assert.deepEqual(
      parseHeaderColumns("# Item name HSN/ SAC Quantity Price/ Unit GST Amount"),
      ["code", "qty", "price", "tax", "amount"],
    );
  });

  test("the wrapped description is joined onto its figures row", () => {
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].description, "INA219 BI-DIRECTIONAL CURRENT SENSOR");
  });

  test("the quantity comes from the QTY column even though nothing multiplies out", () => {
    const [line] = result.lines;
    assert.equal(line.qty, 6);
    assert.equal(line.unitPrice, 115);
    assert.equal(line.amount, 814.2);
    // 6 × 115 = 690, which is the Sub Total further down and not on this line.
    assert.equal(line.confidence, "medium");
    assert.match(line.reason, /Read 6 from the invoice.s quantity column/);
  });

  test("the signature block is not mistaken for the vendor name", () => {
    assert.equal(result.vendorName, "NEW SILIKON ELECTRONICS");
  });

  test("our own company is not mistaken for the supplier", () => {
    assert.doesNotMatch(String(result.vendorName), /autonex/i);
  });

  test("the payable total beats both the table's total row and the sub total", () => {
    // "Total 6 ₹124.20 ₹814.20" foots the table, "Sub Total ₹690.00" excludes
    // tax, and "Total ₹814.00" is what is owed.
    assert.equal(result.totalAmount, 814);
  });

  test("the date is read day-first", () => {
    assert.equal(result.invoiceDate, "2026-07-24");
  });

  test("no tracking details are invented", () => {
    assert.equal(result.trackingNumber, null);
    assert.equal(result.trackingUrl, null);
  });

  test("bank details are not read as parts", () => {
    const descriptions = result.lines.map((l) => l.description.toLowerCase());
    for (const noise of ["canara", "ifsc", "account", "balance", "received"]) {
      assert.ok(
        !descriptions.some((d) => d.includes(noise)),
        `"${noise}" should never appear as a part`,
      );
    }
  });

  /**
   * The same invoice as its PDF text layer actually emits it: the serial rides on
   * the first description line, and the second description line carries the
   * figures. Both break-points must produce the same reading.
   */
  test("the same item reads the same when the PDF breaks the lines differently", () => {
    const asPdfEmitsIt = SILIKON_INVOICE.replace(
      "1\nINA219 BI-DIRECTIONAL\nCURRENT SENSOR\n85381010 6 ₹ 115.00 ₹ 124.20 (18%) ₹ 814.20",
      "1 INA219 BI-DIRECTIONAL\nCURRENT SENSOR 85381010 6 ₹ 115.00 ₹ 124.20 (18%) ₹ 814.20",
    );

    const shifted = extractInvoice(asPdfEmitsIt);

    assert.equal(shifted.lines.length, 1);
    assert.equal(
      shifted.lines[0].description,
      "INA219 BI-DIRECTIONAL CURRENT SENSOR",
      "the part number must survive, and the serial must not",
    );
    assert.equal(shifted.lines[0].qty, 6);
    assert.equal(shifted.lines[0].unitPrice, 115);
  });

  test("a lone serial is only stripped when the header declares that column", () => {
    assert.equal(
      headerDeclaresSerialColumn("# Item name HSN/ SAC Quantity Price/ Unit GST Amount"),
      true,
    );
    assert.equal(
      headerDeclaresSerialColumn("Description Qty Rate Amount"),
      false,
    );
  });

  test("a single product whose name starts with a number keeps it", () => {
    // The header declares a serial column, but a serial list does not start at
    // 4 — so "4 Channel Relay Module" is a name, not a numbered row.
    const ocr = [
      "# Item name HSN/ SAC Quantity Price/ Unit GST Amount",
      "4 Channel Relay Module 85381010 2 260.00 520.00",
    ].join("\n");

    assert.equal(
      extractInvoice(ocr).lines[0].description,
      "4 Channel Relay Module",
    );
  });
});

describe("a real supplier invoice", () => {
  const result = extractInvoice(VACUS_INVOICE);

  test("the supplier's trading name wins over its website domain", () => {
    assert.equal(result.vendorName, "Vacus Tech Pvt Ltd");
  });

  test("our own company is never mistaken for the supplier", () => {
    assert.doesNotMatch(String(result.vendorName), /autonex/i);
  });

  test("the date is read day-first", () => {
    assert.equal(result.invoiceDate, "2026-07-21");
  });

  test("the grand total wins over the subtotal", () => {
    // "subtotal" contains "total" as a substring, which is how 38,500 used to
    // beat 45,430.
    assert.equal(result.totalAmount, 45430);
  });

  test("the supplier's website is not offered as a tracking link", () => {
    assert.equal(result.trackingUrl, null);
    assert.equal(result.trackingNumber, null);
  });

  test("the tax-column tick does not eat the quantity", () => {
    // "10  3,800.00  x  38,000.00" — the x used to stop the scan, leaving one
    // figure and no quantity.
    assert.equal(result.lines.length, 1);

    const [line] = result.lines;
    assert.equal(line.description, "VT-DW1000-REV1.1 ESP32-DW1000 Evaluation Board");
    assert.equal(line.qty, 10);
    assert.equal(line.unitPrice, 3800);
    assert.equal(line.amount, 38000);
    assert.equal(line.confidence, "high");
  });

  test("bank details and footer text are not read as parts", () => {
    const descriptions = result.lines.map((l) => l.description.toLowerCase());

    for (const noise of ["account", "taxable", "comments", "ifsc", "branch"]) {
      assert.ok(
        !descriptions.some((d) => d.includes(noise)),
        `"${noise}" should never appear as a part`,
      );
    }
  });
});
