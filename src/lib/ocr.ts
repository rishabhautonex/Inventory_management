/**
 * ===========================================================================
 * INVOICE TEXT EXTRACTION
 * ===========================================================================
 *
 * This produces a searchable blob and nothing else.
 *
 * The spec forbids populating order lines from it, and that restraint is the
 * whole reason this module can be simple. OCR output is a wall of text in which
 * a quantity, a unit price, an HSN code and a GST rate are all just numbers with
 * nothing marking which is which. Guessing wrong would write a wrong `receipt`
 * movement, and a wrong movement is a wrong on-hand — in a system whose entire
 * premise is that the ledger cannot lie. So a human types the lines, and this
 * text only ever answers "which invoice had that ESP32 on it?".
 *
 * See invoice-match.ts for the suggestion pass, which ranks catalogue matches
 * for a human to confirm and still never writes anything by itself.
 * ===========================================================================
 */

import { tmpdir } from "node:os";

/**
 * Where tesseract keeps its ~5 MB language file.
 *
 * It defaults to the working directory, which is read-only on a serverless
 * host: the cache read misses, the cache write fails (caught and logged, not
 * fatal), and every cold container re-downloads the file from a CDN before it
 * can read anything. The temp directory is the one place that is writable
 * everywhere, so a warm container pays that download once.
 */
const LANG_CACHE_PATH = tmpdir();

/** Below this, a PDF's embedded text layer is treated as absent. */
const MIN_MEANINGFUL_CHARS = 40;

/** A bill is one or two pages. Five is generous and bounds the worst case. */
const MAX_OCR_PAGES = 5;

/** ~150–200 DPI once rasterised, which is where tesseract stops improving. */
const RASTER_SCALE = 2;

export type OcrMethod =
  /** The PDF carried its own text layer; no OCR was needed. */
  | "pdf-text"
  /** A photo or scan, read by tesseract. */
  | "ocr-image"
  /** An image-only PDF, rasterised page by page and then read. */
  | "ocr-pdf-pages"
  /** Nothing usable came out. */
  | "none";

export type OcrOutcome = {
  text: string;
  method: OcrMethod;
  pagesProcessed: number;
  /** Human-readable explanation when the result is partial or empty. */
  note: string | null;
};

export interface InvoiceTextExtractor {
  readonly name: string;
  extract(bytes: Uint8Array, mime: string): Promise<OcrOutcome>;
}

/** Keeps line breaks — they help a reader skim, and split candidate lines. */
function tidy(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim());

  return lines
    .filter((line, index) => line !== "" || lines[index - 1] !== "")
    .join("\n")
    .trim();
}

/**
 * One tesseract worker for the whole call.
 *
 * Workers are expensive to start and hold a WASM heap, so a five-page PDF
 * should not pay for five of them — and `finally` matters more than the reuse:
 * a leaked worker keeps the process alive.
 */
async function withRecognizer<T>(
  run: (read: (input: Buffer) => Promise<string>) => Promise<T>,
): Promise<T> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", undefined, {
    cachePath: LANG_CACHE_PATH,
  });

  try {
    return await run(async (input) => {
      const { data } = await worker.recognize(input);
      return data.text ?? "";
    });
  } finally {
    await worker.terminate();
  }
}

async function extractFromPdf(bytes: Uint8Array): Promise<OcrOutcome> {
  const { extractText, getDocumentProxy, renderPageAsImage } = await import(
    "unpdf"
  );

  // A copy, because pdfjs transfers ownership of the buffer it is handed and
  // the same bytes are needed again for the rasterising fallback below.
  const proxy = await getDocumentProxy(new Uint8Array(bytes));
  const { text, totalPages } = await extractText(proxy, { mergePages: true });
  const embedded = tidy(text);

  if (embedded.replace(/\s/g, "").length >= MIN_MEANINGFUL_CHARS) {
    return {
      text: embedded,
      method: "pdf-text",
      pagesProcessed: totalPages,
      note: null,
    };
  }

  // No text layer: a scan saved as a PDF. Rasterise, then read the images.
  const pages = Math.min(totalPages, MAX_OCR_PAGES);

  try {
    const chunks = await withRecognizer(async (read) => {
      const out: string[] = [];
      for (let page = 1; page <= pages; page++) {
        const png = await renderPageAsImage(new Uint8Array(bytes), page, {
          scale: RASTER_SCALE,
          canvasImport: () => import("@napi-rs/canvas"),
        });
        out.push(await read(Buffer.from(png)));
      }
      return out;
    });

    const combined = tidy(chunks.join("\n"));

    return {
      text: combined,
      method: combined ? "ocr-pdf-pages" : "none",
      pagesProcessed: pages,
      note:
        totalPages > pages
          ? `Only the first ${pages} of ${totalPages} pages were read.`
          : combined
            ? null
            : "This PDF has no text layer and nothing legible was found in it.",
    };
  } catch (cause) {
    console.error("[ocr] rasterising the PDF failed", cause);
    return {
      text: "",
      method: "none",
      pagesProcessed: 0,
      note: "This PDF has no text layer and could not be converted to images.",
    };
  }
}

async function extractFromImage(bytes: Uint8Array): Promise<OcrOutcome> {
  const text = tidy(
    await withRecognizer((read) => read(Buffer.from(bytes))),
  );

  return {
    text,
    method: text ? "ocr-image" : "none",
    pagesProcessed: 1,
    note: text ? null : "Nothing legible was found in this image.",
  };
}

/**
 * The default extractor: `unpdf` for PDFs, `tesseract.js` for photos.
 *
 * Never throws. A failed extraction leaves the invoice stored and simply
 * unsearchable, which is a far better outcome than a failed upload.
 */
export const tesseractExtractor: InvoiceTextExtractor = {
  name: "tesseract",

  async extract(bytes, mime) {
    try {
      if (mime === "application/pdf") return await extractFromPdf(bytes);

      if (mime.startsWith("image/")) {
        // tesseract reads what browsers read. HEIC is neither, and converting
        // it needs a codec this app has no other reason to carry.
        if (mime === "image/heic" || mime === "image/heif") {
          return {
            text: "",
            method: "none",
            pagesProcessed: 0,
            note: "HEIC images are stored but not read. Upload a JPEG or PNG to make this invoice searchable.",
          };
        }
        return await extractFromImage(bytes);
      }

      return {
        text: "",
        method: "none",
        pagesProcessed: 0,
        note: `Text extraction does not handle ${mime}.`,
      };
    } catch (cause) {
      console.error("[ocr] extraction failed", cause);
      return {
        text: "",
        method: "none",
        pagesProcessed: 0,
        note: "Text extraction failed. The invoice file itself is stored and unaffected.",
      };
    }
  },
};

let extractor: InvoiceTextExtractor = tesseractExtractor;

/** Swaps the extractor. Used by tests, which must not start a WASM worker. */
export function setInvoiceTextExtractor(next: InvoiceTextExtractor): void {
  extractor = next;
}

export function extractInvoiceText(
  bytes: Uint8Array,
  mime: string,
): Promise<OcrOutcome> {
  return extractor.extract(bytes, mime);
}
