"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { ChevronDownIcon, FilterIcon } from "@/components/icons";
import { Badge, Field, secondaryButtonClass, selectClass } from "@/components/ui";
import type { MovementReason } from "@/db/queries/movements";
import { formatReason } from "@/lib/format";

type Options = {
  people: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; path: string }>;
};

const KEYS = ["person", "project", "location", "reason", "from", "to"];

/**
 * Filters live in the URL so a filtered log can be linked to and survives a
 * refresh. Collapsed by default because the log is usually opened to see the
 * last few movements, not to run a query.
 */
export function LogFilterBar({
  options,
  reasons,
}: {
  options: Options;
  reasons: MovementReason[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  function update(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    router.push(`${pathname}?${next}`);
  }

  const activeCount = KEYS.filter((key) => searchParams.get(key)).length;

  return (
    <div className="rounded-xl border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-12 w-full items-center gap-2.5 px-4 text-sm font-medium text-muted transition-colors hover:text-foreground"
      >
        <FilterIcon size={18} />
        Filters
        {activeCount > 0 ? <Badge tone="accent">{activeCount}</Badge> : null}
        <ChevronDownIcon
          size={18}
          className={`ml-auto transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div className="grid grid-cols-1 gap-4 border-t border-border p-4 sm:grid-cols-2 lg:grid-cols-3">
          <Select
            label="Person"
            value={searchParams.get("person") ?? ""}
            onChange={(v) => update("person", v)}
            options={options.people.map((p) => ({ value: p.id, label: p.name }))}
          />
          <Select
            label="Project"
            value={searchParams.get("project") ?? ""}
            onChange={(v) => update("project", v)}
            options={options.projects.map((p) => ({ value: p.id, label: p.name }))}
          />
          <Select
            label="Location"
            value={searchParams.get("location") ?? ""}
            onChange={(v) => update("location", v)}
            options={options.locations.map((l) => ({ value: l.id, label: l.path }))}
          />
          <Select
            label="Reason"
            value={searchParams.get("reason") ?? ""}
            onChange={(v) => update("reason", v)}
            options={reasons.map((r) => ({ value: r, label: formatReason(r) }))}
          />
          <Field label="From">
            <input
              type="date"
              value={searchParams.get("from") ?? ""}
              onChange={(e) => update("from", e.target.value)}
              className={selectClass}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              value={searchParams.get("to") ?? ""}
              onChange={(e) => update("to", e.target.value)}
              className={selectClass}
            />
          </Field>

          {activeCount > 0 ? (
            <button
              type="button"
              onClick={() => router.push(pathname)}
              className={`${secondaryButtonClass} sm:col-span-2 lg:col-span-3`}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={selectClass}
      >
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
