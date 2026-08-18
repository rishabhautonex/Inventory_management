"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  analyseComponentImportAction,
  commitComponentImportAction,
  type ImportDraft,
} from "@/app/actions/parts-import";
import { useToast } from "@/components/toast";
import { UploadIcon } from "@/components/icons";
import {
  Badge,
  Card,
  ErrorText,
  Field,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  textareaClass,
} from "@/components/ui";

/**
 * Catalogue import: read, review, save.
 *
 * The same two phases as the BOM import and the invoice intake, for the same
 * reason — reading writes nothing, and saving sends only what is on screen, so
 * an edit made here is the value that lands.
 *
 * Two things are deliberately awkward rather than convenient. A row with no name
 * cannot be saved, because a nameless part is unfindable and finding parts is
 * the only thing this catalogue is for. And a row the catalogue already holds
 * arrives unticked with the existing part named beside it: the reviewer's file is
 * usually a mix of new and known, and the useful answer is which is which.
 */

type ReviewRow = {
  key: string;
  lineNumber: number;
  raw: string;
  problems: string[];
  existing: ImportDraft["rows"][number]["existing"];
  include: boolean;
  name: string;
  mpn: string;
  manufacturer: string;
  category: string;
  searchTerms: string;
  productUrl: string;
  datasheetUrl: string;
  notes: string;
};

const SAMPLE = `Name,MPN,Manufacturer,Category,Search terms,Product URL
ESP32 DevKit v1,ESP32-DEVKITC-32D,Espressif,Dev board,esp32 esp 32 wifi ble devkit,https://robu.in/product/esp32
IR proximity sensor,TCRT5000,Vishay,Sensor,ir infrared proximity line follower,
Resistor 10k 1% 1/4W,CFR-25JB-52-10K,Yageo,Passive,resistor 10k 10 kilo ohm quarter watt,`;

const FIELD_LABEL: Record<string, string> = {
  name: "Name",
  mpn: "Part number",
  manufacturer: "Manufacturer",
  category: "Category",
  searchTerms: "Search terms",
  productUrl: "Product link",
  datasheetUrl: "Datasheet",
  notes: "Notes",
};

