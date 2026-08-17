"use client";

import { useEffect, useRef, useState } from "react";

import { SignOutIcon } from "@/components/icons";

const ROLE_LABELS: Record<string, string> = {
  engineer: "Engineer",
  project_head: "Project head",
  admin: "Admin",
  manager: "Manager",
};

export function AccountMenu({
  name,
  email,
  role,
  avatarUrl,
}: {
  name: string;
  email: string;
  role: string;
  avatarUrl: string | null;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account"
        className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-full border border-border bg-surface-muted text-xs font-semibold transition-colors hover:border-border-strong"
      >
        {avatarUrl ? (
          // Supabase avatar URLs are remote; a plain img avoids configuring
          // next/image remote patterns for a 44px decorative element.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          initials || "?"
        )}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-13 z-40 w-64 overflow-hidden rounded-xl border border-border bg-surface shadow-(--shadow-panel)"
        >
          <div className="border-b border-border px-4 py-3">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-muted">{email}</p>
            <p className="mt-2 inline-block rounded-md bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent-text">
              {ROLE_LABELS[role] ?? role}
            </p>
          </div>

          <form action="/auth/signout" method="post">
            <button
              type="submit"
              role="menuitem"
              className="flex min-h-12 w-full items-center gap-2.5 px-4 text-left text-sm font-medium text-danger transition-colors hover:bg-danger/10"
            >
              <SignOutIcon size={18} />
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
