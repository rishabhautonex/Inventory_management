"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { markAllNotificationsReadAction } from "@/app/actions/notifications";
import { CheckIcon } from "@/components/icons";
import { secondaryButtonClass } from "@/components/ui";

export function MarkAllReadButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await markAllNotificationsReadAction();
          router.refresh();
        })
      }
      className={secondaryButtonClass}
    >
      <CheckIcon size={16} />
      {pending ? "Marking…" : "Mark all read"}
    </button>
  );
}
