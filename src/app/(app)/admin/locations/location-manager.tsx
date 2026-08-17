"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  createLocationAction,
  setLocationActiveAction,
} from "@/app/actions/admin";
import { useToast } from "@/components/toast";
import { PlusIcon } from "@/components/icons";
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
import type { LocationNode } from "./page";

type LocationType = "cupboard" | "shelf" | "bin" | "general";

const TYPE_LABELS: Record<LocationType, string> = {
  cupboard: "Cupboard",
  shelf: "Shelf",
  bin: "Bin",
  general: "General shelf",
};

export function LocationManager({
  locations,
  projects,
}: {
  locations: LocationNode[];
  projects: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [type, setType] = useState<LocationType>("cupboard");
  const [parentId, setParentId] = useState("");
  const [projectId, setProjectId] = useState("");

  const needsParent = type === "shelf" || type === "bin";
  const canHaveProject = type === "cupboard";

  function reset() {
    setName("");
    setType("cupboard");
    setParentId("");
    setProjectId("");
    setError(null);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await createLocationAction({
        name,
        type,
        parentId: needsParent ? parentId || null : null,
        projectId: canHaveProject ? projectId || null : null,
      });

      if (result.ok) {
        reset();
        setAdding(false);
        toast.show({ tone: "success", message: "Location added." });
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  function toggleActive(location: LocationNode) {
    startTransition(async () => {
      const result = await setLocationActiveAction(
        location.id,
        !location.isActive,
      );
      if (result.ok) router.refresh();
      else toast.show({ tone: "error", message: result.error });
    });
  }

  // Only a cupboard or the general shelf can parent a shelf, and only a shelf
  // can parent a bin — that is the hierarchy the spec describes.
  const parentOptions = locations.filter((l) =>
    type === "shelf"
      ? l.type === "cupboard" || l.type === "general"
      : l.type === "shelf",
  );

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
                placeholder="Cupboard-Falcon"
                autoFocus
              />
            </Field>

            <Field label="Type" required>
              <select
                className={selectClass}
                value={type}
                onChange={(e) => {
                  setType(e.target.value as LocationType);
                  setParentId("");
                  setProjectId("");
                }}
              >
                {Object.entries(TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {needsParent ? (
            <Field label="Inside" required>
              <select
                className={selectClass}
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
              >
                <option value="">Choose a parent…</option>
                {parentOptions.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.path}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          {canHaveProject ? (
            <Field
              label="Project"
              hint="Stock in this cupboard counts as that project's. Shelves and bins inherit it."
            >
              <select
                className={selectClass}
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          <ErrorText>{error}</ErrorText>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className={primaryButtonClass}
              onClick={submit}
              disabled={pending || !name.trim() || (needsParent && !parentId)}
            >
              {pending ? "Saving…" : "Add location"}
            </button>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => {
                setAdding(false);
                reset();
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
          Add location
        </button>
      )}

      <Card className="overflow-hidden">
        {locations.length === 0 ? (
          <EmptyState
            title="No locations yet"
            description="Start with a cupboard for each project, plus one general shelf for shared consumables."
          />
        ) : (
          <ul className="divide-y divide-border">
            {locations.map((location) => (
              <li
                key={location.id}
                className={`flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-muted/40 ${
                  location.isActive ? "" : "opacity-55"
                }`}
              >
                <div
                  className="min-w-0 flex-1"
                  style={{ paddingLeft: `${(location.depth - 1) * 18}px` }}
                >
                  <p className="truncate text-sm font-medium">{location.name}</p>
                  <p className="truncate text-xs text-muted">
                    {TYPE_LABELS[location.type]}
                    {location.projectName ? ` · ${location.projectName}` : ""}
                    {location.itemCount > 0
                      ? ` · ${location.itemCount} part${location.itemCount === 1 ? "" : "s"}`
                      : ""}
                  </p>
                </div>

                {location.isActive ? null : (
                  <Badge tone="neutral">retired</Badge>
                )}

                <button
                  type="button"
                  onClick={() => toggleActive(location)}
                  disabled={pending}
                  className={ghostButtonClass}
                >
                  {location.isActive ? "Retire" : "Restore"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
