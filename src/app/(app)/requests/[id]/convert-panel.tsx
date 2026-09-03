"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { convertRequestToOrderAction } from "@/app/actions/requests";
import { ComponentPicker } from "@/components/component-picker";
import { useToast } from "@/components/toast";
import { ReceiptIcon } from "@/components/icons";
import {
  ErrorText,
  Field,
  Panel,
  inputClass,
  primaryButtonClass,
  selectClass,
} from "@/components/ui";

type Choice = { componentId: string; name: string; mpn: string | null };

/**
 * Turns an approved request into a purchase.
 *
 * What it produces is an ordinary order — same table, same lines, same
 * receiving flow — so nothing downstream has to know a request was involved.
 * Stock still appears only when somebody puts the line away.
 *
 * The quantity is editable because buying is not always granting: a request for
 * four when they come in packs of five is a real thing that happens, and the
 * order should record what was actually bought.
 *
 * A request raised as free text arrives here with no part at all, and used to
 * be a dead end — an order line needs a real catalogue part, and there was
 * nowhere to say which one it turned out to be. Now the panel asks, with the
 * requester's own words seeding the new-part form, so "a 7.5in e-paper display"
 * becomes a catalogued part and an order in one sitting. The request's wording
 * is not overwritten: what was asked for and what was bought are two facts.
 */
export function ConvertPanel({
  requestId,
  componentId,
  label,
  qty,
  vendors,
}: {
  requestId: string;
  /** The part the request names, or null when it was raised as free text. */
  componentId: string | null;
  /** What the request calls the part — the catalogue name, or the free text. */
  label: string;
  qty: number;
  vendors: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  /** Only used when the request names no part of its own. */
  const [choice, setChoice] = useState<Choice | null>(null);
  const [vendorName, setVendorName] = useState("");
  const [channel, setChannel] = useState<"online" | "offline">("online");
  const [orderQty, setOrderQty] = useState(String(qty));
  const [unitPrice, setUnitPrice] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);

    const quantity = Number(orderQty);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      setError("Order a whole number of pieces, at least one.");
      return;
    }

    if (!componentId && !choice) {
      setError("Say which catalogue part this is, or add it to the catalogue.");
      return;
    }

    startTransition(async () => {
      const result = await convertRequestToOrderAction({
        requestId,
        componentId: componentId ?? choice?.componentId ?? null,
        vendorName: vendorName.trim() || null,
        channel,
        qty: quantity,
        unitPrice: unitPrice.trim() === "" ? null : Number(unitPrice),
        expectedDate: expectedDate || null,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      toast.show({ tone: "success", message: "Ordered." });
      router.push(`/orders/${result.data.orderId}`);
      router.refresh();
    });
  }

  return (
    <Panel title="Turn it into an order">
      <div className="space-y-4">
        {componentId ? null : (
          <Field
            label="Which part"
            hint="Asked for as free text, so nothing has checked the catalogue for it — search first, and add it only if the lab has never bought one."
          >
            {/* This panel is only rendered for somebody who
                `canManageInventory`, the gate the create action re-checks. */}
            <ComponentPicker
              value={choice}
              onChange={setChoice}
              canCreate
              suggestedName={label}
            />
          </Field>
        )}

        <Field label="Vendor" hint="Left blank if it is not decided yet.">
          <input
            className={inputClass}
            value={vendorName}
            onChange={(e) => setVendorName(e.target.value)}
            placeholder="Robu.in"
            list="request-vendors"
            autoComplete="off"
          />
          <datalist id="request-vendors">
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.name} />
            ))}
          </datalist>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="How many">
            <input
              className={`${inputClass} tabular-nums`}
              inputMode="numeric"
              value={orderQty}
              onChange={(e) => setOrderQty(e.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>

          <Field label="Unit price" hint="₹, optional">
            <input
              className={`${inputClass} tabular-nums`}
              inputMode="decimal"
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value)}
              placeholder="99.00"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Channel">
            <select
              className={selectClass}
              value={channel}
              onChange={(e) =>
                setChannel(e.target.value as "online" | "offline")
              }
            >
              <option value="online">Online</option>
              <option value="offline">Bought in person</option>
            </select>
          </Field>

          <Field label="Expected">
            <input
              type="date"
              className={inputClass}
              value={expectedDate}
              onChange={(e) => setExpectedDate(e.target.value)}
            />
          </Field>
        </div>

        <ErrorText>{error}</ErrorText>

        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className={primaryButtonClass}
        >
          <ReceiptIcon size={16} />
          {pending ? "Ordering…" : "Create the order"}
        </button>

        <p className="text-xs text-muted">
          Ordering does not add stock. The parts appear in the cupboard when
          somebody puts the line away.
        </p>
      </div>
    </Panel>
  );
}
