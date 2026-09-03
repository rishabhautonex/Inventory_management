"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { analyseBomAction, commitBomAction, type BomDraft } from "@/app/actions/bom";
import { ComponentPicker } from "@/components/component-picker";
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
  selectClass,
  textareaClass,
} from "@/components/ui";

/**
 * BOM import: read, review, save.
 *
 * The two phases mirror the invoice intake, and for the same reason. Reading
 * writes nothing; saving sends only what is on screen, so an edit made here is
 * the value that lands and nothing is re-read from the uploaded text.
 *
 * A row with no catalogue match cannot be saved into the BOM. The spec is
 * explicit that unmatched rows offer "create new part" rather than silently
 * creating one, and that offer is now in the picker itself: an admin catalogues
 * the missing part from the row — name and keywords, typed by a person — and
 * carries on down the list. A project head, who may upload a BOM but does not
 * run the catalogue, still gets the row and the reason, and no button.
 */

type Choice = { componentId: string; name: string; mpn: string | null };

type ReviewLine = {
  key: string;
  raw: string;
  identifier: string;
  note: string | null;
  matches: BomDraft["rows"][number]["matches"];
  /**
   * Which control is showing. A row with candidates offers the list; a row
   * with none goes straight to the search box, and the list can be abandoned
   * for the search box at any point.
   */
  mode: "matches" | "search";
  /** "" when nothing is chosen from the candidate list. */
  matchedId: string;
  /** What the reviewer found by searching themselves. */
  picked: Choice | null;
  qty: string;
  include: boolean;
};

const SAMPLE = `Part,MPN,Qty
ESP32 DevKit v1,ESP32-DEVKITC-32D,4
Jumper wire set 40pin,,2
Resistor 10k 1%,CFR-25JB-52-10K,50`;

