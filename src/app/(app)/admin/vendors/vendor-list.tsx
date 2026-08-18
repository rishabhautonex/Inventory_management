"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  mergeVendorsAction,
  updateVendorAction,
} from "@/app/actions/vendors";
import { useToast } from "@/components/toast";
import { ExternalLinkIcon, PencilIcon } from "@/components/icons";
import {
  Badge,
  ErrorText,
  Field,
  TableWrap,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  selectClass,
  tdClass,
  thClass,
  theadClass,
  trClass,
} from "@/components/ui";
import type { VendorRow } from "@/db/queries/vendors";
import { INR, formatDate } from "@/lib/format";

/**
 * Vendors, with what has been bought from each.
 *
 * Two writes: rename, and merge a duplicate into the one to keep. Merging is
 * offered on the row being *absorbed* rather than on the survivor, because the
 * admin arrives here having spotted the typo — "this one should not exist" is the
 * thought, and the screen should take it as typed.
 *
 * There is no delete. A vendor with orders behind it is part of the record.
 */
export function VendorList({ vendors }: { vendors: VendorRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [saving, startSaving] = useTransition();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [intoId, setIntoId] = useState("");
  const [error, setError] = useState<string | null>(null);

  function beginEdit(vendor: VendorRow) {
    setMergingId(null);
    setEditingId(vendor.id);
    setName(vendor.name);
    setWebsite(vendor.website ?? "");
    setError(null);
  }

  function beginMerge(vendor: VendorRow) {
    setEditingId(null);
    setMergingId(vendor.id);
    setIntoId("");
    setError(null);
  }

  function save(vendorId: string) {
    setError(null);
    startSaving(async () => {
      const result = await updateVendorAction({ vendorId, name, website });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditingId(null);
      toast.show({ tone: "success", message: "Vendor saved." });
      router.refresh();
    });
  }

  function merge(fromId: string) {
    setError(null);

    if (intoId === "") {
      setError("Choose the vendor to keep.");
      return;
    }

    startSaving(async () => {
      const result = await mergeVendorsAction({ fromId, intoId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMergingId(null);
      toast.show({
        tone: "success",
        message:
          result.data.movedOrders === 0
            ? `Merged into ${result.data.name}. There were no orders to move.`
            : `Merged into ${result.data.name}, moving ${result.data.movedOrders} order${result.data.movedOrders === 1 ? "" : "s"}.`,
      });
      router.refresh();
    });
  }

  return (
    <TableWrap minWidth={860}>
      <thead className={theadClass}>
        <tr>
          <th className={thClass}>Vendor</th>
          <th className={`${thClass} text-right`}>Orders</th>
          <th className={`${thClass} text-right`}>Spend</th>
          <th className={thClass}>Last order</th>
          <th className={`${thClass} text-right`}>&nbsp;</th>
        </tr>
      </thead>
      <tbody>
        {vendors.map((vendor) => {
          const editing = editingId === vendor.id;
          const merging = mergingId === vendor.id;

          return (
            <tr key={vendor.id} className={trClass}>
              <td className={tdClass}>
                {editing ? (
                  <div className="space-y-3 py-1">
                    <Field label="Name">
                      <input
                        className={inputClass}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        autoFocus
                      />
                    </Field>
                    <Field label="Website">
                      <input
                        type="url"
                        inputMode="url"
                        className={inputClass}
                        value={website}
                        onChange={(e) => setWebsite(e.target.value)}
                        placeholder="https://robu.in"
                      />
                    </Field>
                    <ErrorText>{error}</ErrorText>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => save(vendor.id)}
                        disabled={saving || name.trim() === ""}
                        className={primaryButtonClass}
                      >
                        {saving ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        disabled={saving}
                        className={secondaryButtonClass}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : merging ? (
                  <div className="space-y-3 py-1">
                    <Field
                      label={`Fold ${vendor.name} into`}
                      hint="Its orders move across and this name disappears. Nothing about what was bought changes."
                    >
                      <select
                        className={selectClass}
                        value={intoId}
                        onChange={(e) => setIntoId(e.target.value)}
                      >
                        <option value="">Choose the vendor to keep…</option>
                        {vendors
                          .filter((other) => other.id !== vendor.id)
                          .map((other) => (
                            <option key={other.id} value={other.id}>
                              {other.name}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <ErrorText>{error}</ErrorText>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => merge(vendor.id)}
                        disabled={saving || intoId === ""}
                        className={primaryButtonClass}
                      >
                        {saving ? "Merging…" : "Merge"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setMergingId(null)}
                        disabled={saving}
                        className={secondaryButtonClass}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="font-medium">{vendor.name}</p>
                    {vendor.website ? (
                      <a
                        href={vendor.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 inline-flex items-center gap-1 text-xs text-accent-text hover:underline"
                      >
                        {hostOf(vendor.website)}
                        <ExternalLinkIcon size={12} />
                      </a>
                    ) : (
                      <p className="mt-0.5 text-xs text-muted">No website</p>
                    )}
                  </>
                )}
              </td>

              <td className={`${tdClass} text-right tabular-nums`}>
                {vendor.orderCount}
              </td>

              <td className={`${tdClass} text-right tabular-nums`}>
                {vendor.spend > 0 ? INR.format(vendor.spend) : "—"}
              </td>

              <td className={`${tdClass} text-muted`}>
                {vendor.lastOrderAt ? (
                  formatDate(vendor.lastOrderAt)
                ) : (
                  <Badge tone="neutral">Never used</Badge>
                )}
              </td>

              <td className={`${tdClass} text-right`}>
                {editing || merging ? null : (
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => beginEdit(vendor)}
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                    >
                      <PencilIcon size={14} />
                      Edit
                    </button>
                    {vendors.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => beginMerge(vendor)}
                        className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                      >
                        Merge
                      </button>
                    ) : null}
                  </div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </TableWrap>
  );
}

/** The host alone: a full product URL in a table cell is a wall of text. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
