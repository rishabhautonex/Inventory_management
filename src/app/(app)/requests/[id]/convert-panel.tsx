"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { convertRequestToOrderAction } from "@/app/actions/requests";
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
 */
export function ConvertPanel({
  requestId,
  qty,
  vendors,
}: {
  requestId: string;
  qty: number;
  vendors: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

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

    startTransition(async () => {
      const result = await convertRequestToOrderAction({
        requestId,
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
