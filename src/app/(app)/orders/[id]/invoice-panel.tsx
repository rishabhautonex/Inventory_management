"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  extractInvoiceTextAction,
  getInvoiceUrlAction,
  suggestFromInvoiceAction,
  uploadInvoiceAction,
} from "@/app/actions/orders";
import { useToast } from "@/components/toast";
import { ExternalLinkIcon, SearchIcon } from "@/components/icons";
import {
  Badge,
  ErrorText,
  ghostButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/ui";
import type { LineSuggestion } from "@/lib/invoice-match";

const METHOD_LABEL: Record<string, string> = {
  "pdf-text": "read straight from the PDF's text layer",
  "ocr-image": "read from the image by OCR",
  "ocr-pdf-pages": "the PDF had no text layer, so its pages were OCR'd",
  none: "nothing legible was found",
};

/**
 * The invoice: upload, view, and make searchable.
 *
 * The extracted text is a search aid and the panel says so, because the obvious
 * expectation is that it fills in the order lines. It deliberately does not —
 * see the note rendered at the bottom, and the reasoning in lib/ocr.ts.
 */
export function InvoicePanel({
  orderId,
  hasInvoice,
  invoiceMime,
  ocrText,
  storageProblem,
}: {
  orderId: string;
  hasInvoice: boolean;
  invoiceMime: string | null;
  ocrText: string | null;
  /** Set when storage is misconfigured, so the panel can say so up front. */
  storageProblem?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, startUpload] = useTransition();
  const [extracting, startExtract] = useTransition();
  const [suggesting, startSuggest] = useTransition();

  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<LineSuggestion[] | null>(null);

  function upload() {
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a file first.");
      return;
    }

    const formData = new FormData();
    formData.set("orderId", orderId);
    formData.set("file", file);

    startUpload(async () => {
      const result = await uploadInvoiceAction(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (fileRef.current) fileRef.current.value = "";
      setSuggestions(null);
      toast.show({ tone: "success", message: "Invoice stored." });
      router.refresh();
    });
  }

  function readText() {
    setError(null);
    startExtract(async () => {
      const result = await extractInvoiceTextAction(orderId);
      if (!result.ok) {
        setError(result.error);
        return;
      }

      const { characters, method, note } = result.data;
      toast.show({
        tone: characters > 0 ? "success" : "error",
        message:
          characters > 0
            ? `Read ${characters.toLocaleString("en-IN")} characters — ${METHOD_LABEL[method] ?? method}.`
            : (note ?? "Nothing legible was found."),
        duration: 8000,
      });
      router.refresh();
    });
  }

  function openInvoice() {
    setError(null);
    startExtract(async () => {
      const result = await getInvoiceUrlAction(orderId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      window.open(result.data.url, "_blank", "noopener,noreferrer");
    });
  }

  function suggest() {
    setError(null);
    startSuggest(async () => {
      const result = await suggestFromInvoiceAction(orderId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSuggestions(result.data.suggestions);
    });
  }

  const busy = uploading || extracting || suggesting;

  return (
    <section className="panel rounded-xl">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
        <h2 className="text-base font-semibold">Invoice</h2>
        <div className="flex flex-wrap items-center gap-2">
          {hasInvoice ? <Badge tone="positive">Stored</Badge> : null}
          {ocrText ? <Badge tone="accent">Searchable</Badge> : null}
        </div>
      </header>

      <div className="space-y-5 border-t border-border p-4 sm:p-5">
        {storageProblem ? (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            <span className="font-semibold">Storage is not set up: </span>
            {storageProblem}
          </p>
        ) : null}

        <div>
          <label className="mb-1.5 block text-sm font-medium">
            {hasInvoice ? "Replace the file" : "Upload the invoice"}
          </label>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
            className="block w-full cursor-pointer rounded-lg border border-border bg-surface-muted text-sm text-muted file:mr-3 file:cursor-pointer file:rounded-l-lg file:border-0 file:bg-surface-hover file:px-4 file:py-3 file:text-sm file:font-medium file:text-foreground"
          />
          <p className="mt-1.5 text-xs text-muted">
            A PDF or a photo of the bill, up to 20 MB. The original is always kept
            exactly as uploaded.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={upload}
            disabled={busy}
            className={primaryButtonClass}
          >
            {uploading ? "Uploading…" : hasInvoice ? "Replace" : "Upload"}
          </button>

          {hasInvoice ? (
            <>
              <button
                type="button"
                onClick={openInvoice}
                disabled={busy}
                className={secondaryButtonClass}
              >
                View
                <ExternalLinkIcon size={16} />
              </button>

              <button
                type="button"
                onClick={readText}
                disabled={busy}
                className={secondaryButtonClass}
              >
                {extracting ? "Reading…" : ocrText ? "Read again" : "Read text"}
              </button>
            </>
          ) : null}
        </div>

        <ErrorText>{error}</ErrorText>

        {invoiceMime === "image/heic" || invoiceMime === "image/heif" ? (
          <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            HEIC files are stored but cannot be read for text. Upload a JPEG or
            PNG if you want this invoice to be searchable.
          </p>
        ) : null}

        {ocrText ? (
          <>
            <details className="rounded-lg border border-border bg-surface-muted/50">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                Extracted text ({ocrText.length.toLocaleString("en-IN")}{" "}
                characters)
              </summary>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border px-4 py-3 font-mono text-xs text-muted">
                {ocrText}
              </pre>
            </details>

            <div>
              <button
                type="button"
                onClick={suggest}
                disabled={busy}
                className={ghostButtonClass}
              >
                <SearchIcon size={16} />
                {suggesting ? "Matching…" : "Suggest catalogue matches"}
              </button>
            </div>
          </>
        ) : null}

        {suggestions ? (
          suggestions.length === 0 ? (
            <p className="text-sm text-muted">
              No line on this invoice resembled anything in the catalogue.
            </p>
          ) : (
            <div>
              <p className="mb-2 text-sm font-medium">
                Possible matches, for you to check
              </p>
              <ul className="space-y-2">
                {suggestions.map((suggestion) => (
                  <li
                    key={suggestion.line}
                    className="rounded-lg border border-border bg-surface-muted/50 px-4 py-3"
                  >
                    <p className="truncate font-mono text-xs text-muted">
                      {suggestion.line}
                    </p>
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {suggestion.candidates.map((candidate) => (
                        <li key={candidate.componentId}>
                          <Link
                            href={`/parts/${candidate.componentId}`}
                            className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1 text-xs transition-colors hover:bg-surface-hover"
                          >
                            {candidate.name}
                            <span className="tabular-nums text-muted">
                              {Math.round(candidate.score * 100)}%
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          )
        ) : null}

        <p className="border-t border-border pt-4 text-xs text-muted">
          The extracted text makes this invoice findable later — searching
          &ldquo;ESP32&rdquo; will surface the bill it was on. This panel only
          suggests matches against the lines already on the order; to have the
          lines themselves read off a bill, start the order from{" "}
          <Link
            href="/orders/from-invoice"
            className="text-accent-text hover:underline"
          >
            an invoice
          </Link>{" "}
          instead, where each proposed line is confirmed before anything is
          recorded.
        </p>
      </div>
    </section>
  );
}
