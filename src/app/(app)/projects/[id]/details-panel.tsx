"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { updateProjectDetailsAction } from "@/app/actions/projects";
import { useToast } from "@/components/toast";
import { ExternalLinkIcon, GithubIcon, PencilIcon } from "@/components/icons";
import {
  ErrorText,
  Field,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  textareaClass,
} from "@/components/ui";

/**
 * What the project is, and where its code lives.
 *
 * Read-only for anybody who can see the project; editable by its heads and by
 * admins. The form is the same panel rather than a separate page: a description
 * is a sentence or two, and sending somebody to /admin to write it is how it
 * ends up never written.
 */
export function ProjectDetailsPanel({
  projectId,
  description,
  repoUrl,
  canEdit,
}: {
  projectId: string;
  description: string | null;
  repoUrl: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [editing, setEditing] = useState(false);
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [draftDescription, setDraftDescription] = useState(description ?? "");
  const [draftRepoUrl, setDraftRepoUrl] = useState(repoUrl ?? "");

  function save() {
    setError(null);
    startSave(async () => {
      const result = await updateProjectDetailsAction({
        projectId,
        description: draftDescription,
        repoUrl: draftRepoUrl,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setEditing(false);
      toast.show({ tone: "success", message: "Project details saved." });
      router.refresh();
    });
  }

  function cancel() {
    // Back to what the server last sent, not to blank: an abandoned edit should
    // leave no trace of itself.
    setDraftDescription(description ?? "");
    setDraftRepoUrl(repoUrl ?? "");
    setError(null);
    setEditing(false);
  }

  return (
    <section className="panel rounded-xl">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
        <div>
          <p className="eyebrow text-muted">About</p>
          <h2 className="mt-1 text-base font-semibold">This project</h2>
        </div>

        {canEdit && !editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={secondaryButtonClass}
          >
            <PencilIcon size={16} />
            {description || repoUrl ? "Edit" : "Add details"}
          </button>
        ) : null}
      </header>

      <div className="space-y-4 border-t border-border p-4 sm:p-5">
        {editing ? (
          <>
            <Field
              label="What this project is"
              hint="A couple of sentences, for whoever opens this page next."
            >
              <textarea
                className={textareaClass}
                rows={4}
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
                placeholder="Battery-powered soil sensor for the greenhouse trial. Two field units plus a spare."
              />
            </Field>

            <Field
              label="Repository"
              hint="The GitHub repo holding this project's firmware or code."
            >
              <input
                type="url"
                inputMode="url"
                className={inputClass}
                value={draftRepoUrl}
                onChange={(event) => setDraftRepoUrl(event.target.value)}
                placeholder="https://github.com/org/repo"
              />
            </Field>

            <ErrorText>{error}</ErrorText>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className={primaryButtonClass}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={cancel}
                disabled={saving}
                className={secondaryButtonClass}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            {description ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {description}
              </p>
            ) : (
              <p className="text-sm text-muted">
                {canEdit
                  ? "No description yet. Say what this project is, so the next person opening this page does not have to ask."
                  : "Nobody has described this project yet."}
              </p>
            )}

            {repoUrl ? (
              <a
                href={repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3.5 text-sm font-medium text-accent-text transition-colors hover:bg-surface-hover"
              >
                <GithubIcon size={16} />
                {repoLabel(repoUrl)}
                <ExternalLinkIcon size={14} />
              </a>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * `org/repo` rather than the whole URL.
 *
 * Falls back to the host, and then to the raw string, so a self-hosted Git or a
 * link that does not parse still reads as something rather than as nothing.
 */
function repoLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return parsed.host;
  } catch {
    return url;
  }
}
