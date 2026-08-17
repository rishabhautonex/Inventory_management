"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setThresholdAction } from "@/app/actions/admin";
import { returnStockAction, setStockCountAction } from "@/app/actions/stock";
import { useToast } from "@/components/toast";
import {
  Badge,
  ErrorText,
  Field,
  ghostButtonClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  selectClass,
} from "@/components/ui";

export type StockRow = {
  locationId: string;
  locationPath: string;
  projectName: string | null;
  onHand: number;
  minQty: number | null;
};

export type LocationOption = { id: string; path: string };

/** The big stepper input shared by both quantity fields in this file. */
const stepperInputClass =
  "h-14 min-w-0 flex-1 rounded-xl border border-border bg-background text-center text-2xl font-semibold tabular-nums text-foreground outline-none [appearance:textfield] focus:border-accent [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

const stepperButtonClass =
  "h-14 w-14 shrink-0 rounded-xl border border-border bg-surface-muted text-2xl font-semibold transition-colors hover:bg-surface-hover disabled:opacity-40";

/**
 * The "Where it is" table, plus the two ways stock gets back in.
 *
 * Putting a part back is open to everyone — the person who took it out is the
 * one holding it. Correcting a count is admin-only and always demands a note,
 * because an adjustment is the one movement that has no physical event behind
 * it and is therefore the one a reader will most want explained.
 */
