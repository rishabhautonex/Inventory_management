"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  analyseInvoiceAction,
  commitInvoiceIntakeAction,
  type IntakeDraft,
} from "@/app/actions/invoice-intake";
import { useToast } from "@/components/toast";
import { UploadIcon, XIcon } from "@/components/icons";
import {
  Badge,
  ErrorText,
  Field,
  ghostButtonClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  selectClass,
  type Tone,
} from "@/components/ui";
import type { Confidence } from "@/lib/invoice-extract";
import type { MatchCandidate } from "@/lib/invoice-match";
import { ComponentPicker } from "../new/component-picker";

type Choice = { componentId: string; name: string; mpn: string | null };

type ReviewLine = {
  key: string;
  raw: string;
  description: string;
  confidence: Confidence;
  reason: string;
  matches: MatchCandidate[];
  include: boolean;
  /** "matched" picks from what the invoice matched; "search" opens the picker. */
  mode: "matched" | "search";
  matchedId: string;
  searched: Choice | null;
  qty: string;
  unitPrice: string;
  locationId: string;
};

const CONFIDENCE_TONE: Record<Confidence, Tone> = {
  high: "positive",
  medium: "warning",
  low: "danger",
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "Numbers check out",
  medium: "Check this",
  low: "Needs a quantity",
};

