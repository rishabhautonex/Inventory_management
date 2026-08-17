"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  assignProjectLeadAction,
  createProjectAction,
  removeProjectLeadAction,
  setProjectStatusAction,
} from "@/app/actions/admin";
import { useToast } from "@/components/toast";
import { PlusIcon, XIcon } from "@/components/icons";
import {
  Badge,
  Card,
  EmptyState,
  ErrorText,
  Field,
  ghostButtonClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  selectClass,
} from "@/components/ui";
import type { ProjectRow } from "./page";

export function ProjectManager({
  projects,
  people,
  canAssignLeads,
}: {
  projects: ProjectRow[];
  people: Array<{ id: string; name: string; email: string }>;
  canAssignLeads: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  function create() {
    setError(null);
    startTransition(async () => {
      const result = await createProjectAction({ name, code });
      if (result.ok) {
        setName("");
        setCode("");
        setAdding(false);
        toast.show({ tone: "success", message: "Project created." });
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) router.refresh();
      else toast.show({ tone: "error", message: result.error ?? "Failed." });
    });
  }

  return (
    <div className="space-y-4">
      {adding ? (
        <div className="space-y-5 rounded-xl border border-border bg-surface p-4 sm:p-6">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label="Name" required>
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Falcon"
                autoFocus
              />
            </Field>
            <Field
              label="Code"
              required
              hint="Short, unique. Used on labels and orders."
            >
              <input
                className={inputClass}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="FAL"
              />
            </Field>
          </div>

          <ErrorText>{error}</ErrorText>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className={primaryButtonClass}
              onClick={create}
              disabled={pending || !name.trim() || !code.trim()}
            >
              {pending ? "Saving…" : "Create project"}
            </button>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={primaryButtonClass}
          onClick={() => setAdding(true)}
        >
          <PlusIcon size={16} />
          New project
        </button>
      )}

      {projects.length === 0 ? (
        <Card>
          <EmptyState
            title="No projects yet"
            description="A project owns a cupboard, and its heads are who can approve requests for it."
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {projects.map((project) => (
            <Card key={project.id} className="p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-base font-semibold">{project.name}</p>
                    <span className="rounded-md bg-surface-muted px-2 py-0.5 font-mono text-xs text-muted">
                      {project.code}
                    </span>
                    {project.status === "closed" ? (
                      <Badge tone="neutral">closed</Badge>
                    ) : (
                      <Badge tone="positive">active</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {project.cupboards} cupboard
                    {project.cupboards === 1 ? "" : "s"}
                  </p>
                </div>

                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(() =>
                      setProjectStatusAction(
                        project.id,
                        project.status === "active" ? "closed" : "active",
                      ),
                    )
                  }
                  className={ghostButtonClass}
                >
                  {project.status === "active" ? "Close" : "Reopen"}
                </button>
              </div>

              <div className="mt-4 border-t border-border pt-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                  Heads
                </p>

                {project.leads.length === 0 ? (
                  <p className="text-sm text-muted">
                    Nobody yet — requests for this project cannot be approved.
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {project.leads.map((lead) => (
                      <li
                        key={lead.id}
                        className="flex items-center gap-1 rounded-full border border-border bg-surface-muted py-1 pl-3 pr-1 text-sm"
                      >
                        {lead.name}
                        {canAssignLeads ? (
                          <button
                            type="button"
                            aria-label={`Remove ${lead.name}`}
                            disabled={pending}
                            onClick={() =>
                              run(() =>
                                removeProjectLeadAction(project.id, lead.id),
                              )
                            }
                            className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                          >
                            <XIcon size={14} />
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}

                {canAssignLeads ? (
                  <select
                    className={`${selectClass} mt-3`}
                    value=""
                    disabled={pending}
                    onChange={(e) => {
                      if (!e.target.value) return;
                      run(() =>
                        assignProjectLeadAction(project.id, e.target.value),
                      );
                    }}
                  >
                    <option value="">Add a head…</option>
                    {people
                      .filter(
                        (p) => !project.leads.some((lead) => lead.id === p.id),
                      )
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — {p.email}
                        </option>
                      ))}
                  </select>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
