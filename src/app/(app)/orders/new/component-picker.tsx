"use client";

import { useEffect, useRef, useState } from "react";

import { SearchIcon, XIcon } from "@/components/icons";
import { inputClass } from "@/components/ui";
import type { SearchHit } from "@/db/queries/search";

type Choice = { componentId: string; name: string; mpn: string | null };

/**
 * Picks one catalogue part by fuzzy search.
 *
 * Deliberately search-only, with no "create new part" shortcut: a part invented
 * mid-order would arrive with no search keywords, and an unfindable part is the
 * one failure mode the catalogue exists to prevent. Adding it properly is two
 * clicks away under Admin.
 */
export function ComponentPicker({
  value,
  onChange,
}: {
  value: Choice | null;
  onChange: (choice: Choice | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Choice[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

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

      {open && query.trim() !== "" ? (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-border bg-surface shadow-(--shadow-panel)">
          {loading && results.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted">
              No part matches. Catalogue it under Admin first.
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
        </div>
      ) : null}
    </div>
  );
}