export function StockPanel({
  componentId,
  stock,
  locations,
  isAdmin,
}: {
  componentId: string;
  stock: StockRow[];
  locations: LocationOption[];
  isAdmin: boolean;
}) {
  const [returning, setReturning] = useState(false);
  const [correcting, setCorrecting] = useState<StockRow | null>(null);

  return (
    <section className="rounded-xl border border-border bg-surface">
      <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-5">
        <h2 className="text-base font-semibold">Where it is</h2>
        <button
          type="button"
          onClick={() => setReturning(true)}
          className={ghostButtonClass}
        >
          Put back
        </button>
      </header>

      {stock.length === 0 ? (
        <p className="px-4 pb-5 text-sm text-muted sm:px-5">
          This part has never been stocked anywhere yet.
        </p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {stock.map((row) => {
            const empty = row.onHand <= 0;
            const low = !empty && row.minQty !== null && row.onHand <= row.minQty;

            return (
              <li
                key={row.locationId}
                className="flex items-center gap-3 px-4 py-3.5 sm:px-5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {row.locationPath}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {row.projectName ?? "General shelf"}
                    {row.minQty !== null ? ` · min ${row.minQty}` : ""}
                  </p>
                </div>

                {empty || low ? (
                  <Badge tone={empty ? "danger" : "warning"}>
                    {empty ? "Out" : "Low"}
                  </Badge>
                ) : null}

                <span
                  className={`w-10 shrink-0 text-right text-lg font-semibold tabular-nums ${
                    empty ? "text-muted" : low ? "text-warning" : "text-foreground"
                  }`}
                >
                  {row.onHand}
                </span>

                {isAdmin ? (
                  <button
                    type="button"
                    onClick={() => setCorrecting(row)}
                    className={ghostButtonClass}
                  >
                    Correct
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {returning ? (
        <ReturnModal
          componentId={componentId}
          stock={stock}
          locations={locations}
          onClose={() => setReturning(false)}
        />
      ) : null}

      {correcting ? (
        <CorrectModal
          componentId={componentId}
          row={correcting}
          onClose={() => setCorrecting(null)}
        />
      ) : null}
    </section>
  );
}

function Sheet({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-(--overlay) backdrop-blur-sm sm:items-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="safe-bottom w-full max-w-md rounded-t-2xl border border-border bg-surface p-5 shadow-(--shadow-panel) sm:rounded-2xl"
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function ReturnModal({
  componentId,
  stock,
  locations,
  onClose,
}: {
  componentId: string;
  stock: StockRow[];
  locations: LocationOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  // Default to wherever the part already lives; that is nearly always where it
  // is going back.
  const [locationId, setLocationId] = useState(
    stock[0]?.locationId ?? locations[0]?.id ?? "",
  );
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await returnStockAction({
        componentId,
        locationId,
        qty,
        note,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      onClose();
      router.refresh();
      toast.show({ tone: "success", message: `Put ${qty} back.` });
    });
  }

  return (
    <Sheet title="Put back" onClose={onClose}>
      <div className="mt-4 space-y-4">
        <Field label="Where">
          <select
            className={selectClass}
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.path}
              </option>
            ))}
          </select>
        </Field>

        <Field label="How many">
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="One fewer"
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              disabled={qty <= 1}
              className={stepperButtonClass}
            >
              −
            </button>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              value={qty}
              onChange={(e) =>
                setQty(Math.max(1, Math.floor(Number(e.target.value)) || 1))
              }
              className={stepperInputClass}
              aria-label="Quantity"
            />
            <button
              type="button"
              aria-label="One more"
              onClick={() => setQty((q) => q + 1)}
              className={stepperButtonClass}
            >
              +
            </button>
          </div>
        </Field>

        <Field label="Note" hint="Optional.">
          <input
            className={inputClass}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Unused from the Falcon build"
          />
        </Field>

        <ErrorText>{error}</ErrorText>

        <div className="grid grid-cols-2 gap-3">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending || !locationId}
            className={primaryButtonClass}
          >
            {pending ? "Saving…" : `Put ${qty} back`}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function CorrectModal({
  componentId,
  row,
  onClose,
}: {
  componentId: string;
  row: StockRow;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [count, setCount] = useState(row.onHand);
  const [note, setNote] = useState("");
  const [minQty, setMinQty] = useState(
    row.minQty === null ? "" : String(row.minQty),
  );
  const [error, setError] = useState<string | null>(null);

  const delta = count - row.onHand;

  function submit() {
    setError(null);
    startTransition(async () => {
      if (delta !== 0) {
        const result = await setStockCountAction({
          componentId,
          locationId: row.locationId,
          targetCount: count,
          note,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
      }

      const trimmedMin = minQty.trim();
      const nextMin = trimmedMin === "" ? null : Number(trimmedMin);
      const changedMin = nextMin !== row.minQty;

      if (changedMin) {
        const result = await setThresholdAction({
          componentId,
          locationId: row.locationId,
          minQty: nextMin,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
      }

      if (delta === 0 && !changedMin) {
        setError("Nothing changed.");
        return;
      }

      onClose();
      router.refresh();
      toast.show({ tone: "success", message: "Updated." });
    });
  }

  return (
    <Sheet title="Correct the count" onClose={onClose}>
      <p className="mt-1 text-sm text-muted">{row.locationPath}</p>

      <div className="mt-4 space-y-4">
        <Field
          label="Actual count on the shelf"
          hint={
            delta === 0
              ? `Currently recorded as ${row.onHand}.`
              : `Records an adjustment of ${delta > 0 ? "+" : ""}${delta}.`
          }
        >
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={count}
            onChange={(e) =>
              setCount(Math.max(0, Math.floor(Number(e.target.value)) || 0))
            }
            className={`${stepperInputClass} w-full`}
          />
        </Field>

        <Field
          label="Why"
          required
          hint="An adjustment has no physical event behind it, so it needs an explanation."
        >
          <input
            className={inputClass}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Recount after stocktake"
          />
        </Field>

        <Field
          label="Low-stock minimum"
          hint="Leave blank for none. Warns when stock here drops to this level."
        >
          <input
            type="number"
            inputMode="numeric"
            min={0}
            className={inputClass}
            value={minQty}
            onChange={(e) => setMinQty(e.target.value)}
            placeholder="None"
          />
        </Field>

        <ErrorText>{error}</ErrorText>

        <div className="grid grid-cols-2 gap-3">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending || (delta !== 0 && !note.trim())}
            className={primaryButtonClass}
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