export function PartsImportForm() {
  const router = useRouter();
  const toast = useToast();
  const [reading, startReading] = useTransition();
  const [saving, startSaving] = useTransition();

  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function chooseFile(file: File | null) {
    if (!file) return;
    setError(null);
    setFileName(file.name);
    setText(await file.text());
  }

  function read() {
    setError(null);

    startReading(async () => {
      const result = await analyseComponentImportAction({ text });
      if (!result.ok) {
        setError(result.error);
        return;
      }

      setDraft(result.data);
      setRows(
        result.data.rows.map((row, index) => ({
          key: `row-${index}`,
          lineNumber: row.lineNumber,
          raw: row.raw,
          problems: row.problems,
          existing: row.existing,
          // A part already in the catalogue starts unticked: importing it again
          // is the one outcome nobody wants, and the database would refuse it.
          include: row.existing === null,
          name: row.name ?? "",
          mpn: row.mpn ?? "",
          manufacturer: row.manufacturer ?? "",
          category: row.category ?? "",
          searchTerms: row.searchTerms ?? "",
          productUrl: row.productUrl ?? "",
          datasheetUrl: row.datasheetUrl ?? "",
          notes: row.notes ?? "",
        })),
      );
    });
  }

  function patch(key: string, changes: Partial<ReviewRow>) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...changes } : row)),
    );
  }

  const included = rows.filter((row) => row.include);
  const ready = included.filter((row) => row.name.trim() !== "");
  const blocked = included.length - ready.length;
  const noKeywords = ready.filter((row) => row.searchTerms.trim() === "").length;

  function save() {
    setError(null);

    if (ready.length === 0) {
      setError("Tick at least one row, and give every ticked row a name.");
      return;
    }
    if (blocked > 0) {
      setError(
        `${blocked} ticked row${blocked === 1 ? "" : "s"} still ${blocked === 1 ? "has" : "have"} no name. Type one, or untick.`,
      );
      return;
    }

    startSaving(async () => {
      const result = await commitComponentImportAction({
        rows: ready.map((row) => ({
          name: row.name.trim(),
          mpn: row.mpn.trim() || null,
          manufacturer: row.manufacturer.trim() || null,
          category: row.category.trim() || null,
          searchTerms: row.searchTerms.trim() || null,
          productUrl: row.productUrl.trim() || null,
          datasheetUrl: row.datasheetUrl.trim() || null,
          notes: row.notes.trim() || null,
        })),
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      toast.show({
        tone: "success",
        message: `Added ${result.data.created} part${result.data.created === 1 ? "" : "s"} to the catalogue.`,
      });
      router.push("/admin/parts");
      router.refresh();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Phase 1 — read                                                      */
  /* ------------------------------------------------------------------ */

  if (!draft) {
    return (
      <Card className="p-4 sm:p-6">
        <div className="space-y-5">
          <div>
            <span className="mb-1.5 block text-sm font-medium">A CSV file</span>
            <input
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
              onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-muted file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-lg file:border file:border-border file:bg-surface file:px-4 file:text-sm file:font-medium file:text-foreground hover:file:bg-surface-hover"
            />
            {fileName ? (
              <span className="mt-1.5 block text-xs text-muted">
                Read {fileName}. Check it below before importing.
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              or paste it
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <Field
            label="Paste a table"
            hint="Straight out of a spreadsheet works — tabs, commas and semicolons are all recognised. Name the columns in the first row: anything not named cannot be imported, because guessing which column held a manufacturer is how a catalogue fills up with fields nobody typed."
          >
            <textarea
              className={`${textareaClass} min-h-40 font-mono text-xs`}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setFileName(null);
              }}
              placeholder={SAMPLE}
              spellCheck={false}
            />
          </Field>

          <ErrorText>{error}</ErrorText>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={read}
              disabled={reading || text.trim() === ""}
              className={primaryButtonClass}
            >
              <UploadIcon size={16} />
              {reading ? "Reading…" : "Read it"}
            </button>
            <Link href="/admin/parts" className={secondaryButtonClass}>
              Cancel
            </Link>
          </div>

          <p className="text-xs text-muted">
            Reading changes nothing. Every row is checked against the catalogue
            and shown to you before any of it is saved.
          </p>
        </div>
      </Card>
    );
  }

  /* ------------------------------------------------------------------ */
  /* Phase 2 — review                                                    */
  /* ------------------------------------------------------------------ */

  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold">
            {draft.rows.length} row{draft.rows.length === 1 ? "" : "s"}
          </span>
          <span className="text-muted">
            {draft.delimiter}-separated
            {draft.headerSkipped ? ", first row read as headings" : ", no heading row"}
            {draft.droppedLines > 0
              ? ` · ${draft.droppedLines} line${draft.droppedLines === 1 ? "" : "s"} had no part on them`
              : ""}
          </span>
          {draft.duplicates > 0 ? (
            <Badge tone="warning">
              {draft.duplicates} already in the catalogue
            </Badge>
          ) : null}
          {draft.needName > 0 ? (
            <Badge tone="danger">{draft.needName} need a name</Badge>
          ) : null}
        </div>

        <p className="mt-2 text-xs text-muted">
          Imported columns:{" "}
          {draft.mappedFields.map((f) => FIELD_LABEL[f] ?? f).join(", ")}.
          {draft.unmappedHeadings.length > 0
            ? ` Ignored: ${draft.unmappedHeadings.join(", ")} — nothing in the catalogue holds those.`
            : ""}
        </p>

        {noKeywords > 0 ? (
          <p className="mt-2 text-xs text-warning">
            {noKeywords} ticked row{noKeywords === 1 ? " has" : "s have"} no search
            terms. The part will still be listed, but it will only be findable by
            its name and part number — fill them in here if you can.
          </p>
        ) : null}
      </Card>

      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.key}>
            <Card
              className={`p-4 ${row.include ? "" : "opacity-60"}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={row.include}
                  onChange={(e) => patch(row.key, { include: e.target.checked })}
                  aria-label={`Import row ${row.lineNumber}`}
                  className="mt-2.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
                />

                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted">
                      Row {row.lineNumber}
                    </span>
                    {row.existing ? (
                      <Badge tone="warning">
                        Already catalogued
                        {row.existing.via === "mpn"
                          ? " (same part number)"
                          : " (same name)"}
                      </Badge>
                    ) : null}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Name">
                      <input
                        className={inputClass}
                        value={row.name}
                        onChange={(e) => patch(row.key, { name: e.target.value })}
                        placeholder="Nothing in the file — type it"
                      />
                    </Field>
                    <Field label="Part number">
                      <input
                        className={inputClass}
                        value={row.mpn}
                        onChange={(e) => patch(row.key, { mpn: e.target.value })}
                      />
                    </Field>
                  </div>

                  <Field
                    label="Search terms"
                    hint="How people will actually look for it — every spelling, abbreviation and synonym worth trying."
                  >
                    <input
                      className={inputClass}
                      value={row.searchTerms}
                      onChange={(e) =>
                        patch(row.key, { searchTerms: e.target.value })
                      }
                    />
                  </Field>

                  <details className="rounded-lg border border-border px-3 py-2">
                    <summary className="cursor-pointer text-xs font-medium text-muted">
                      Manufacturer, category, links, notes
                    </summary>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <Field label="Manufacturer">
                        <input
                          className={inputClass}
                          value={row.manufacturer}
                          onChange={(e) =>
                            patch(row.key, { manufacturer: e.target.value })
                          }
                        />
                      </Field>
                      <Field label="Category">
                        <input
                          className={inputClass}
                          value={row.category}
                          onChange={(e) =>
                            patch(row.key, { category: e.target.value })
                          }
                        />
                      </Field>
                      <Field label="Product link">
                        <input
                          className={inputClass}
                          value={row.productUrl}
                          onChange={(e) =>
                            patch(row.key, { productUrl: e.target.value })
                          }
                        />
                      </Field>
                      <Field label="Datasheet">
                        <input
                          className={inputClass}
                          value={row.datasheetUrl}
                          onChange={(e) =>
                            patch(row.key, { datasheetUrl: e.target.value })
                          }
                        />
                      </Field>
                      <div className="sm:col-span-2">
                        <Field label="Notes">
                          <input
                            className={inputClass}
                            value={row.notes}
                            onChange={(e) =>
                              patch(row.key, { notes: e.target.value })
                            }
                          />
                        </Field>
                      </div>
                    </div>
                  </details>

                  {row.existing ? (
                    <p className="text-xs text-muted">
                      The catalogue already has{" "}
                      <Link
                        href={`/parts/${row.existing.componentId}`}
                        className="text-accent-text hover:underline"
                      >
                        {row.existing.name}
                      </Link>
                      . Leave this unticked unless it is genuinely a different
                      part.
                    </p>
                  ) : null}

                  {row.problems.length > 0 ? (
                    <ul className="space-y-0.5 text-xs text-warning">
                      {row.problems.map((problem, i) => (
                        <li key={i}>{problem}</li>
                      ))}
                    </ul>
                  ) : null}

                  <p className="truncate font-mono text-[11px] text-muted opacity-70">
                    {row.raw}
                  </p>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>

      <Card className="p-4 sm:p-5">
        <ErrorText>{error}</ErrorText>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={saving || ready.length === 0}
            className={primaryButtonClass}
          >
            {saving
              ? "Saving…"
              : `Add ${ready.length} part${ready.length === 1 ? "" : "s"}`}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(null);
              setRows([]);
              setError(null);
            }}
            className={secondaryButtonClass}
          >
            Start again
          </button>
          <span className="text-xs text-muted">
            {rows.length - included.length} skipped
            {blocked > 0 ? ` · ${blocked} ticked but unnamed` : ""}
          </span>
        </div>
      </Card>
    </div>
  );
}
