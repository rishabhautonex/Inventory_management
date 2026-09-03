"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  addOrderLineAction,
  removeOrderLineAction,
  updateOrderLineAction,
} from "@/app/actions/orders";
import { ComponentPicker } from "@/components/component-picker";
import { useToast } from "@/components/toast";
import { PencilIcon, PlusIcon, XIcon } from "@/components/icons";
import {
  ErrorText,
  Field,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/ui";

type Line = {
  id: string;
  componentName: string;
  qty: number;
  unitPrice: number | null;
  shelvedQty: number;
};

/**
 * Correcting the lines on an existing order.
 *
 * Safe to offer because an order is an intention, not stock: editing a line
 * writes nothing to the ledger and moves nothing on a shelf. Before this existed,
 * a mistyped quantity meant cancelling the order and typing it again.
 *
 * What the screen will not let you do is contradict the cupboard. A quantity
 * cannot go below what has already been put away, and a line with receipts
 * against it cannot be removed — the server refuses both, and the row says so
 * before you try, because being told after committing to the edit is worse.
 */
export function LineEditor({
  orderId,
  lines,
  editable,
}: {
  orderId: string;
  lines: Line[];
  /** False for a cancelled order: its lines are a record, not a draft. */
  editable: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, startBusy] = useTransition();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [choice, setChoice] = useState<{
    componentId: string;
    name: string;
    mpn: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!editable) return null;

  function beginEdit(line: Line) {
    setAdding(false);
    setEditingId(line.id);
    setQty(String(line.qty));
    setPrice(line.unitPrice === null ? "" : String(line.unitPrice));
    setError(null);
  }

  function beginAdd() {
    setEditingId(null);
    setAdding(true);
    setQty("1");
    setPrice("");
    setChoice(null);
    setError(null);
  }

  function readNumbers(): { qty: number; unitPrice: number | null } | null {
    const amount = Number(qty);
    if (!Number.isInteger(amount) || amount <= 0) {
      setError("A line needs a whole quantity, at least one.");
      return null;
    }

    const trimmed = price.trim();
    if (trimmed === "") return { qty: amount, unitPrice: null };

    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 0) {
      setError("A unit price is a number, zero or more.");
      return null;
    }

    return { qty: amount, unitPrice: value };
  }

  function save(line: Line) {
    setError(null);
    const numbers = readNumbers();
    if (!numbers) return;

    if (numbers.qty < line.shelvedQty) {
      setError(
        `${line.shelvedQty} are already on a shelf. Undo that receipt in the log before going below it.`,
      );
      return;
    }

    startBusy(async () => {
      const result = await updateOrderLineAction({
        orderLineId: line.id,
        ...numbers,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditingId(null);
      toast.show({ tone: "success", message: `${line.componentName} updated.` });
      router.refresh();
    });
  }

  function add() {
    setError(null);

    if (!choice) {
      setError("Pick the part this line is for.");
      return;
    }

    const numbers = readNumbers();
    if (!numbers) return;

    startBusy(async () => {
      const result = await addOrderLineAction({
        orderId,
        componentId: choice.componentId,
        ...numbers,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAdding(false);
      toast.show({ tone: "success", message: "Line added." });
      router.refresh();
    });
  }

  function remove(line: Line) {
    setError(null);

    startBusy(async () => {
      const result = await removeOrderLineAction(line.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.show({
        tone: "success",
        message: `${line.componentName} removed from this order.`,
      });
      router.refresh();
    });
  }

  const editing = lines.find((line) => line.id === editingId) ?? null;

  return (
    <div className="border-t border-border px-4 py-4 sm:px-5">
      {editing ? (
        <div className="space-y-3">
          <p className="text-sm font-medium">{editing.componentName}</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Ordered"
              hint={
                editing.shelvedQty > 0
                  ? `${editing.shelvedQty} already put away — this cannot go below that.`
                  : "What the invoice or the order confirmation says."
              }
            >
              <input
                type="number"
                inputMode="numeric"
                min={Math.max(editing.shelvedQty, 1)}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className={`${inputClass} tabular-nums`}
                autoFocus
              />
            </Field>

            <Field label="Unit price" hint="INR. Leave blank if the invoice does not break it down.">
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className={`${inputClass} tabular-nums`}
              />
            </Field>
          </div>

          <ErrorText>{error}</ErrorText>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => save(editing)}
              disabled={busy}
              className={primaryButtonClass}
            >
              {busy ? "Saving…" : "Save line"}
            </button>
            <button
              type="button"
              onClick={() => setEditingId(null)}
              disabled={busy}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
            {lines.length > 1 && editing.shelvedQty === 0 ? (
              <button
                type="button"
                onClick={() => remove(editing)}
                disabled={busy}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3.5 text-sm font-medium text-danger transition-colors hover:bg-danger/10"
              >
                <XIcon size={14} />
                Remove line
              </button>
            ) : null}
          </div>
        </div>
      ) : adding ? (
        <div className="space-y-3">
          <Field
            label="Part"
            hint="An order line needs a real catalogue part. One can be added from the search box."
          >
            {/* Only rendered for somebody who `canManageInventory`, which is
                the gate `createComponentAction` re-checks server-side. */}
            <ComponentPicker value={choice} onChange={setChoice} canCreate />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Ordered">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className={`${inputClass} tabular-nums`}
              />
            </Field>
            <Field label="Unit price" hint="INR. Optional.">
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className={`${inputClass} tabular-nums`}
              />
            </Field>
          </div>

          <ErrorText>{error}</ErrorText>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={add}
              disabled={busy}
              className={primaryButtonClass}
            >
              {busy ? "Adding…" : "Add line"}
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              disabled={busy}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <ErrorText>{error}</ErrorText>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              Correct a line
            </span>
            {lines.map((line) => (
              <button
                key={line.id}
                type="button"
                onClick={() => beginEdit(line)}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                <PencilIcon size={14} />
                {line.componentName}
              </button>
            ))}
            <button
              type="button"
              onClick={beginAdd}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              <PlusIcon size={14} />
              Add a line
            </button>
          </div>

          <p className="text-xs text-muted">
            Editing a line changes what was ordered, never what is on a shelf.
            Stock only moves through a receipt, and only Undo in the log takes one
            back.
          </p>
        </div>
      )}
    </div>
  );
}
