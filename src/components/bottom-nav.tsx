"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  DashboardIcon,
  MovementsIcon,
  RequestIcon,
  SearchIcon,
  SettingsIcon,
  type IconProps,
} from "@/components/icons";

/**
 * Bottom-anchored so it stays under the thumb, and the only navigation below
 * `lg` — the sidebar is hidden there. Every target is at least 44px tall and
 * nothing here depends on hover.
 *
 * Capped at four entries so nothing is squeezed below a thumb's width on a
 * narrow phone. People lives under Admin rather than taking a fifth slot.
 *
 * The fourth slot goes to whichever screen that role actually opens on a phone.
 * For an engineer or a head that is Requests — asking for a part happens
 * standing at the empty cupboard. An admin gets Admin instead and reaches
 * Requests from the sidebar or a notification, because converting one into an
 * order is desk work either way.
 */
export function BottomNav({
  canManage,
}: {
  canManage: boolean;
}) {
  const pathname = usePathname();

  const items: Array<{
    href: string;
    label: string;
    icon: (props: IconProps) => React.ReactElement;
    match: (path: string) => boolean;
  }> = [
    {
      href: "/",
      label: "Search",
      icon: SearchIcon,
      match: (p) => p === "/" || p.startsWith("/parts/"),
    },
    {
      href: "/log",
      label: "Log",
      icon: MovementsIcon,
      match: (p) => p.startsWith("/log"),
    },
    {
      href: "/dashboard",
      label: "Dashboard",
      icon: DashboardIcon,
      match: (p) => p.startsWith("/dashboard"),
    },
    canManage
      ? {
          href: "/admin",
          label: "Admin",
          icon: SettingsIcon,
          match: (p: string) => p.startsWith("/admin"),
        }
      : {
          href: "/requests",
          label: "Requests",
          icon: RequestIcon,
          match: (p: string) => p.startsWith("/requests"),
        },
  ];

  return (
    <nav className="chrome-glass safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-border lg:hidden">
      <ul className="mx-auto flex max-w-md">
        {items.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;

          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors ${
                  active ? "text-accent-text" : "text-muted"
                }`}
              >
                {/* The lit bar rides the top edge rather than underlining the
                    label: at a cupboard the thumb covers the bottom of the
                    button, and an indicator under it would be hidden. */}
                {active ? (
                  <span
                    aria-hidden
                    className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-accent shadow-[0_0_10px_var(--accent)]"
                  />
                ) : null}
                <span
                  className={`flex h-8 w-12 items-center justify-center rounded-lg transition-colors ${
                    active ? "bg-accent-soft" : ""
                  }`}
                >
                  <Icon size={21} />
                </span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
