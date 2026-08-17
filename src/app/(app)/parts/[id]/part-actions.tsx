"use client";

import { useState } from "react";

import { TakeOutModal, type TakeOutTarget } from "@/components/take-out-modal";
import { secondaryButtonClass } from "@/components/ui";

type StockedLocation = {
  locationId: string;
  locationLabel: string;
  onHand: number;
};

/**
 * The prominent Use button the spec asks for on the detail page.
 *
 * When the part sits in one cupboard the button goes straight to the quantity
 * step — the user already chose the part by navigating here, so asking "using
 * this?" again would be the extra tap the spec warns against. With stock in
 * several cupboards it has to ask which one, because location is the one thing
 * that genuinely cannot be inferred.
 */
export function PartActions({
  componentId,
  componentName,
  locations,
}: {
  componentId: string;
  componentName: string;
  locations: StockedLocation[];
}) {
  const [target, setTarget] = useState<TakeOutTarget | null>(null);
  const [picking, setPicking] = useState(false);

  if (locations.length === 0) {
    return (
      <p className="mt-5 rounded-xl border border-border bg-surface-muted px-4 py-3 text-sm text-muted">
        Nothing in stock to take.
      </p>
    );
  }

  function use(location: StockedLocation) {
    setPicking(false);
    setTarget({
      componentId,
      componentName,
      locationId: location.locationId,
      locationLabel: location.locationLabel,
      onHand: location.onHand,
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() =>
          locations.length === 1 ? use(locations[0]) : setPicking(true)
        }
        className="mt-5 min-h-14 w-full rounded-xl bg-accent text-base font-semibold text-accent-foreground transition-colors hover:bg-accent-hover active:scale-[0.99]"
      >
        Use
      </button>

      {picking ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-(--overlay) backdrop-blur-sm sm:items-center"
          onClick={(event) => {
            if (event.target === event.currentTarget) setPicking(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Choose a location"
            className="safe-bottom w-full max-w-md rounded-t-2xl border border-border bg-surface p-5 shadow-(--shadow-panel) sm:rounded-2xl"
          >
            <h2 className="text-lg font-semibold">Take from where?</h2>
            <ul className="mt-3 divide-y divide-border">
              {locations.map((location) => (
                <li key={location.locationId}>
                  <button
                    type="button"
                    onClick={() => use(location)}
                    className="flex min-h-14 w-full items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-surface-muted active:bg-surface-hover"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {location.locationLabel}
                    </span>
                    <span className="shrink-0 text-lg font-semibold tabular-nums">
                      {location.onHand}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setPicking(false)}
              className={`${secondaryButtonClass} mt-4 w-full`}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {target ? (
        <TakeOutModal
          target={target}
          startAtQuantity
          onClose={() => setTarget(null)}
        />
      ) : null}
    </>
  );
}
