"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { createComponentAction } from "@/app/actions/admin";
import { PlusIcon, SearchIcon, XIcon } from "@/components/icons";
import { useToast } from "@/components/toast";
import {
  ErrorText,
  Field,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/ui";
import type { SearchHit } from "@/db/queries/search";

type Choice = { componentId: string; name: string; mpn: string | null };

type Draft = { name: string; mpn: string; keywords: string };

/**
 * Picks one catalogue part by fuzzy search, and — for somebody allowed to run
 * the catalogue — catalogues a missing one without leaving the screen.
 *
 * The spec asks for exactly that shape: "never auto-create components
 * silently. Unmatched rows offer 'create new part'." Nothing here is silent. A
 * person types the name, is shown everything that already matches it first,
 * and presses a button labelled with what it will add. What the shortcut
 * removes is the round trip to Admin and back, which meant abandoning a
 * half-reviewed invoice or BOM to make one part exist.
 *
 * Two things keep the catalogue findable, which is the only thing it is for:
 * the name is required, and the keywords field is offered on the way in rather
 * than left for a later visit nobody makes. Everything else about a part —
 * manufacturer, datasheet, photo — has nothing to do with finding it and can
 * wait for the part's own page.
 *
 * `canCreate` is passed rather than assumed. Most screens holding a picker are
 * already behind `canManageInventory`, but a BOM upload is open to a project
 * head and raising a request is open to everyone, and offering either of them
 * a button the server will refuse is worse than not offering it.
 */
export function ComponentPicker({
  value,
  onChange,
  canCreate = false,
  suggestedName = null,
}: {
  value: Choice | null;
  onChange: (choice: Choice | null) => void;
  /** Whether this person may add to the catalogue. Re-checked server-side. */
  canCreate?: boolean;
  /**
   * What the row under review calls the part — an invoice line, a BOM row, a
   * free-text request. Seeds the new-part form, so text somebody has already
   * typed once is not typed again.
   */
  suggestedName?: string | null;
}) {
  const toast = useToast();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Choice[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  /** Non-null while the new-part form is showing. */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, startSaving] = useTransition();
  const [createError, setCreateError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [open]);

  /**
   * Clearing is handled here rather than in the effect, matching the main
   * search screen: resetting state synchronously inside an effect body
   * cascades a second render on every keystroke.
   */
  function changeQuery(value: string) {
    setQuery(value);
    setOpen(true);

    if (value.trim() === "") {
      abortRef.current?.abort();
      setResults([]);
      setLoading(false);
    } else {
      setLoading(true);
    }
  }

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") return;

    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("Search failed");
        const body = (await response.json()) as { results: SearchHit[] };

        // Search returns one row per component-location pair; a picker wants
        // each component listed once.
        const seen = new Map<string, Choice>();
        for (const hit of body.results) {
          if (!seen.has(hit.componentId)) {
            seen.set(hit.componentId, {
              componentId: hit.componentId,
              name: hit.name,
              mpn: hit.mpn,
            });
          }
        }
        setResults([...seen.values()].slice(0, 8));
      } catch (error) {
        if ((error as Error).name !== "AbortError") setResults([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [query]);

  /**
   * Opens the new-part form, seeded with whatever already names the part: what
   * was typed into the search box, or failing that what the row under review
   * calls it.
   */
  function openDraft(seed: string) {
    setOpen(false);
    setCreateError(null);
    setDraft({ name: seed.trim(), mpn: "", keywords: "" });
  }

  function create() {
    if (!draft) return;
    setCreateError(null);

    const name = draft.name.trim();
    if (name === "") {
      setCreateError("Give the part a name.");
      return;
    }

    const mpn = draft.mpn.trim();
    const keywords = draft.keywords.trim();

    startSaving(async () => {
      const result = await createComponentAction({
        name,
        mpn: mpn === "" ? null : mpn,
        searchTerms: keywords === "" ? null : keywords,
      });

      if (!result.ok) {
        setCreateError(result.error);
        return;
      }

      const id = "id" in result ? result.id : undefined;
      if (!id) {
        setCreateError(
          `${name} was added to the catalogue, but could not be attached here. Search for it by name.`,
        );
        return;
      }

      // The id the action returns is the part this row now points at, so the
      // reviewer carries on from where they were rather than searching for
      // what they typed a moment ago.
      onChange({ componentId: id, name, mpn: mpn === "" ? null : mpn });
      setDraft(null);
      setQuery("");
      toast.show({ tone: "success", message: `${name} is in the catalogue.` });
    });
  }

  if (value) {
    return (
      <div className="flex min-h-11 items-center gap-2 rounded-lg border border-border bg-surface-muted px-3">
        <span className="min-w-0 flex-1 truncate text-sm">
          {value.name}
          {value.mpn ? (
            <span className="ml-2 font-mono text-xs text-muted">{value.mpn}</span>
          ) : null}
        </span>
        <button
          type="button"
          aria-label={`Clear ${value.name}`}
          onClick={() => {
            onChange(null);
            changeQuery("");
          }}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <XIcon size={16} />
        </button>
      </div>
    );
  }

  if (draft) {
    return (
      <div className="space-y-3 rounded-lg border border-accent/40 bg-surface-muted/60 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          New catalogue part
        </p>

        <Field label="Name" required>
          <input
            className={inputClass}
            value={draft.name}
            autoFocus
            placeholder="ESP32 DevKit v1"
            onChange={(e) =>
              setDraft((current) =>
                current ? { ...current, name: e.target.value } : current,
              )
            }
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="MPN" hint="Optional. Must be unique.">
            <input
              className={inputClass}
              value={draft.mpn}
              placeholder="ESP32-DEVKITC-32D"
              onChange={(e) =>
                setDraft((current) =>
                  current ? { ...current, mpn: e.target.value } : current,
                )
              }
            />
          </Field>

          <Field
            label="Search keywords"
            hint="Nicknames and spellings. The name is searched already."
          >
            <input
              className={inputClass}
              value={draft.keywords}
              placeholder="esp32 wifi devkit wroom"
              onChange={(e) =>
                setDraft((current) =>
                  current ? { ...current, keywords: e.target.value } : current,
                )
              }
            />
          </Field>
        </div>

        <ErrorText>{createError}</ErrorText>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={create}
            disabled={saving}
            className={primaryButtonClass}
          >
            <PlusIcon size={16} />
            {saving ? "Adding…" : "Add to the catalogue"}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(null);
              setCreateError(null);
            }}
            disabled={saving}
            className={secondaryButtonClass}
          >
            Cancel
          </button>
        </div>

        <p className="text-xs text-muted">
          Manufacturer, datasheet and photo can be filled in later on the
          part&rsquo;s own page. Adding a part puts nothing on a shelf.
        </p>
      </div>
    );
  }

  const typed = query.trim();
  const suggestion = suggestedName?.trim() ?? "";

  return (
    <div ref={containerRef} className="relative">
      <SearchIcon
        size={18}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
      />
      <input
        value={query}
        onChange={(e) => changeQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder="Search the catalogue…"
        aria-label="Search for a part"
        autoComplete="off"
        className={`${inputClass} pl-10`}
      />

      {/*
        A row that arrived naming a part nobody has catalogued gets the offer
        without typing that name into the search box first — it is the one
        search already known to come back with nothing.
      */}
      {canCreate && suggestion !== "" ? (
        <button
          type="button"
          onClick={() => openDraft(suggestion)}
          className="mt-1 inline-flex min-h-11 max-w-full items-center gap-1 text-xs font-medium text-accent-text hover:underline"
        >
          <PlusIcon size={12} className="shrink-0" />
          <span className="truncate">
            Add &ldquo;{suggestion}&rdquo; to the catalogue
          </span>
        </button>
      ) : null}

      {open && typed !== "" ? (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg panel-glass">
          {loading && results.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted">
              {canCreate
                ? "Nothing in the catalogue matches."
                : "No part matches. Ask an admin to catalogue it first."}
            </p>
          ) : (
            <ul className="max-h-64 overflow-y-auto">
              {results.map((choice) => (
                <li key={choice.componentId}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(choice);
                      setOpen(false);
                      setQuery("");
                    }}
                    className="flex min-h-11 w-full flex-col justify-center px-3 py-2 text-left transition-colors hover:bg-surface-muted"
                  >
                    <span className="truncate text-sm">{choice.name}</span>
                    {choice.mpn ? (
                      <span className="truncate font-mono text-xs text-muted">
                        {choice.mpn}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/*
            Under the results rather than instead of them, and only once the
            search has actually come back: the point of showing what already
            matches is that somebody about to add a second "10k resistor" sees
            the first one before they do it.
          */}
          {canCreate && !loading ? (
            <button
              type="button"
              onClick={() => openDraft(typed)}
              className="flex min-h-11 w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm font-medium text-accent-text transition-colors hover:bg-surface-muted"
            >
              <PlusIcon size={14} className="shrink-0" />
              <span className="truncate">
                Add &ldquo;{typed}&rdquo; to the catalogue
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
