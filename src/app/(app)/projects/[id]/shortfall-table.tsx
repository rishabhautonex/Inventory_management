"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { orderShortfallAction } from "@/app/actions/bom";
import { raiseShortfallRequestsAction } from "@/app/actions/requests";
import { useToast } from "@/components/toast";
import type { ShortfallLine } from "@/db/queries/bom";
import {
  Badge,
  ErrorText,
  primaryButtonClass,
  secondaryButtonClass,
  tdClass,
  thClass,
  theadClass,
  trClass,
} from "@/components/ui";

/**
 * The spec's shortfall table: needed, in this project's cupboard, to buy —
 * with the one-click path to raise requests or an order for the gaps.
 *
 * "On order" is shown beside them without being subtracted from "to buy". A box
 * that has not arrived is not stock, so netting it off would show zero short for
 * a part nobody actually has; what it does is stop somebody buying the same
 * thing twice, which is the mistake this screen makes easy.
 *
 * Only short lines are selectable. The server re-derives every quantity from
 * the ledger anyway, so a tab left open while a delivery was put away raises
 * nothing rather than ordering parts that are already on the shelf.
 */
export function ShortfallTable({
  bomId,
  lines,
  canOrder,
}: {
  bomId: string;
  lines: ShortfallLine[];
  canOrder: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const short = lines.filter((line) => line.toBuy > 0);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(short.map((line) => line.componentId)),
  );
  const [error, setError] = useState<string | null>(null);

  function toggle(componentId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(componentId)) next.delete(componentId);
      else next.add(componentId);
      return next;
    });
  }

  function raiseRequests() {
    setError(null);
    startTransition(async () => {
      const result = await raiseShortfallRequestsAction({
        bomId,
        componentIds: [...selected],
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.show({
        tone: "success",
        message: `Asked for ${result.data.raised} part${result.data.raised === 1 ? "" : "s"}.`,
      });
      router.refresh();
    });
  }

  function orderGaps() {
    setError(null);
    startTransition(async () => {
      const result = await orderShortfallAction({
        bomId,
        componentIds: [...selected],
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.show({ tone: "success", message: "Order created." });
      router.push(`/orders/${result.data.orderId}`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="panel overflow-x-auto rounded-xl">
        <table className="w-full text-sm" style={{ minWidth: 760 }}>
          <thead className={theadClass}>
            <tr>
              <th className={`${thClass} w-10`}>
                <span className="sr-only">Include</span>
              </th>
              <th className={thClass}>Part</th>
              <th className={`${thClass} text-right`}>Needed</th>
              <th className={`${thClass} text-right`}>In cupboard</th>
              <th className={`${thClass} text-right`}>On order</th>
              <th className={`${thClass} text-right`}>To buy</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const isShort = line.toBuy > 0;

              return (
                <tr key={line.bomLineId} className={trClass}>
                  <td className={tdClass}>
                    {isShort ? (
                      <input
                        type="checkbox"
                        checked={selected.has(line.componentId)}
                        onChange={() => toggle(line.componentId)}
                        aria-label={`Include ${line.componentName}`}
                        className="h-5 w-5 accent-[var(--accent)]"
                      />
                    ) : null}
                  </td>

                  <td className={tdClass}>
                    <Link
                      href={`/parts/${line.componentId}`}
                      className="font-medium text-accent-text hover:underline"
                    >
                      {line.componentName}
                    </Link>
                    {line.componentMpn ? (
                      <p className="mt-0.5 font-mono text-xs text-muted">
                        {line.componentMpn}
                      </p>
                    ) : null}
                  </td>

                  <td className={`${tdClass} text-right tabular-nums`}>
                    {line.needed}
                  </td>

                  <td className={`${tdClass} text-right tabular-nums`}>
                    {line.inProject}
                  </td>

                  <td className={`${tdClass} text-right tabular-nums text-muted`}>
                    {line.onOrder > 0 ? line.onOrder : "—"}
                  </td>

                  <td className={`${tdClass} text-right`}>
                    {isShort ? (
                      <span className="tabular-nums font-semibold text-warning">
                        {line.toBuy}
                      </span>
                    ) : (
                      <Badge tone="positive">Covered</Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {short.length > 0 ? (
        <div className="space-y-3">
          <ErrorText>{error}</ErrorText>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={raiseRequests}
              disabled={pending || selected.size === 0}
              className={canOrder ? secondaryButtonClass : primaryButtonClass}
            >
              {pending ? "Working…" : `Raise requests (${selected.size})`}
            </button>

            {canOrder ? (
              <button
                type="button"
                onClick={orderGaps}
                disabled={pending || selected.size === 0}
                className={primaryButtonClass}
              >
                {pending ? "Working…" : `Order the gaps (${selected.size})`}
              </button>
            ) : null}

            <p className="text-xs text-muted">
              Neither changes stock. Parts appear in the cupboard when a
              delivery is put away.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
