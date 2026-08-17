/**
 * Shows exactly what the extractor makes of one invoice.
 *
 *   npm run invoice:debug -- path/to/invoice.pdf
 *   npm run invoice:debug -- path/to/photo.jpg
 *   npm run invoice:debug -- path/to/ocr-text.txt
 *
 * A `.txt` file skips OCR and parses the text directly, which is the fast way to
 * iterate on the parsing rules once the text is known to be good.
 *
 * Nothing here touches the database or Supabase — it reads a local file and
 * prints. Safe to run against a real invoice.
 */

import fs from "node:fs";
import path from "node:path";

import { extractInvoice, splitLine } from "../src/lib/invoice-extract";
import { extractInvoiceText } from "../src/lib/ocr";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
};

function rule(title: string) {
  console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error(
      "Usage: npm run invoice:debug -- <invoice.pdf | photo.jpg | ocr-text.txt>",
    );
    process.exit(2);
  }

  const file = path.resolve(target);
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(2);
  }

  const extension = path.extname(file).toLowerCase();
  let text: string;

  if (extension === ".txt") {
    text = fs.readFileSync(file, "utf8");
    rule("TEXT (read straight from the .txt, no OCR)");
  } else {
    const mime = MIME_BY_EXTENSION[extension];
    if (!mime) {
      console.error(
        `Unsupported extension "${extension}". Use a PDF, an image, or a .txt of OCR output.`,
      );
      process.exit(2);
    }

    const started = Date.now();
    const outcome = await extractInvoiceText(
      new Uint8Array(fs.readFileSync(file)),
      mime,
    );
    rule(
      `OCR — method: ${outcome.method}, pages: ${outcome.pagesProcessed}, ${Date.now() - started}ms`,
    );
    if (outcome.note) console.log(`note: ${outcome.note}\n`);
    text = outcome.text;
  }

  console.log(text || "(nothing was read)");

  const found = extractInvoice(text);

  rule("HEADER FIELDS");
  const header: Array<[string, unknown]> = [
    ["vendor", found.vendorName],
    ["invoice date", found.invoiceDate],
    ["total", found.totalAmount],
    ["tracking number", found.trackingNumber],
    ["tracking link", found.trackingUrl],
  ];
  for (const [label, value] of header) {
    console.log(
      `  ${label.padEnd(16)} ${value === null || value === undefined ? "— not found" : String(value)}`,
    );
  }

  rule(`LINE ITEMS (${found.lines.length})`);
  if (found.lines.length === 0) {
    console.log("  none were recognised");
  }
  for (const line of found.lines) {
    console.log(`\n  raw         ${line.raw}`);
    console.log(`  description ${line.description}`);
    console.log(
      `  qty         ${line.qty ?? "— blank on purpose"}    unit price ${line.unitPrice ?? "—"}    amount ${line.amount ?? "—"}`,
    );
    console.log(`  confidence  ${line.confidence}`);
    console.log(`  why         ${line.reason}`);
  }

  // Every line that was rejected, and the split it would have had. This is
  // usually where a missing part turns up.
  rule("LINES THAT WERE NOT TREATED AS ITEMS");
  const kept = new Set(found.lines.map((line) => line.raw));
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || kept.has(line)) continue;
    const { description, numbers } = splitLine(line);
    console.log(
      `  ${line}\n      -> description "${description}", numbers [${numbers.join(", ")}]`,
    );
  }

  console.log(
    "\nPaste this whole output when reporting a mislabelled field or line.\n",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
