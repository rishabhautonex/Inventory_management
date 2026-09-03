"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { createRequestAction } from "@/app/actions/requests";
import { ComponentPicker } from "@/components/component-picker";
import { useToast } from "@/components/toast";
import {
  Card,
  ErrorText,
  Field,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  selectClass,
  textareaClass,
} from "@/components/ui";

type Choice = { componentId: string; name: string; mpn: string | null };

/**
 * The two ways to ask for something, as the spec describes them: point at a
 * catalogue part, or type what you need when it is not catalogued yet.
 *
 * They are mutually exclusive rather than both-optional, because a request that
 * carries a part *and* free text leaves the admin guessing which one to buy —
 * the database enforces the same thing with a check constraint.
 */
export function RequestForm({
  projects,
  defaultProjectId,
  defaultComponent,
  canCreateParts,
}: {
  projects: Array<{ id: string; name: string; code: string }>;
  defaultProjectId?: string;
  defaultComponent: Choice | null;
  /**
   * Whether this person may catalogue the part themselves. Raising a request is
   * open to everyone, so most people asking here cannot — and for them
   * "something new" is the whole point of the free-text tab.
   */
  canCreateParts: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [mode, setMode] = useState<"catalogue" | "new">("catalogue");
  const [choice, setChoice] = useState<Choice | null>(defaultComponent);
  const [freeText, setFreeText] = useState("");
  const [projectId, setProjectId] = useState(
    defaultProjectId ?? projects[0]?.id ?? "",
  );
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function step(by: number) {
    const next = Math.max(1, (Number(qty) || 0) + by);
    setQty(String(next));
  }

  function submit() {
    setError(null);

    const quantity = Number(qty);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      setError("Ask for a whole number of pieces, at least one.");
      return;
    }
    if (mode === "catalogue" && !choice) {
      setError("Search for the part, or switch to describing something new.");
      return;
    }
    if (mode === "new" && freeText.trim() === "") {
      setError("Describe what you need.");
      return;
    }

    startTransition(async () => {
      const result = await createRequestAction({
        projectId,
        componentId: mode === "catalogue" ? choice!.componentId : null,
        freeText: mode === "new" ? freeText.trim() : null,
        qty: quantity,
        reason: reason.trim() || null,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      toast.show({
        tone: "success",
        message: "Asked for. The project head will see it.",
      });
      router.push(`/requests/${result.data.requestId}`);
      router.refresh();
    });
  }

  return (
    <Card className="p-4 sm:p-6">
      <div className="space-y-5">
        <div>
          <span className="mb-1.5 block text-sm font-medium">
            What do you need
            <span className="ml-0.5 text-accent-text" aria-hidden>
              *
            </span>
          </span>

          <div className="mb-3 flex flex-wrap gap-2">
            <ModeTab
              active={mode === "catalogue"}
              onClick={() => setMode("catalogue")}
              label="From the catalogue"
            />
            <ModeTab
              active={mode === "new"}
              onClick={() => setMode("new")}
              label="Something new"
            />
          </div>

          {mode === "catalogue" ? (
            <ComponentPicker
              value={choice}
              onChange={setChoice}
              canCreate={canCreateParts}
            />
          ) : (
            <>
              <input
                className={inputClass}
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="e.g. Waveshare 7.5in e-paper display, 800×480"
                aria-label="Describe the part you need"
              />
              <span className="mt-1.5 block text-xs text-muted">
                An admin catalogues it properly before ordering, so be as
                specific as the invoice would be.
              </span>
            </>
          )}
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="Project" required hint="Decides who approves it, and which cupboard it lands in.">
            <select
              className={selectClass}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} ({project.code})
                </option>
              ))}
            </select>
          </Field>

          <Field label="How many" required>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => step(-1)}
                aria-label="One fewer"
                className={`${secondaryButtonClass} w-12 px-0 text-lg`}
              >
                −
              </button>
              <input
                className={`${inputClass} text-center tabular-nums`}
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ""))}
                aria-label="How many pieces"
              />
              <button
                type="button"
                onClick={() => step(1)}
                aria-label="One more"
                className={`${secondaryButtonClass} w-12 px-0 text-lg`}
              >
                +
              </button>
            </div>
          </Field>
        </div>

        <Field
          label="Why"
          hint="Optional, but it is what the head reads before deciding."
        >
          <textarea
            className={textareaClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Needed for the gateway prototype — the cupboard is empty."
          />
        </Field>

        <ErrorText>{error}</ErrorText>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className={primaryButtonClass}
          >
            {pending ? "Sending…" : "Ask for it"}
          </button>
        </div>
      </div>
    </Card>
  );
}

function ModeTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex min-h-11 items-center rounded-lg px-3.5 text-sm font-medium transition-colors ${
        active
          ? "border border-accent/40 bg-accent-soft text-accent-text"
          : "border border-border text-muted hover:bg-surface-hover hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