export function InvoiceIntake({
  projects,
  locations,
}: {
  projects: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; path: string }>;
}) {
  const router = useRouter();
  const toast = useToast();

  const fileRef = useRef<HTMLInputElement>(null);
  const [analysing, startAnalyse] = useTransition();
  const [saving, startSave] = useTransition();

  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Header fields, seeded from the draft and editable from then on.
  const [vendorName, setVendorName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [channel, setChannel] = useState<"online" | "offline">("online");
  const [orderDate, setOrderDate] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [putAway, setPutAway] = useState(true);
  const [lines, setLines] = useState<ReviewLine[]>([]);

  /** Which header fields the invoice filled in, so the UI can say so. */
  const [detected, setDetected] = useState<Set<string>>(new Set());

  function analyse() {
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose an invoice file first.");
      return;
    }

    const formData = new FormData();
    formData.set("file", file);

    startAnalyse(async () => {
      const result = await analyseInvoiceAction(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }

      const found = result.data;
      setDraft(found);

      setVendorName(found.vendorName ?? "");
      setOrderDate(found.invoiceDate ?? "");
      setExpectedDate("");
      setTrackingNumber(found.trackingNumber ?? "");
      setTrackingUrl(found.trackingUrl ?? "");
      setTotalAmount(found.totalAmount === null ? "" : String(found.totalAmount));
      // A tracking number on the invoice means it was shipped to us.
      setChannel(found.trackingNumber || found.trackingUrl ? "online" : "offline");

      setDetected(
        new Set(
          [
            found.vendorName ? "vendor" : null,
            found.invoiceDate ? "orderDate" : null,
            found.totalAmount !== null ? "totalAmount" : null,
            found.trackingNumber ? "trackingNumber" : null,
            found.trackingUrl ? "trackingUrl" : null,
          ].filter((key): key is string => key !== null),
        ),
      );

      setLines(
        found.lines.map((line, index) => ({
          key: `line-${index}`,
          raw: line.raw,
          description: line.description,
          confidence: line.confidence,
          reason: line.reason,
          matches: line.matches,
          // A line with no catalogue match starts unticked: there is nothing to
          // record against, and silently dropping it would be worse than
          // showing it greyed out with a reason.
          include: line.matches.length > 0,
          mode: line.matches.length > 0 ? "matched" : "search",
          matchedId: line.matches[0]?.componentId ?? "",
          searched: null,
          qty: line.qty === null ? "" : String(line.qty),
          unitPrice: line.unitPrice === null ? "" : String(line.unitPrice),
          locationId: "",
        })),
      );
    });
  }

  function patch(key: string, next: Partial<ReviewLine>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...next } : line)),
    );
  }

  function setAllLocations(locationId: string) {
    setLines((current) => current.map((line) => ({ ...line, locationId })));
  }

  function componentIdOf(line: ReviewLine): string | null {
    return line.mode === "search"
      ? (line.searched?.componentId ?? null)
      : line.matchedId || null;
  }

  const chosen = lines.filter((line) => line.include);

  function save() {
    setError(null);
    if (!draft) return;

    const prepared = chosen.map((line) => ({
      componentId: componentIdOf(line) ?? "",
      qty: Math.floor(Number(line.qty)),
      unitPrice: line.unitPrice.trim() === "" ? null : Number(line.unitPrice),
      locationId: line.locationId || null,
    }));

    if (prepared.length === 0) {
      setError("Tick at least one line, and give it a catalogue part.");
      return;
    }
    if (prepared.some((line) => !line.componentId)) {
      setError("Every ticked line needs a catalogue part.");
      return;
    }
    if (prepared.some((line) => !Number.isInteger(line.qty) || line.qty <= 0)) {
      setError(
        "Every ticked line needs a whole quantity of at least one. Lines the invoice could not be read for are blank on purpose.",
      );
      return;
    }
    if (putAway && prepared.some((line) => !line.locationId)) {
      setError("Choose a cupboard for every ticked line, or untick “put away now”.");
      return;
    }

    startSave(async () => {
      const result = await commitInvoiceIntakeAction({
        stagedPath: draft.stagedPath,
        mime: draft.mime,
        ocrText: draft.ocrText,
        vendorName: vendorName.trim() || null,
        projectId: projectId || null,
        channel,
        orderDate: orderDate || null,
        expectedDate: expectedDate || null,
        trackingNumber: trackingNumber.trim() || null,
        trackingUrl: trackingUrl.trim() || null,
        totalAmount: totalAmount.trim() === "" ? null : Number(totalAmount),
        putAway,
        lines: prepared,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      toast.show({
        tone: "success",
        message: result.data.putAway
          ? "Order recorded and stock put away."
          : "Order recorded. Put it away when the box arrives.",
      });
      router.push(`/orders/${result.data.orderId}`);
      router.refresh();
    });
  }

  function detectedHint(key: string, fallback?: string): string | undefined {
    return detected.has(key) ? "Read from the invoice — check it." : fallback;
  }

  const unreadable = lines.filter(
    (line) => line.include && line.qty.trim() === "",
  ).length;

  return (
    <>
      <section className="rounded-xl border border-border bg-surface p-4 sm:p-6">
        <h2 className="text-base font-semibold">Upload the invoice</h2>
        <p className="mt-1 text-sm text-muted">
          A PDF or a photo of the bill. Everything found on it is shown for you to
          confirm before anything is saved.
        </p>

        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
          className="mt-4 block w-full cursor-pointer rounded-lg border border-border bg-surface-muted text-sm text-muted file:mr-3 file:cursor-pointer file:rounded-l-lg file:border-0 file:bg-surface-hover file:px-4 file:py-3 file:text-sm file:font-medium file:text-foreground"
        />

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={analyse}
            disabled={analysing}
            className={primaryButtonClass}
          >
            <UploadIcon size={16} />
            {analysing ? "Reading the invoice…" : "Read the invoice"}
          </button>
        </div>

        {analysing ? (
          <p className="mt-3 text-sm text-muted">
            Text extraction on a photo or a scanned PDF takes a few seconds.
          </p>
        ) : null}

        {!draft ? (
          <div className="mt-4">
            <ErrorText>{error}</ErrorText>
          </div>
        ) : null}
      </section>

      {draft ? (
        <div
          className="fixed inset-0 z-40 overflow-y-auto bg-(--overlay) backdrop-blur-sm"
          onClick={(event) => {
            if (event.target === event.currentTarget) setDraft(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="intake-title"
            className="mx-auto my-4 w-[calc(100%-1rem)] max-w-5xl rounded-2xl border border-border bg-surface shadow-(--shadow-panel) sm:my-8 sm:w-[calc(100%-3rem)]"
          >
            <header className="sticky top-0 z-10 flex items-start justify-between gap-3 rounded-t-2xl border-b border-border bg-surface px-4 py-4 sm:px-6">
              <div>
                <h2 id="intake-title" className="text-lg font-semibold">
                  Check what was found
                </h2>
                <p className="mt-0.5 text-sm text-muted">
                  {draft.lines.length} line
                  {draft.lines.length === 1 ? "" : "s"} read from the invoice.
                  Nothing is saved until you confirm.
                </p>
              </div>
              <button
                type="button"
                aria-label="Discard"
                onClick={() => setDraft(null)}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                <XIcon />
              </button>
            </header>

            <div className="space-y-6 px-4 py-5 sm:px-6">
              {draft.ocrNote ? (
                <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
                  {draft.ocrNote}
                </p>
              ) : null}

              <div>
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
                  The invoice
                </h3>

                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <Field label="Vendor" hint={detectedHint("vendor")}>
                    <input
                      className={inputClass}
                      value={vendorName}
                      onChange={(e) => setVendorName(e.target.value)}
                      placeholder="Robu.in"
                    />
                  </Field>

                  <Field
                    label="Project"
                    hint="Decides which cupboard this belongs to."
                  >
                    <select
                      className={selectClass}
                      value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                    >
                      <option value="">General shelf</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field label="Invoice date" hint={detectedHint("orderDate")}>
                    <input
                      className={inputClass}
                      type="date"
                      value={orderDate}
                      onChange={(e) => setOrderDate(e.target.value)}
                    />
                  </Field>

                  <Field
                    label="Invoice total"
                    hint={detectedHint("totalAmount", "Including shipping and tax.")}
                  >
                    <input
                      className={inputClass}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      value={totalAmount}
                      onChange={(e) => setTotalAmount(e.target.value)}
                    />
                  </Field>

                  <Field label="How it was bought">
                    <select
                      className={selectClass}
                      value={channel}
                      onChange={(e) =>
                        setChannel(e.target.value as "online" | "offline")
                      }
                    >
                      <option value="online">Online</option>
                      <option value="offline">In person</option>
                    </select>
                  </Field>

                  <Field label="Expected by" hint="Optional. Flags it as overdue.">
                    <input
                      className={inputClass}
                      type="date"
                      value={expectedDate}
                      onChange={(e) => setExpectedDate(e.target.value)}
                    />
                  </Field>

                  <Field
                    label="Tracking number"
                    hint={detectedHint("trackingNumber")}
                  >
                    <input
                      className={inputClass}
                      value={trackingNumber}
                      onChange={(e) => setTrackingNumber(e.target.value)}
                    />
                  </Field>

                  <Field label="Tracking link" hint={detectedHint("trackingUrl")}>
                    <input
                      className={inputClass}
                      type="url"
                      inputMode="url"
                      value={trackingUrl}
                      onChange={(e) => setTrackingUrl(e.target.value)}
                    />
                  </Field>
                </div>
              </div>

              <div>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
                    What was on it
                  </h3>
                  {locations.length > 1 ? (
                    <select
                      className={`${selectClass} sm:w-72`}
                      defaultValue=""
                      aria-label="Send every line to one cupboard"
                      onChange={(e) => {
                        if (e.target.value) setAllLocations(e.target.value);
                      }}
                    >
                      <option value="">Send everything to one cupboard…</option>
                      {locations.map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.path}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>

                {lines.length === 0 ? (
                  <p className="rounded-lg border border-border bg-surface-muted/50 px-4 py-4 text-sm text-muted">
                    No line items could be picked out of this invoice. You can
                    still record the order by hand and attach the file to it.
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {lines.map((line) => (
                      <li
                        key={line.key}
                        className={`rounded-lg border p-3 transition-colors ${
                          line.include
                            ? "border-border bg-surface-muted/50"
                            : "border-border bg-transparent opacity-60"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={line.include}
                            onChange={(e) =>
                              patch(line.key, { include: e.target.checked })
                            }
                            aria-label={`Include ${line.description}`}
                            className="mt-1 h-5 w-5 shrink-0 accent-[var(--accent)]"
                          />

                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="min-w-0 truncate font-mono text-xs text-muted">
                                {line.raw}
                              </p>
                              <Badge tone={CONFIDENCE_TONE[line.confidence]}>
                                {CONFIDENCE_LABEL[line.confidence]}
                              </Badge>
                            </div>

                            {line.confidence !== "high" ? (
                              <p className="mt-1 text-xs text-muted">
                                {line.reason}
                              </p>
                            ) : null}

                            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1.4fr)_5rem_7rem_minmax(0,1.2fr)]">
                              <div>
                                <span className="mb-1 block text-xs font-medium text-muted">
                                  Catalogue part
                                </span>

                                {line.mode === "matched" ? (
                                  <select
                                    className={selectClass}
                                    value={line.matchedId}
                                    disabled={!line.include}
                                    onChange={(e) => {
                                      if (e.target.value === "__search__") {
                                        patch(line.key, { mode: "search" });
                                      } else {
                                        patch(line.key, {
                                          matchedId: e.target.value,
                                        });
                                      }
                                    }}
                                  >
                                    {line.matches.map((match) => (
                                      <option
                                        key={match.componentId}
                                        value={match.componentId}
                                      >
                                        {match.name} ·{" "}
                                        {Math.round(match.score * 100)}%
                                      </option>
                                    ))}
                                    <option value="__search__">
                                      Search for a different part…
                                    </option>
                                  </select>
                                ) : (
                                  <ComponentPicker
                                    value={line.searched}
                                    onChange={(choice) =>
                                      patch(line.key, { searched: choice })
                                    }
                                  />
                                )}
                              </div>

                              <div>
                                <span className="mb-1 block text-xs font-medium text-muted">
                                  Qty
                                </span>
                                <input
                                  type="number"
                                  inputMode="numeric"
                                  min={1}
                                  step={1}
                                  className={selectClass}
                                  value={line.qty}
                                  disabled={!line.include}
                                  placeholder="—"
                                  onChange={(e) =>
                                    patch(line.key, { qty: e.target.value })
                                  }
                                />
                              </div>

                              <div>
                                <span className="mb-1 block text-xs font-medium text-muted">
                                  Unit price
                                </span>
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  min={0}
                                  step="0.01"
                                  className={selectClass}
                                  value={line.unitPrice}
                                  disabled={!line.include}
                                  onChange={(e) =>
                                    patch(line.key, { unitPrice: e.target.value })
                                  }
                                />
                              </div>

                              <div>
                                <span className="mb-1 block text-xs font-medium text-muted">
                                  Cupboard
                                </span>
                                <select
                                  className={selectClass}
                                  value={line.locationId}
                                  disabled={!line.include}
                                  onChange={(e) =>
                                    patch(line.key, { locationId: e.target.value })
                                  }
                                >
                                  <option value="">Choose a shelf…</option>
                                  {locations.map((location) => (
                                    <option key={location.id} value={location.id}>
                                      {location.path}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>

                            {line.matches.length === 0 ? (
                              <p className="mt-2 text-xs text-warning">
                                Nothing in the catalogue resembles this. Search for
                                it, or leave it unticked and add the part under
                                Admin first.
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <details className="rounded-lg border border-border bg-surface-muted/50">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                  The text this was read from
                </summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border px-4 py-3 font-mono text-xs text-muted">
                  {draft.ocrText}
                </pre>
              </details>
            </div>

            <footer className="sticky bottom-0 space-y-4 rounded-b-2xl border-t border-border bg-surface px-4 py-4 sm:px-6">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={putAway}
                  onChange={(e) => setPutAway(e.target.checked)}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
                />
                <span className="text-sm">
                  Put the stock away now
                  <span className="block text-xs text-muted">
                    Records a receipt per line at the cupboard chosen above. Leave
                    this off if the parts have not physically arrived yet.
                  </span>
                </span>
              </label>

              {unreadable > 0 ? (
                <p className="text-xs text-warning">
                  {unreadable} ticked line
                  {unreadable === 1 ? " has" : "s have"} no quantity — the invoice
                  was not clear enough to read one. Type it before saving.
                </p>
              ) : null}

              <ErrorText>{error}</ErrorText>

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || chosen.length === 0}
                  className={primaryButtonClass}
                >
                  {saving
                    ? "Saving…"
                    : putAway
                      ? `Confirm ${chosen.length} line${chosen.length === 1 ? "" : "s"} and put away`
                      : `Record order with ${chosen.length} line${chosen.length === 1 ? "" : "s"}`}
                </button>
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  className={secondaryButtonClass}
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={() => router.push("/orders/new")}
                  className={ghostButtonClass}
                >
                  Enter it by hand instead
                </button>
              </div>
            </footer>
          </div>
        </div>
      ) : null}
    </>
  );
}
