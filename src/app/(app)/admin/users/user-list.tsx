"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { setUserActiveAction, setUserRoleAction } from "@/app/actions/admin";
import { useToast } from "@/components/toast";
import {
  Badge,
  Card,
  ghostButtonClass,
  selectClass,
} from "@/components/ui";
import type { Role } from "@/lib/auth";
import type { PersonRow } from "./page";

const ROLES: Array<{ value: Role; label: string; hint: string }> = [
  { value: "engineer", label: "Engineer", hint: "Search, take out, view, request" },
  {
    value: "project_head",
    label: "Project head",
    hint: "Plus approvals for their projects",
  },
  { value: "admin", label: "Admin", hint: "Plus parts, orders, stock, locations" },
  { value: "manager", label: "Manager", hint: "Everything, and assigns roles" },
];

export function UserList({
  people,
  currentUserId,
}: {
  people: PersonRow[];
  currentUserId: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) router.refresh();
      else toast.show({ tone: "error", message: result.error ?? "Failed." });
    });
  }

  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-border">
        {people.map((person) => (
          <li
            key={person.id}
            className={`px-4 py-4 sm:px-5 ${person.isActive ? "" : "opacity-55"}`}
          >
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 truncate text-sm font-medium">
                  {person.name}
                  {person.id === currentUserId ? (
                    <Badge tone="accent">you</Badge>
                  ) : null}
                  {person.isActive ? null : (
                    <Badge tone="neutral">deactivated</Badge>
                  )}
                </p>
                <p className="truncate text-xs text-muted">{person.email}</p>
                {person.projects.length > 0 ? (
                  <p className="mt-1 truncate text-xs text-muted">
                    Heads: {person.projects.join(", ")}
                  </p>
                ) : null}
              </div>

              <div className="flex w-full items-center gap-3 sm:w-auto">
                <select
                  className={`${selectClass} sm:w-64`}
                  value={person.role}
                  disabled={pending}
                  aria-label={`Role for ${person.name}`}
                  onChange={(e) =>
                    run(() => setUserRoleAction(person.id, e.target.value as Role))
                  }
                >
                  {ROLES.map((role) => (
                    <option key={role.value} value={role.value}>
                      {role.label} — {role.hint}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  disabled={pending || person.id === currentUserId}
                  onClick={() =>
                    run(() => setUserActiveAction(person.id, !person.isActive))
                  }
                  className={`${ghostButtonClass} shrink-0`}
                >
                  {person.isActive ? "Deactivate" : "Reactivate"}
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
