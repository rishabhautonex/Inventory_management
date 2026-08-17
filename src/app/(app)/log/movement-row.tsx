"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { undoMovementAction } from "@/app/actions/stock";
import { useToast } from "@/components/toast";
import { UndoIcon } from "@/components/icons";
import { Badge, ghostButtonClass, type Tone } from "@/components/ui";
import type { LogEntry } from "@/db/queries/movements";
import { formatDateTime, formatDelta, formatReason } from "@/lib/format";

/** Badge colour per reason, matching the dashboard's activity feed. */
const REASON_TONE: Record<string, Tone> = {
  receipt: "positive",
  return: "positive",
  issue: "accent",
  adjustment: "warning",
  reversal: "neutral",
};

/**
 * One row of the log.
 *
 * A movement that has already been undone is struck through and keeps its Undo
 * button hidden, rather than disappearing — the spec wants the history to stay
 * visible, including the mistakes.
 *
 * The row is laid out twice: as a stacked card on a phone and as table columns
 * from `md` up. Only the presentation is duplicated — both share the same undo
 * handler and the same derived state below.
 */
export function MovementRow({
  entry,
  canUndo,
}: {
  entry: LogEntry;
  canUndo: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  const reversed = entry.isReversed || done;
  const isUndo = entry.reversesMovementId !== null;
  const showUndo = canUndo && !reversed && !isUndo;

  function undo() {
    startTransition(async () => {
      const result = await undoMovementAction(entry.id);
      if (result.ok) {
        setDone(true);
        toast.show({ tone: "success", message: "Movement undone." });
        router.refresh();
      } else {
        toast.show({ tone: "error", message: result.error });
      }
    });
  }

  const deltaClass = reversed
    ? "text-muted line-through"
    : entry.qtyDelta > 0
      ? "text-positive"
      : "text-foreground";

  const name = (
    <Link
      href={`/parts/${entry.componentId}`}
      className={`font-medium hover:underline ${
        reversed ? "text-muted line-through" : "text-accent-text"
      }`}
    >
      {entry.componentName}
    </Link>
  );

  const reasonBadge = (
    <Badge tone={REASON_TONE[entry.reason] ?? "neutral"}>
      {formatReason(entry.reason)}
    </Badge>
  );

  const undoButton = showUndo ? (
    <button
      type="button"
      onClick={undo}
      disabled={pending}
      className={ghostButtonClass}
    >
      <UndoIcon size={16} />
      {pending ? "…" : "Undo"}
    </button>
  ) : null;

  const flags = (
    <>
      {reversed ? <Badge tone="neutral">undone</Badge> : null}
      {isUndo ? <Badge tone="neutral">is an undo</Badge> : null}
    </>
  );

  return (
    <li className="px-4 py-3.5 transition-colors hover:bg-surface-muted/40">
      {/* Phone: stacked. */}
      <div className="md:hidden">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 truncate text-base">{name}</p>
          <span
            className={`shrink-0 text-lg font-semibold tabular-nums ${deltaClass}`}
          >
            {formatDelta(entry.qtyDelta)}
          </span>
        </div>

        <p className="mt-0.5 truncate text-sm text-muted">
          {entry.locationPath}
        </p>

        <p className="mt-0.5 truncate text-xs text-muted">
          {entry.userName ?? "Unknown"}
          <span className="mx-1.5 opacity-50">·</span>
          {formatDateTime(entry.createdAt)}
          {entry.projectName ? (
            <>
              <span className="mx-1.5 opacity-50">·</span>
              {entry.projectName}
            </>
          ) : null}
        </p>

        {entry.note ? (
          <p className="mt-1.5 text-sm italic text-muted">“{entry.note}”</p>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {reasonBadge}
          {flags}
          {undoButton ? <div className="ml-auto">{undoButton}</div> : null}
        </div>
      </div>

      {/* Tablet and up: aligned columns under the header row on the log page. */}
      <div className="hidden items-center gap-4 md:grid md:grid-cols-[minmax(0,1.6fr)_7rem_4.5rem_minmax(0,1.6fr)_8.5rem_6rem]">
        <div className="min-w-0">
          <p className="truncate text-sm">{name}</p>
          {entry.note ? (
            <p className="truncate text-xs italic text-muted">
              “{entry.note}”
            </p>
          ) : null}
          {reversed || isUndo ? (
            <div className="mt-1 flex flex-wrap gap-1.5">{flags}</div>
          ) : null}
        </div>

        <div>{reasonBadge}</div>

        <div
          className={`text-right text-sm font-semibold tabular-nums ${deltaClass}`}
        >
          {formatDelta(entry.qtyDelta)}
        </div>

        <div className="min-w-0">
          <p className="truncate text-sm text-muted">{entry.locationPath}</p>
          {entry.projectName ? (
            <p className="truncate text-xs text-muted opacity-75">
              {entry.projectName}
            </p>
          ) : null}
        </div>

        <div className="min-w-0">
          <p className="truncate text-xs text-muted">
            {formatDateTime(entry.createdAt)}
          </p>
          <p className="truncate text-xs text-muted opacity-75">
            {entry.userName ?? "Unknown"}
          </p>
        </div>

        <div className="flex justify-end">{undoButton}</div>
      </div>
    </li>
  );
}
