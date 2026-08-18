"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { updateProjectDetailsAction } from "@/app/actions/projects";
import { useToast } from "@/components/toast";
import {
  DocumentIcon,
  ExternalLinkIcon,
  GithubIcon,
  PencilIcon,
} from "@/components/icons";
import {
  ErrorText,
  Field,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  textareaClass,
} from "@/components/ui";

/**
 * What the project is, where its code lives, and where it is written up.
 *
 * Read-only for anybody who can see the project; editable by its heads and by
 * admins. The form is the same panel rather than a separate page: a description
 * is a sentence or two, and sending somebody to /admin to write it is how it
 * ends up never written.
 *
 * The documentation link is stored, not derived. When it is empty and the repo is
 * on GitHub the panel offers GitHub's own `#readme` anchor instead — labelled as
 * a guess, because a monorepo's README is rarely at the root and a private repo
 * will simply refuse the reader. A guess offered as a guess is useful; the same
 * guess presented as the project's documentation is not.
 */
export function ProjectDetailsPanel({
  projectId,
  description,
  repoUrl,
  readmeUrl,
  canEdit,
}: {
  projectId: string;
  description: string | null;
  repoUrl: string | null;
  readmeUrl: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [editing, setEditing] = useState(false);
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [draftDescription, setDraftDescription] = useState(description ?? "");
  const [draftRepoUrl, setDraftRepoUrl] = useState(repoUrl ?? "");
  const [draftReadmeUrl, setDraftReadmeUrl] = useState(readmeUrl ?? "");

  function save() {
    setError(null);
    startSave(async () => {
      const result = await updateProjectDetailsAction({
        projectId,
        description: draftDescription,
        repoUrl: draftRepoUrl,
        readmeUrl: draftReadmeUrl,
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
    setDraftReadmeUrl(readmeUrl ?? "");
    setError(null);
    setEditing(false);
  }

  /** GitHub renders a repo's README at this anchor. Offered, never stored. */
  const guessedReadme =
    readmeUrl === null && repoUrl !== null && isGithub(repoUrl)
      ? `${repoUrl.replace(/\/+$/, "")}#readme`
      : null;

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
            {description || repoUrl || readmeUrl ? "Edit" : "Add details"}
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

            <Field
              label="README or docs"
              hint="Wherever this project is actually written up — a README in the repo, a wiki page, a doc in Drive. Leave it empty and a GitHub repo's own README is offered instead."
            >
              <input
                type="url"
                inputMode="url"
                className={inputClass}
                value={draftReadmeUrl}
                onChange={(event) => setDraftReadmeUrl(event.target.value)}
                placeholder="https://github.com/org/repo/blob/main/README.md"
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

            {repoUrl || readmeUrl || guessedReadme ? (
              <div className="flex flex-wrap gap-2">
                {repoUrl ? (
                  <LinkChip href={repoUrl} icon={<GithubIcon size={16} />}>
                    {repoLabel(repoUrl)}
                  </LinkChip>
                ) : null}

                {readmeUrl ? (
                  <LinkChip href={readmeUrl} icon={<DocumentIcon size={16} />}>
                    README
                  </LinkChip>
                ) : guessedReadme ? (
                  <LinkChip
                    href={guessedReadme}
                    icon={<DocumentIcon size={16} />}
                    muted
                    title="Not set for this project — this is GitHub's own README anchor for the repo above."
                  >
                    README on GitHub
                  </LinkChip>
                ) : null}
              </div>
            ) : null}

            {canEdit && !readmeUrl && !guessedReadme ? (
              <p className="text-xs text-muted">
                No documentation link yet. A README or a design doc is what stops
                the next person rebuilding what this project already knows.
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/** One outbound link, sized for a thumb. */
function LinkChip({
  href,
  icon,
  children,
  muted = false,
  title,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  /** For a link we inferred rather than one somebody set. */
  muted?: boolean;
  title?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={`inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3.5 text-sm font-medium transition-colors hover:bg-surface-hover ${
        muted ? "text-muted" : "text-accent-text"
      }`}
    >
      {icon}
      {children}
      <ExternalLinkIcon size={14} />
    </a>
  );
}

/** True for a github.com URL, which is the only host whose README we can guess. */
function isGithub(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase();
    return host === "github.com" || host.endsWith(".github.com");
  } catch {
    return false;
  }
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
