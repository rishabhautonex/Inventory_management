"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { shelveLinesAction } from "@/app/actions/orders";
import { useToast } from "@/components/toast";
import {
  Badge,
  ErrorText,
  ProgressBar,
  primaryButtonClass,
  selectClass,
} from "@/components/ui";
import type { OrderDetail } from "@/db/queries/orders";

type Allocation = { include: boolean; locationId: string; qty: string };

/**
 * Putting an order away — the one place a purchase becomes stock.
 *
 * Receiving can be partial in both directions the spec asks for: a subset of the
 * lines, and less than the full quantity of a line. Each line remembers what has
 * already arrived because that is derived from the receipts, so coming back
 * tomorrow for the rest just works.
 */
export function ShelvePanel({
  order,
  locations,
}: {
  order: OrderDetail;
  locations: Array<{ id: string; path: string }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const outstanding = order.lines.filter((line) => line.remainingQty > 0);

  const [allocations, setAllocations] = useState<Record<string, Allocation>>(
    () =>
      Object.fromEntries(
        outstanding.map((line) => [
          line.id,
          {
            include: true,
            locationId: locations[0]?.id ?? "",
            qty: String(line.remainingQty),
          },
        ]),
      ),
  );

  function patch(lineId: string, next: Partial<Allocation>) {
    setAllocations((current) => ({
      ...current,
      [lineId]: { ...current[lineId], ...next },
    }));
  }

  function setAllLocations(locationId: string) {
    setAllocations((current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, allocation]) => [
          id,
          { ...allocation, locationId },
        ]),
      ),
    );
  }

  const chosen = outstanding.filter((line) => allocations[line.id]?.include);

  function submit() {
    setError(null);

    const prepared = chosen.map((line) => ({
      orderLineId: line.id,
      locationId: allocations[line.id].locationId,
      qty: Math.floor(Number(allocations[line.id].qty)),
    }));

    if (prepared.length === 0) {
      setError("Tick at least one line to put away.");
      return;
    }
    if (prepared.some((a) => !a.locationId)) {
      setError("Choose where each ticked line is going.");
      return;
    }
    if (prepared.some((a) => !Number.isInteger(a.qty) || a.qty <= 0)) {
      setError("Quantities must be whole pieces, at least one.");
      return;
    }

    startTransition(async () => {
      const result = await shelveLinesAction({
        orderId: order.id,
        allocations: prepared,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      toast.show({
        tone: "success",
        message: result.data.shelvedComplete
          ? "Whole order put away and recorded."
          : "Recorded. The rest of the order is still outstanding.",
      });
      router.refresh();
    });
  }

  if (outstanding.length === 0) {
    return (
      <section className="panel rounded-xl">
        <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-5">
          <h2 className="text-base font-semibold">Putting it away</h2>
          <Badge tone="positive">All done</Badge>
        </header>
        <p className="px-4 pb-5 text-sm text-muted sm:px-5">
          Every line has reached a shelf. The receipts are in the log, and undoing
          one there reopens the line here.
        </p>
      </section>
    );
  }

  const blocked = order.channel === "online" && order.status !== "delivered";

  return (
    <section className="panel rounded-xl">
      <header className="px-4 py-4 sm:px-5">
        <h2 className="text-base font-semibold">Putting it away</h2>
        <p className="mt-1 text-sm text-muted">
          This is what records the stock. One receipt per line, at the shelf you
          choose.
        </p>
      </header>

      {blocked ? (
        <p className="mx-4 mb-5 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning sm:mx-5">
          Mark the order delivered first — that is the point at which the box has
          actually arrived.
        </p>
      ) : (
        <div className="border-t border-border p-4 sm:p-5">
          {locations.length > 1 ? (
            <label className="mb-4 block">
              <span className="mb-1.5 block text-sm font-medium">
                Send everything to
              </span>
              <select
                className={selectClass}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) setAllLocations(e.target.value);
                }}
              >
                <option value="">Choose a shelf for every line…</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.path}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <ul className="space-y-3">
            {outstanding.map((line) => {
              const allocation = allocations[line.id];

              return (
                <li
                  key={line.id}
                  className="rounded-lg border border-border bg-surface-muted/50 p-3"
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={allocation.include}
                      onChange={(e) =>
                        patch(line.id, { include: e.target.checked })
                      }
                      aria-label={`Put ${line.componentName} away`}
                      className="mt-1 h-5 w-5 shrink-0 accent-[var(--accent)]"
                    />

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {line.componentName}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {line.shelvedQty > 0
                          ? `${line.shelvedQty} of ${line.qty} already put away — ${line.remainingQty} to go`
                          : `${line.qty} ordered`}
                      </p>

                      {line.shelvedQty > 0 ? (
                        <div className="mt-2">
                          <ProgressBar
                            value={line.shelvedQty}
                            max={line.qty}
                            tone="positive"
                            label={`${line.componentName} put away`}
                          />
                        </div>
                      ) : null}

                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
                        <label className="block">
                          <span className="mb-1 block text-xs font-medium text-muted">
                            Onto
                          </span>
                          <select
                            className={selectClass}
                            value={allocation.locationId}
                            disabled={!allocation.include}
                            onChange={(e) =>
                              patch(line.id, { locationId: e.target.value })
                            }
                          >
                            <option value="">Choose a shelf…</option>
                            {locations.map((location) => (
                              <option key={location.id} value={location.id}>
                                {location.path}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="block">
                          <span className="mb-1 block text-xs font-medium text-muted">
                            How many
                          </span>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={line.remainingQty}
                            step={1}
                            className={selectClass}
                            value={allocation.qty}
                            disabled={!allocation.include}
                            onChange={(e) =>
                              patch(line.id, { qty: e.target.value })
                            }
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 space-y-4">
            <ErrorText>{error}</ErrorText>

            <button
              type="button"
              onClick={submit}
              disabled={pending || chosen.length === 0}
              className={primaryButtonClass}
            >
              {pending
                ? "Recording…"
                : `Put ${chosen.length} line${chosen.length === 1 ? "" : "s"} away`}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
