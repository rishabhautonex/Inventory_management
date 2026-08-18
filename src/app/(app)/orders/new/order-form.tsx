"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { createOrderAction } from "@/app/actions/orders";
import { useToast } from "@/components/toast";
import { PlusIcon, XIcon } from "@/components/icons";
import {
  ErrorText,
  Field,
  ghostButtonClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  selectClass,
} from "@/components/ui";
import { ComponentPicker } from "@/components/component-picker";

type Choice = { componentId: string; name: string; mpn: string | null };

type DraftLine = {
  key: string;
  choice: Choice | null;
  qty: string;
  unitPrice: string;
};

export function OrderForm({
  projects,
  vendors,
}: {
  projects: Array<{ id: string; name: string }>;
  vendors: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const nextKey = useRef(1);
  const [lines, setLines] = useState<DraftLine[]>([
    { key: "line-0", choice: null, qty: "1", unitPrice: "" },
  ]);

  const [vendorName, setVendorName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [channel, setChannel] = useState<"online" | "offline">("online");
  const [orderDate, setOrderDate] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [error, setError] = useState<string | null>(null);

  function addLine() {
    setLines((current) => [
      ...current,
      {
        key: `line-${nextKey.current++}`,
        choice: null,
        qty: "1",
        unitPrice: "",
      },
    ]);
  }

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  function removeLine(key: string) {
    setLines((current) => current.filter((line) => line.key !== key));
  }

  const filled = lines.filter((line) => line.choice !== null);

  /**
   * Sum of the lines, shown next to the invoice total.
   *
   * They are allowed to differ — the schema notes that the invoice total may
   * exceed the line sum because of shipping and tax — so this is displayed for
   * comparison rather than used to fill the total in.
   */
  const lineSum = filled.reduce((sum, line) => {
    const qty = Number(line.qty) || 0;
    const price = Number(line.unitPrice) || 0;
    return sum + qty * price;
  }, 0);

  function submit() {
    setError(null);

    const prepared = filled.map((line) => ({
      componentId: line.choice!.componentId,
      qty: Math.floor(Number(line.qty)),
      unitPrice: line.unitPrice.trim() === "" ? null : Number(line.unitPrice),
    }));

    if (prepared.length === 0) {
      setError("Add at least one line with a part on it.");
      return;
    }
    if (prepared.some((line) => !Number.isInteger(line.qty) || line.qty <= 0)) {
      setError("Every line needs a whole quantity of at least one.");
      return;
    }

    startTransition(async () => {
      const result = await createOrderAction({
        vendorName: vendorName.trim() || undefined,
        projectId: projectId || null,
        channel,
        orderDate: orderDate || null,
        expectedDate: expectedDate || null,
        trackingNumber: trackingNumber.trim() || null,
        trackingUrl: trackingUrl.trim() || null,
        totalAmount: totalAmount.trim() === "" ? null : Number(totalAmount),
        lines: prepared,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      toast.show({ tone: "success", message: "Order recorded." });
      router.push(`/orders/${result.data.orderId}`);
      router.refresh();
    });
  }

  return (
    <>
      <section className="space-y-5 panel rounded-xl p-4 sm:p-6">
        <h2 className="text-base font-semibold">Where it came from</h2>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="Vendor" hint="A new name is added to the vendor list.">
            <input
              className={inputClass}
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              placeholder="Robu.in"
              list="vendor-names"
              autoFocus
            />
            <datalist id="vendor-names">
              {vendors.map((v) => (
                <option key={v.id} value={v.name} />
              ))}
            </datalist>
          </Field>

          <Field
            label="Project"
            hint="Decides the destination cupboard. Leave blank for the general shelf."
          >
            <select
              className={selectClass}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">General shelf</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="How it was bought"
            hint={
              channel === "offline"
                ? "Bought in person — it can be put away straight away."
                : "Ordered online — mark it delivered when the box arrives."
            }
          >
            <select
              className={selectClass}
              value={channel}
              onChange={(e) => setChannel(e.target.value as "online" | "offline")}
            >
              <option value="online">Online</option>
              <option value="offline">In person</option>
            </select>
          </Field>

          <Field label="Invoice total" hint="Including shipping and tax, in ₹.">
            <input
              className={inputClass}
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={totalAmount}
              onChange={(e) => setTotalAmount(e.target.value)}
              placeholder="0.00"
            />
          </Field>

          <Field label="Ordered on">
            <input
              className={inputClass}
              type="date"
              value={orderDate}
              onChange={(e) => setOrderDate(e.target.value)}
            />
          </Field>

          <Field label="Expected by" hint="Used to flag the order as overdue.">
            <input
              className={inputClass}
              type="date"
              value={expectedDate}
              onChange={(e) => setExpectedDate(e.target.value)}
            />
          </Field>

          {channel === "online" ? (
            <>
              <Field label="Tracking number">
                <input
                  className={inputClass}
                  value={trackingNumber}
                  onChange={(e) => setTrackingNumber(e.target.value)}
                />
              </Field>

              <Field label="Tracking link">
                <input
                  className={inputClass}
                  type="url"
                  inputMode="url"
                  value={trackingUrl}
                  onChange={(e) => setTrackingUrl(e.target.value)}
                  placeholder="https://…"
                />
              </Field>
            </>
          ) : null}
        </div>
      </section>

      <section className="mt-4 panel rounded-xl p-4 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">What was bought</h2>
          <button type="button" onClick={addLine} className={ghostButtonClass}>
            <PlusIcon size={16} />
            Add line
          </button>
        </div>

        <p className="mt-1 text-sm text-muted">
          Quantities here are what was ordered. Nothing reaches a shelf until the
          order is put away.
        </p>

        <ul className="mt-4 space-y-3">
          {lines.map((line) => (
            <li
              key={line.key}
              className="rounded-lg border border-border bg-surface-muted/50 p-3"
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_6rem_8rem_auto] sm:items-end">
                <Field label="Part">
                  <ComponentPicker
                    value={line.choice}
                    onChange={(choice) => updateLine(line.key, { choice })}
                  />
                </Field>

                <Field label="Qty">
                  <input
                    className={inputClass}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={line.qty}
                    onChange={(e) => updateLine(line.key, { qty: e.target.value })}
                  />
                </Field>

                <Field label="Unit price">
                  <input
                    className={inputClass}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={line.unitPrice}
                    onChange={(e) =>
                      updateLine(line.key, { unitPrice: e.target.value })
                    }
                    placeholder="0.00"
                  />
                </Field>

                <button
                  type="button"
                  aria-label="Remove this line"
                  onClick={() => removeLine(line.key)}
                  disabled={lines.length === 1}
                  className="flex h-11 w-11 items-center justify-center rounded-lg border border-border text-muted transition-colors hover:bg-surface-hover hover:text-danger disabled:opacity-40"
                >
                  <XIcon size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>

        {lineSum > 0 ? (
          <div className="mt-4 flex justify-end gap-6 border-t border-border pt-4 text-sm">
            <span className="text-muted">Lines add up to</span>
            <span className="font-semibold tabular-nums">
              ₹{lineSum.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
            </span>
          </div>
        ) : null}
      </section>

      <div className="mt-4 space-y-4">
        <ErrorText>{error}</ErrorText>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className={primaryButtonClass}
            onClick={submit}
            disabled={pending || filled.length === 0}
          >
            {pending ? "Saving…" : "Record order"}
          </button>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => router.push("/orders")}
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
