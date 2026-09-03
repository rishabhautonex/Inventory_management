"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  assignProjectLeadAction,
  createProjectAction,
  deleteProjectAction,
  removeProjectLeadAction,
  setProjectStatusAction,
  updateProjectAction,
} from "@/app/actions/admin";
import { useToast } from "@/components/toast";
import { PencilIcon, PlusIcon, TrashIcon, XIcon } from "@/components/icons";
import {
  Badge,
  Card,
  dangerButtonClass,
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

/**
 * What deleting this project would do, in the order it will do it, and only
 * the clauses with a number behind them.
 *
 * Deliberately not a single sentence: destroyed and detached are different
 * outcomes, and a reviewer about to type a project code needs to see which is
 * which. An empty list is itself the answer — nothing is filed under it.
 */
function consequencesOf(project: ProjectRow): string[] {
  const plural = (n: number, one: string, many = `${one}s`) =>
    `${n} ${n === 1 ? one : many}`;

  const lines: string[] = [];
  if (project.requests > 0) {
    lines.push(`${plural(project.requests, "part request")} deleted`);
  }
  if (project.boms > 0) {
    lines.push(`${plural(project.boms, "BOM")} deleted, with their lines`);
  }
  if (project.orders > 0) {
    lines.push(
      `${plural(project.orders, "order")} kept, no longer filed under ${project.code}`,
    );
  }
  if (project.cupboards > 0) {
    lines.push(
      `${plural(project.cupboards, "cupboard")} kept with everything in ${project.cupboards === 1 ? "it" : "them"}, no longer filed under ${project.code}`,
    );
  }
  return lines;
}

export function ProjectManager({
  projects,
  people,
  canAssignLeads,
  canDelete,
}: {
  projects: ProjectRow[];
  people: Array<{ id: string; name: string; email: string }>;
  canAssignLeads: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Which project is showing its delete confirmation, and the code typed into
  // it. Held per-card rather than in a modal so the counts stay next to the
  // project they describe.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function beginDelete(projectId: string) {
    setDeletingId(projectId);
    setConfirmCode("");
    setDeleteError(null);
    setEditingId(null);
  }

  // Editing a project's name and code. Separate state from the create form
  // above so opening one does not clear a half-typed other.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCode, setEditCode] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  function beginEdit(project: ProjectRow) {
    setEditingId(project.id);
    setEditName(project.name);
    setEditCode(project.code);
    setEditError(null);
    setDeletingId(null);
  }

  function saveEdit(projectId: string) {
    setEditError(null);
    startTransition(async () => {
      const result = await updateProjectAction(projectId, {
        name: editName,
        code: editCode,
      });

      if (!result.ok) {
        setEditError(result.error);
        return;
      }

      setEditingId(null);
      toast.show({ tone: "success", message: "Project saved." });
      router.refresh();
    });
  }

  function confirmDelete(project: ProjectRow) {
    setDeleteError(null);
    startTransition(async () => {
      const result = await deleteProjectAction({
        projectId: project.id,
        confirmCode,
      });

      if (!result.ok) {
        setDeleteError(result.error);
        return;
      }

      const detail = consequencesOf(project);
      setDeletingId(null);
      setConfirmCode("");
      toast.show({
        tone: "success",
        message: detail.length
          ? `${project.name} deleted — ${detail.join("; ")}.`
          : `${project.name} deleted.`,
      });
      router.refresh();
    });
  }

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
        <div className="space-y-5 panel rounded-xl p-4 sm:p-6">
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
          {projects.map((project) => {
            const deleting = deletingId === project.id;
            const editing = editingId === project.id;
            const consequences = consequencesOf(project);

            return (
              <Card key={project.id} className="p-4 sm:p-5">
                {editing ? (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field label="Name" required>
                        <input
                          className={inputClass}
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          autoFocus
                        />
                      </Field>
                      <Field
                        label="Code"
                        required
                        hint="Everything filed under this project follows it, so a new code moves nothing."
                      >
                        <input
                          className={inputClass}
                          value={editCode}
                          onChange={(e) =>
                            setEditCode(e.target.value.toUpperCase())
                          }
                        />
                      </Field>
                    </div>

                    <ErrorText>{editError}</ErrorText>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={primaryButtonClass}
                        disabled={
                          pending || !editName.trim() || !editCode.trim()
                        }
                        onClick={() => saveEdit(project.id)}
                      >
                        {pending ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        className={secondaryButtonClass}
                        disabled={pending}
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
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

                    {deleting ? null : (
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Edit ${project.name}`}
                          title="Edit name and code"
                          disabled={pending}
                          onClick={() => beginEdit(project)}
                          className={`${ghostButtonClass} w-11 px-0`}
                        >
                          <PencilIcon size={16} />
                        </button>

                        <button
                          type="button"
                          disabled={pending}
                          onClick={() =>
                            run(() =>
                              setProjectStatusAction(
                                project.id,
                                project.status === "active"
                                  ? "closed"
                                  : "active",
                              ),
                            )
                          }
                          className={ghostButtonClass}
                        >
                          {project.status === "active" ? "Close" : "Reopen"}
                        </button>

                        {canDelete ? (
                          <button
                            type="button"
                            aria-label={`Delete ${project.name}`}
                            title="Delete project"
                            disabled={pending}
                            onClick={() => beginDelete(project.id)}
                            className={`${ghostButtonClass} w-11 px-0 hover:text-danger`}
                          >
                            <TrashIcon size={16} />
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                )}

                {deleting ? (
                  <div className="mt-4 space-y-3 rounded-lg border border-danger/30 bg-danger/10 p-3">
                    <div>
                      <p className="text-sm font-semibold text-danger">
                        Delete {project.name}?
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        This cannot be undone. Closing it instead keeps the record
                        and takes the project out of the way.
                      </p>
                    </div>

                    {consequences.length === 0 ? (
                      <p className="text-xs text-muted">
                        Nothing is filed under {project.code} yet.
                      </p>
                    ) : (
                      <ul className="space-y-1 text-xs text-muted">
                        {consequences.map((line) => (
                          <li key={line} className="flex gap-2">
                            <span aria-hidden className="text-danger">
                              &bull;
                            </span>
                            <span>{line}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    <Field label={`Type ${project.code} to confirm`}>
                      <input
                        className={inputClass}
                        value={confirmCode}
                        onChange={(e) => setConfirmCode(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus
                      />
                    </Field>

                    <ErrorText>{deleteError}</ErrorText>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={dangerButtonClass}
                        disabled={
                          pending ||
                          confirmCode.trim().toLowerCase() !==
                            project.code.toLowerCase()
                        }
                        onClick={() => confirmDelete(project)}
                      >
                        {pending ? "Deleting…" : "Delete permanently"}
                      </button>
                      <button
                        type="button"
                        className={secondaryButtonClass}
                        disabled={pending}
                        onClick={() => setDeletingId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
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
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
