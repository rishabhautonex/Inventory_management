import type { RequestStatus } from "@/db/queries/requests";
import type { Tone } from "@/components/ui";

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "Waiting",
  approved: "Approved",
  rejected: "Turned down",
  ordered: "Ordered",
};

/**
 * `pending` reads as warning on purpose, matching how `delivered` is toned on
 * the orders list: it is the state that is waiting on a person, and the colour
 * is what makes a queue look like a queue.
 */
export const REQUEST_STATUS_TONE: Record<RequestStatus, Tone> = {
  pending: "warning",
  approved: "accent",
  rejected: "neutral",
  ordered: "positive",
};

export const REQUEST_STATUSES: RequestStatus[] = [
  "pending",
  "approved",
  "rejected",
  "ordered",
];
