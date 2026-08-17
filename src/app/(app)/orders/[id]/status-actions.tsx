"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { setOrderStatusAction } from "@/app/actions/orders";
import { useToast } from "@/components/toast";
import {
  dangerButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/ui";
import type { OrderStatus } from "@/db/queries/orders";

/**
 * The status buttons.
 *
 * There is deliberately no "mark as put away" here. That state is reached by
 * actually putting the lines away, which is what writes the receipts — a button
 * for it would let the record claim stock that never reached a shelf.
 */
export function StatusActions({
  orderId,
  status,
}: {
  orderId: string;
  status: OrderStatus;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  function move(next: OrderStatus, label: string) {
    startTransition(async () => {
      const result = await setOrderStatusAction(orderId, next);
      if (result.ok) {
        toast.show({ tone: "success", message: label });
        router.refresh();
      } else {
        toast.show({ tone: "error", message: result.error });
      }
    });
  }

  if (status === "shelved" || status === "cancelled") return null;

  return (
    <div className="flex flex-wrap gap-3">
      {status === "ordered" ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => move("shipped", "Marked as shipped.")}
          className={secondaryButtonClass}
        >
          Mark shipped
        </button>
      ) : null}

      {status === "ordered" || status === "shipped" ? (
        <>
          <button
            type="button"
            disabled={pending}
            onClick={() => move("delivered", "Marked as delivered.")}
            className={primaryButtonClass}
          >
            Mark delivered
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => move("cancelled", "Order cancelled.")}
            className={dangerButtonClass}
          >
            Cancel order
          </button>
        </>
      ) : null}
    </div>
  );
}
