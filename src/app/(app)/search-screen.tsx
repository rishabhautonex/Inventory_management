"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { TakeOutModal, type TakeOutTarget } from "@/components/take-out-modal";
import { SearchIcon, XIcon } from "@/components/icons";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import type { SearchHit } from "@/db/queries/search";

/**
 * Screen 1 — the default landing page.
 *
 * The search box is focused on mount and each result is one component at one
 * location, so the sequence from opening the app to a recorded movement is:
 * type, tap the row, tap Yes, confirm the number.
 */
export function SearchScreen() {
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [target, setTarget] = useState<TakeOutTarget | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /**
   * Clearing is handled here rather than in the effect: resetting state
   * synchronously inside an effect body triggers a cascading re-render, and on
   * a screen that re-renders on every keystroke that is worth avoiding.
   */
  function changeQuery(value: string) {
    setQuery(value);

    if (value.trim() === "") {
      abortRef.current?.abort();
      setResults([]);
      setSearched(false);
      setLoading(false);
    } else {
      setLoading(true);
    }
  }

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") return;

    const timer = setTimeout(async () => {
      // Cancel the previous keystroke's request so a slow early response
      // cannot overwrite the results for what the user has since typed.
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
        setResults(body.results);
        setSearched(true);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setResults([]);
          setSearched(true);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [query]);

  function openRow(hit: SearchHit) {
    // Nothing to take from an empty shelf; go straight to the detail page so
    // the user can see where else it lives.
    if (hit.onHand <= 0 || !hit.locationId) {
      router.push(`/parts/${hit.componentId}`);
      return;
    }

    setTarget({
      componentId: hit.componentId,
      componentName: hit.name,
      locationId: hit.locationId,
      locationLabel: hit.locationPath ?? hit.locationName ?? "Unknown location",
      onHand: hit.onHand,
    });
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader
        title="Search parts"
        description="One row per part per cupboard. Tap the row for the cupboard you are standing at."
      />

      {/* Sticky so the box stays reachable while thumbing through a long list. */}
      <div className="sticky top-16 z-10 -my-2 bg-background py-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
          <input
            ref={inputRef}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="Search by name, part number or keyword…"
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            className="h-14 w-full rounded-xl border border-border bg-surface pl-12 pr-14 text-base text-foreground outline-none transition-colors placeholder:text-muted focus:border-accent [&::-webkit-search-cancel-button]:appearance-none"
            aria-label="Search parts"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                changeQuery("");
                inputRef.current?.focus();
              }}
              className="absolute right-1.5 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              <XIcon />
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-6">
        {query.trim() === "" ? (
          <Card>
            <EmptyState
              title="Start typing to find a part"
              description="Search matches names, part numbers, manufacturers and the keywords an admin has added — so a nickname or a misspelling still lands."
            />
          </Card>
        ) : loading && results.length === 0 ? (
          <Card>
            <p className="py-14 text-center text-sm text-muted">Searching…</p>
          </Card>
        ) : results.length === 0 && searched ? (
          <Card>
            <EmptyState
              title={`No parts match “${query.trim()}”`}
              description="It may not be catalogued yet, or it may be filed under a different name. An admin can add it — and can widen its search keywords so the next person finds it."
            />
            {/* Raising a part request lands here once flow 3 is built. */}
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-border">
              {results.map((hit) => (
                <ResultRow
                  key={`${hit.componentId}:${hit.locationId ?? "none"}`}
                  hit={hit}
                  onSelect={() => openRow(hit)}
                />
              ))}
            </ul>
          </Card>
        )}
      </div>

      {target ? (
        <TakeOutModal target={target} onClose={() => setTarget(null)} />
      ) : null}
    </div>
  );
}

function ResultRow({
  hit,
  onSelect,
}: {
  hit: SearchHit;
  onSelect: () => void;
}) {
  const empty = hit.onHand <= 0;
  const low = hit.minQty !== null && hit.onHand <= hit.minQty && !empty;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="flex min-h-16 w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-surface-muted/50 active:bg-surface-muted"
      >
        <div className="min-w-0 flex-1">
          <p
            className={`truncate text-base font-medium ${empty ? "text-muted" : ""}`}
          >
            {hit.name}
          </p>
          <p className="truncate text-sm text-muted">
            {hit.locationPath ?? "Not stocked anywhere yet"}
            {hit.projectName ? (
              <>
                <span className="mx-1.5 opacity-50">·</span>
                {hit.projectName}
              </>
            ) : null}
          </p>
        </div>

        <div className="hidden shrink-0 sm:block">
          <Badge tone={empty ? "danger" : low ? "warning" : "positive"}>
            {empty ? "Out of stock" : low ? "Low stock" : "In stock"}
          </Badge>
        </div>

        <div className="w-14 shrink-0 text-right">
          <span
            className={`text-xl font-semibold tabular-nums ${
              empty ? "text-muted" : low ? "text-warning" : "text-foreground"
            }`}
          >
            {hit.onHand}
          </span>
          <p className="text-xs text-muted sm:hidden">
            {empty ? "out" : low ? "low" : "in stock"}
          </p>
        </div>
      </button>
    </li>
  );
}
