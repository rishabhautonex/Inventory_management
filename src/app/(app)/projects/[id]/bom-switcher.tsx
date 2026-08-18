"use client";

import { useRouter } from "next/navigation";

import { selectClass } from "@/components/ui";

/**
 * Picks which uploaded BOM the shortfall table measures against.
 *
 * Navigates rather than holding state, so the choice lands in the URL and the
 * page stays a server component — the shortfall numbers come from the ledger
 * and are not something the browser should be recomputing.
 */
export function BomSwitcher({
  projectId,
  boms,
  activeId,
}: {
  projectId: string;
  boms: Array<{ id: string; label: string }>;
  activeId: string;
}) {
  const router = useRouter();

  return (
    <select
      className={`${selectClass} max-w-64`}
      value={activeId}
      aria-label="Which BOM to compare against"
      onChange={(event) =>
        router.push(`/projects/${projectId}?bom=${event.target.value}`)
      }
    >
      {boms.map((bom) => (
        <option key={bom.id} value={bom.id}>
          {bom.label}
        </option>
      ))}
    </select>
  );
}
