"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  approveRequestAction,
  rejectRequestAction,
} from "@/app/actions/requests";
import { useToast } from "@/components/toast";
import { CheckIcon, XIcon } from "@/components/icons";
import {
  ErrorText,
  Field,
  Panel,
  dangerButtonClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  textareaClass,
} from "@/components/ui";

/**
 * Approve or turn down, for a head of this project.
 *
 * Turning down opens a note field first and the button stays disabled until it
 * has something in it. The spec requires the note and the database refuses a
 * rejection without one, so the form asks rather than letting somebody hit a
 * wall after committing to the decision.
 */
export function DecisionPanel({
  requestId,
  askedQty,
  label,
}: {
  requestId: string;
  /** What was asked for. The quantity field starts here. */
  askedQty: number;
  label: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [qty, setQty] = useState(String(askedQty));
  const [error, setError] = useState<string | null>(null);

  const amount = Number(qty);
  const valid = Number.isInteger(amount) && amount > 0;
  const amended = valid && amount !== askedQty;

  function approve() {
    setError(null);

    if (!valid) {
      setError("Approve a whole number of pieces, at least one.");
      return;
    }

    startTransition(async () => {
      const result = await approveRequestAction(requestId, {
        qty: amount,
        // A cut-down approval without a word about why is the same dead end a
        // note-less rejection would be, so the note rides along when there is one.
        note: amended ? note.trim() || null : null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.show({
        tone: "success",
        message: amended
          ? `Approved for ${amount} of the ${askedQty} asked for.`
          : "Approved. The admins can order it.",
      });
      setNote("");
      router.refresh();
    });
  }

  function reject() {
    setError(null);
    startTransition(async () => {
      const result = await rejectRequestAction({ requestId, note: note.trim() });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.show({ tone: "success", message: "Turned down." });
      setRejecting(false);
      setNote("");
      router.refresh();
    });
  }

  return (
    <Panel title="Your decision">
      {rejecting ? (
        <div className="space-y-4">
          <Field
            label="Why not"
            required
            hint="The requester sees this. It is the difference between a decision and a dead end."
          >
            <textarea
              className={textareaClass}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="We have six of these on the Kestrel shelf — use those first."
              autoFocus
            />
          </Field>

          <ErrorText>{error}</ErrorText>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={reject}
              disabled={pending || note.trim() === ""}
              className={dangerButtonClass}
            >
              {pending ? "Sending…" : "Turn it down"}
            </button>
            <button
              type="button"
              onClick={() => {
                setRejecting(false);
                setError(null);
              }}
              disabled={pending}
              className={secondaryButtonClass}
            >
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Approving does not buy anything. It moves this into the admins&apos;
            queue, and they place the order.
          </p>

          <Field
            label="Approve how many"
            hint={`${askedQty} asked for. Change it to approve fewer — the ask stays on the record either way.`}
          >
            <input
              type="number"
              inputMode="numeric"
              min={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className={`${inputClass} max-w-32 tabular-nums`}
              aria-label={`Quantity of ${label} to approve`}
            />
          </Field>

          {amended ? (
            <Field
              label="Why fewer"
              hint="Optional, and worth the ten seconds — the requester sees it, and it saves them asking."
            >
              <textarea
                className={textareaClass}
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Four is enough for the first build; ask again if the trial goes ahead."
              />
            </Field>
          ) : null}

          <ErrorText>{error}</ErrorText>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={approve}
              disabled={pending || !valid}
              className={primaryButtonClass}
            >
              <CheckIcon size={16} />
              {pending
                ? "Approving…"
                : amended
                  ? `Approve ${amount}`
                  : "Approve"}
            </button>
            <button
              type="button"
              onClick={() => setRejecting(true)}
              disabled={pending}
              className={secondaryButtonClass}
            >
              <XIcon size={16} />
              Turn down
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
