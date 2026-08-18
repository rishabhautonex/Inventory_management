"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { takeOutAction } from "@/app/actions/stock";
import { undoMovementAction } from "@/app/actions/stock";
import { useToast } from "@/components/toast";

export type TakeOutTarget = {
  componentId: string;
  componentName: string;
  locationId: string;
  locationLabel: string;
  onHand: number;
};

/**
 * Flow 1, steps 3–6.
 *
 * Two steps only: "Using this?" then a quantity prefilled with 1. The spec is
 * blunt that anything adding a tap here should be pushed back on, so there is
 * no project picker, no person picker and no confirmation screen — the person
 * comes from the session and the project from the cupboard.
 *
 * Skipping straight to the quantity step is what the part detail page's Use
 * button does, since the intent is already unambiguous by then.
 */
export function TakeOutModal({
  target,
  startAtQuantity = false,
  onClose,
}: {
  target: TakeOutTarget;
  startAtQuantity?: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [step, setStep] = useState<"confirm" | "quantity">(
    startAtQuantity ? "quantity" : "confirm",
  );
  const [qty, setQty] = useState(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const qtyInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (step === "quantity") qtyInputRef.current?.select();
  }, [step]);

  const max = target.onHand;

  function clamp(next: number) {
    if (Number.isNaN(next)) return 1;
    return Math.min(Math.max(next, 1), Math.max(max, 1));
  }

  async function confirm() {
    setPending(true);
    setError(null);

    const result = await takeOutAction({
      componentId: target.componentId,
      locationId: target.locationId,
      qty,
    });

    if (!result.ok) {
      setError(result.error);
      setPending(false);
      return;
    }

    const movementId = result.data.movementId;
    onClose();
    router.refresh();

    toast.show({
      tone: "success",
      message: `Took ${qty} × ${target.componentName} from ${target.locationLabel}.`,
      action: {
        label: "Undo",
        run: async () => {
          const undo = await undoMovementAction(movementId);
          router.refresh();
          if (!undo.ok) {
            toast.show({ tone: "error", message: undo.error });
          } else {
            toast.show({
              tone: "success",
              message: `Put ${qty} back.`,
              duration: 4000,
            });
          }
        },
      },
    });
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-(--overlay) backdrop-blur-sm sm:items-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="take-out-title"
        className="safe-bottom w-full max-w-md rounded-t-2xl panel-glass p-5 sm:rounded-2xl"
      >
        <h2 id="take-out-title" className="text-lg font-semibold">
          {step === "confirm" ? "Using this?" : "How many?"}
        </h2>

        <p className="mt-1 text-sm text-muted">
          {target.componentName}
          <span className="mx-1.5 opacity-50">·</span>
          {target.locationLabel}
          <span className="mx-1.5 opacity-50">·</span>
          {max} in stock
        </p>

        {step === "confirm" ? (
          <div className="mt-5 grid grid-cols-2 gap-3">
            {/* "No" means "I actually wanted to look at it" — the spec's
                reasoning for sending them to the detail page. */}
            <button
              type="button"
              onClick={() => {
                onClose();
                router.push(`/parts/${target.componentId}`);
              }}
              className="min-h-14 rounded-xl border border-border bg-surface-muted text-base font-medium transition-colors hover:bg-surface-hover active:scale-[0.99]"
            >
              No
            </button>
            <button
              type="button"
              autoFocus
              onClick={() => setStep("quantity")}
              className="min-h-14 rounded-xl bg-accent text-base font-semibold text-accent-foreground transition-colors hover:bg-accent-hover active:scale-[0.99]"
            >
              Yes
            </button>
          </div>
        ) : (
          <>
            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                aria-label="One fewer"
                onClick={() => setQty((q) => clamp(q - 1))}
                disabled={qty <= 1}
                className="h-16 w-16 shrink-0 rounded-xl border border-border bg-surface-muted text-2xl font-semibold transition-colors hover:bg-surface-hover disabled:opacity-40"
              >
                −
              </button>

              <input
                ref={qtyInputRef}
                type="number"
                inputMode="numeric"
                min={1}
                max={Math.max(max, 1)}
                value={qty}
                onChange={(e) => setQty(clamp(Number(e.target.value)))}
                className="h-16 min-w-0 flex-1 rounded-xl border border-border bg-background text-center text-3xl font-semibold tabular-nums text-foreground outline-none [appearance:textfield] focus:border-accent [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                aria-label="Quantity"
              />

              <button
                type="button"
                aria-label="One more"
                onClick={() => setQty((q) => clamp(q + 1))}
                disabled={qty >= max}
                className="h-16 w-16 shrink-0 rounded-xl border border-border bg-surface-muted text-2xl font-semibold transition-colors hover:bg-surface-hover disabled:opacity-40"
              >
                +
              </button>
            </div>

            {error ? (
              <p
                role="alert"
                className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm font-medium text-danger"
              >
                {error}
              </p>
            ) : null}

            <div className="mt-4 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={onClose}
                className="min-h-14 rounded-xl border border-border bg-surface-muted text-base font-medium transition-colors hover:bg-surface-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={pending || max < 1}
                className="min-h-14 rounded-xl bg-accent text-base font-semibold text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50 active:scale-[0.99]"
              >
                {pending ? "Taking…" : `Take ${qty}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
