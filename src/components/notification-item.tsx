"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { markNotificationReadAction } from "@/app/actions/notifications";
import {
  AlertIcon,
  BellIcon,
  ClockIcon,
  DashboardIcon,
} from "@/components/icons";
import { IconChip, type Tone } from "@/components/ui";
import type { NotificationRow } from "@/db/queries/notifications";
import { formatRelative } from "@/lib/format";

/** Icon and colour per notification type. */
function decorate(type: string): { tone: Tone; icon: React.ReactNode } {
  switch (type) {
    case "out_of_stock":
      return { tone: "danger", icon: <AlertIcon size={18} /> };
    case "low_stock":
      return { tone: "warning", icon: <AlertIcon size={18} /> };
    case "order_overdue":
      return { tone: "warning", icon: <ClockIcon size={18} /> };
    case "weekly_digest":
      return { tone: "accent", icon: <DashboardIcon size={18} /> };
    default:
      return { tone: "accent", icon: <BellIcon size={18} /> };
  }
}

/**
 * One notification, in the bell dropdown or on the full page.
 *
 * Reading and following are the same gesture: tapping marks it read and then
 * navigates, so nobody has to dismiss a notification separately from acting on
 * it. A notification with no link is still tappable, to mark it read.
 */
export function NotificationItem({
  item,
  onNavigate,
}: {
  item: NotificationRow;
  /** Lets the bell close itself before the route changes. */
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const unread = item.readAt === null;
  const { tone, icon } = decorate(item.type);

  function activate() {
    onNavigate?.();

    startTransition(async () => {
      if (unread) await markNotificationReadAction(item.id);
      if (item.linkUrl) router.push(item.linkUrl);
      else router.refresh();
    });
  }

  return (
    <li>
      <button
        type="button"
        onClick={activate}
        disabled={pending}
        className={`flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-muted/60 disabled:opacity-60 ${
          unread ? "bg-accent/[0.06]" : ""
        }`}
      >
        <IconChip tone={tone}>{icon}</IconChip>

        <div className="min-w-0 flex-1">
          <p className={`text-sm ${unread ? "font-semibold" : "font-medium"}`}>
            {item.title}
          </p>
          {item.body ? (
            // `whitespace-pre-line` because the weekly digest is several
            // sentences, one per line, and a collapsed body would run them
            // together into a paragraph nobody scans.
            <p className="mt-0.5 whitespace-pre-line text-xs text-muted">
              {item.body}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted opacity-75">
            {formatRelative(item.createdAt)}
          </p>
        </div>

        {unread ? (
          <span
            aria-label="Unread"
            className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent-text"
          />
        ) : null}
      </button>
    </li>
  );
}
