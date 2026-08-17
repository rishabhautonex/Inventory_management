import type { OrderStatus } from "@/db/queries/orders";
import type { Tone } from "@/components/ui";

/**
 * A short, readable handle for an order.
 *
 * Orders are keyed by uuid and the schema has no separate order number, so this
 * is the first block of the real id rather than a new identifier — which means
 * it is stable, and pasteable straight into a lookup. It is a display
 * convenience, never used to find a row.
 */
export function orderRef(orderId: string): string {
  return `#${orderId.slice(0, 8).toUpperCase()}`;
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  ordered: "Ordered",
  shipped: "Shipped",
  delivered: "Delivered",
  shelved: "Put away",
  cancelled: "Cancelled",
};

/** Delivered reads as warning on purpose: it is the state needing someone. */
export const ORDER_STATUS_TONE: Record<OrderStatus, Tone> = {
  ordered: "neutral",
  shipped: "accent",
  delivered: "warning",
  shelved: "positive",
  cancelled: "neutral",
};
