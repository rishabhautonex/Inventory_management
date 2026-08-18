"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { setThresholdAction } from "@/app/actions/admin";
import { useToast } from "@/components/toast";
import { Badge, inputClass, tdClass, trClass } from "@/components/ui";
import type { CoverageLine } from "@/db/queries/thresholds";

/**
 * One shelf's minimum, editable in place.
 *
 * Setting minimums used to mean opening a part, finding the right location row
 * and saving one number at a time — which is why so many shelves have none, and
 * a shelf with no minimum can never raise a low-stock alert.
 *
 * Saving goes through the same `setThresholdAction` the part page uses, so the
 * alert check that runs when a minimum lands above what is on the shelf runs here
 * too. There is no bulk write behind this screen: one row, one statement, one
 * alert check, exactly as if it had been typed on the part page.
 */
export function ThresholdRow({ line }: { line: CoverageLine }) {
  const router = useRouter();
  const toast = useToast();
  const [saving, startSaving] = useTransition();

  const [value, setValue] = useState(
    line.minQty === null ? "" : String(line.minQty),
  );

  const trimmed = value.trim();
  const parsed = trimmed === "" ? null : Number(trimmed);
  const valid =
    parsed === null || (Number.isInteger(parsed) && parsed >= 0);
  const changed = trimmed !== (line.minQty === null ? "" : String(line.minQty));

  const breaching = line.minQty !== null && line.onHand <= line.minQty;

  function save() {
    if (!valid) {
      toast.show({
        tone: "error",
        message: "A minimum is a whole number, zero or more.",
      });
      return;
    }

    startSaving(async () => {
      const result = await setThresholdAction({
        componentId: line.componentId,
        locationId: line.locationId,
        minQty: parsed,
      });

      if (!result.ok) {
        toast.show({ tone: "error", message: result.error });
        return;
      }

      toast.show({
        tone: "success",
        message:
          parsed === null
            ? `${line.componentName} at ${line.locationPath} is no longer watched.`
            : `${line.componentName} at ${line.locationPath}: minimum ${parsed}.`,
      });
      router.refresh();
    });
  }

  return (
    <tr className={trClass}>
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

      <td className={`${tdClass} text-muted`}>
        {line.locationPath}
        {line.projectName ? (
          <p className="mt-0.5 text-xs opacity-75">{line.projectName}</p>
        ) : null}
      </td>

      <td className={`${tdClass} text-right tabular-nums`}>
        <span
          className={
            line.onHand <= 0
              ? "font-semibold text-danger"
              : breaching
                ? "font-semibold text-warning"
                : undefined
          }
        >
          {line.onHand}
        </span>
      </td>

      <td className={tdClass}>
        <div className="flex items-center justify-end gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && changed) save();
            }}
            placeholder="none"
            aria-label={`Minimum for ${line.componentName} at ${line.locationPath}`}
            className={`${inputClass} h-11 w-20 text-right tabular-nums`}
          />
          <button
            type="button"
            onClick={save}
            disabled={saving || !changed || !valid}
            className="min-h-11 shrink-0 rounded-lg border border-border px-3 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
          >
            {saving ? "…" : "Save"}
          </button>
        </div>
      </td>

      <td className={tdClass}>
        {line.minQty === null ? (
          <Badge tone="neutral">Unwatched</Badge>
        ) : line.onHand <= 0 ? (
          <Badge tone="danger">Empty</Badge>
        ) : breaching ? (
          <Badge tone="warning">Below minimum</Badge>
        ) : (
          <Badge tone="positive">Healthy</Badge>
        )}
      </td>
    </tr>
  );
}