export function BomImport({
  projectId,
  projectName,
  canCreateParts,
}: {
  projectId: string;
  projectName: string;
  /**
   * Whether this person may add to the catalogue. Uploading a BOM is open to a
   * project head, which is wider than the catalogue gate, so this cannot be
   * inferred from being on the screen.
   */
  canCreateParts: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [reading, startReading] = useTransition();
  const [saving, startSaving] = useTransition();

  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [draft, setDraft] = useState<BomDraft | null>(null);
  const [lines, setLines] = useState<ReviewLine[]>([]);
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function chooseFile(file: File | null) {
    if (!file) return;
    setError(null);
    setFileName(file.name);
    setText(await file.text());

    // A CSV is named for what it holds far more often than a BOM is named
    // afterwards, so the filename becomes the default and stays editable.
    if (name.trim() === "") setName(file.name.replace(/\.[^.]+$/, ""));
  }

  function read() {
    setError(null);

    startReading(async () => {
      const result = await analyseBomAction({ projectId, text });
      if (!result.ok) {
        setError(result.error);
        return;
      }

      setDraft(result.data);
      setLines(
        result.data.rows.map((row, index) => ({
          key: `row-${index}`,
          raw: row.raw,
          identifier: row.identifier,
          note: row.note,
          matches: row.matches,
          mode: row.matches.length > 0 ? "matches" : "search",
          matchedId: row.suggestedComponentId ?? "",
          picked: null,
          qty: row.qty === null ? "" : String(row.qty),
          include: true,
        })),
      );
      if (name.trim() === "") setName(`${projectName} BOM`);
    });
  }

  function patch(key: string, changes: Partial<ReviewLine>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...changes } : line)),
    );
  }

  function componentIdOf(line: ReviewLine): string | null {
    if (line.mode === "search") return line.picked?.componentId ?? null;
    return line.matchedId === "" ? null : line.matchedId;
  }

  const included = lines.filter((line) => line.include);
  const readyLines = included.filter(
    (line) => componentIdOf(line) !== null && Number(line.qty) > 0,
  );
  const blocked = included.length - readyLines.length;

  function save() {
    setError(null);

    if (readyLines.length === 0) {
      setError("Nothing is ready to save yet.");
      return;
    }
    if (blocked > 0) {
      setError(
        `${blocked} row${blocked === 1 ? " still needs" : "s still need"} a part and a quantity. Untick them, or fill them in.`,
      );
      return;
    }

    startSaving(async () => {
      const result = await commitBomAction({
        projectId,
        name: name.trim(),
        version: version.trim() || null,
        lines: readyLines.map((line) => ({
          componentId: componentIdOf(line)!,
          qtyNeeded: Math.floor(Number(line.qty)),
        })),
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      toast.show({
        tone: "success",
        message:
          result.data.merged > 0
            ? `Saved ${result.data.lines} lines, merging ${result.data.merged} duplicate${result.data.merged === 1 ? "" : "s"}.`
            : `Saved ${result.data.lines} lines.`,
      });
      router.push(`/projects/${projectId}?bom=${result.data.bomId}`);
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
            <span className="mb-1.5 block text-sm font-medium">
              A CSV file
            </span>
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
            <p className="mt-1.5 text-xs text-muted">
              Nothing to start from?{" "}
              <a
                href="/bom-template.csv"
                download
                className="font-medium text-accent-text underline underline-offset-2"
              >
                Download the template
              </a>{" "}
              — it opens in Excel and Google Sheets. Fill in your rows, then
              save it as CSV and upload it, or copy the cells and paste them
              below. An .xlsx workbook cannot be read directly.
            </p>
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
            hint="Straight out of a spreadsheet works — tabs, commas and semicolons are all recognised. One row per part, with something identifying it and a quantity."
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
            <Link href={`/projects/${projectId}`} className={secondaryButtonClass}>
              Cancel
            </Link>
          </div>

          <p className="text-xs text-muted">
            Reading changes nothing. Every row is matched against the catalogue
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
      <Card className="p-4 sm:p-6">
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <Badge tone="accent">{draft.rows.length} rows</Badge>
            <span>
              {draft.delimiter}-separated
              {draft.headerSkipped ? ", first line read as headings" : ""}
              {draft.droppedLines > 0
                ? `, ${draft.droppedLines} line${draft.droppedLines === 1 ? "" : "s"} skipped as having no part on them`
                : ""}
              .
            </span>
            {draft.unmatched > 0 ? (
              <Badge tone="warning">{draft.unmatched} unmatched</Badge>
            ) : null}
            {draft.missingQty > 0 ? (
              <Badge tone="warning">{draft.missingQty} without a quantity</Badge>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Field label="BOM name" required>
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`${projectName} BOM`}
              />
            </Field>
            <Field label="Version" hint="Optional">
              <input
                className={inputClass}
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="rev B"
              />
            </Field>
          </div>

          <ul className="space-y-3">
            {lines.map((line) => {
              const chosen = componentIdOf(line);
              const needsWork =
                line.include && (chosen === null || !(Number(line.qty) > 0));

              return (
                <li
                  key={line.key}
                  className={`rounded-lg border p-3 transition-colors ${
                    !line.include
                      ? "border-border bg-transparent opacity-60"
                      : needsWork
                        ? "border-warning/40 bg-warning/5"
                        : "border-border bg-surface-muted/50"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={line.include}
                      onChange={(e) =>
                        patch(line.key, { include: e.target.checked })
                      }
                      aria-label={`Include ${line.identifier}`}
                      className="mt-1 h-5 w-5 shrink-0 accent-[var(--accent)]"
                    />

                    <div className="min-w-0 flex-1">
                      <p className="min-w-0 truncate font-mono text-xs text-muted">
                        {line.raw}
                      </p>

                      {line.note ? (
                        <p className="mt-1 text-xs text-warning">{line.note}</p>
                      ) : null}

                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_6rem]">
                        <div>
                          <span className="mb-1 block text-xs font-medium text-muted">
                            Catalogue part
                          </span>

                          {line.mode === "matches" ? (
                            <select
                              className={selectClass}
                              value={line.matchedId}
                              disabled={!line.include}
                              onChange={(e) => {
                                if (e.target.value === "__search__") {
                                  patch(line.key, {
                                    mode: "search",
                                    matchedId: "",
                                    picked: null,
                                  });
                                } else {
                                  patch(line.key, { matchedId: e.target.value });
                                }
                              }}
                            >
                              <option value="">Not matched</option>
                              {line.matches.map((match) => (
                                <option
                                  key={match.componentId}
                                  value={match.componentId}
                                >
                                  {match.name}
                                  {match.mpn ? ` · ${match.mpn}` : ""}
                                  {match.via === "mpn" ? " (MPN match)" : ""}
                                </option>
                              ))}
                              <option value="__search__">
                                Search the catalogue…
                              </option>
                            </select>
                          ) : (
                            <>
                              <ComponentPicker
                                value={line.picked}
                                onChange={(choice) =>
                                  patch(line.key, { picked: choice })
                                }
                                canCreate={canCreateParts}
                                suggestedName={line.identifier}
                              />
                              {line.matches.length > 0 ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    patch(line.key, {
                                      mode: "matches",
                                      picked: null,
                                    })
                                  }
                                  className="mt-1.5 text-xs text-accent-text hover:underline"
                                >
                                  Back to the {line.matches.length} suggestion
                                  {line.matches.length === 1 ? "" : "s"}
                                </button>
                              ) : null}
                            </>
                          )}

                          {chosen === null && line.include ? (
                            <p className="mt-1.5 text-xs text-muted">
                              Nothing in the catalogue matches{" "}
                              <span className="font-medium">
                                {line.identifier}
                              </span>
                              .{" "}
                              {canCreateParts
                                ? "Search for it, or add it to the catalogue above."
                                : "A part has to exist before a BOM can ask for it — an admin can catalogue this one."}
                            </p>
                          ) : null}
                        </div>

                        <div>
                          <span className="mb-1 block text-xs font-medium text-muted">
                            Needed
                          </span>
                          <input
                            className={`${inputClass} tabular-nums`}
                            inputMode="numeric"
                            value={line.qty}
                            disabled={!line.include}
                            placeholder="—"
                            aria-label={`How many ${line.identifier}`}
                            onChange={(e) =>
                              patch(line.key, {
                                qty: e.target.value.replace(/[^\d]/g, ""),
                              })
                            }
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <ErrorText>{error}</ErrorText>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={saving || readyLines.length === 0 || name.trim() === ""}
              className={primaryButtonClass}
            >
              {saving
                ? "Saving…"
                : `Save ${readyLines.length} line${readyLines.length === 1 ? "" : "s"}`}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setLines([]);
                setError(null);
              }}
              disabled={saving}
              className={secondaryButtonClass}
            >
              Start again
            </button>

            {blocked > 0 ? (
              <p className="text-xs text-warning">
                {blocked} row{blocked === 1 ? "" : "s"} still need a part and a
                quantity.
              </p>
            ) : null}
          </div>
        </div>
      </Card>
    </div>
  );
}
