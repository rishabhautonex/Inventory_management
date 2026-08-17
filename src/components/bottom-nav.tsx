"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  DashboardIcon,
  MovementsIcon,
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
    ...(canManage
      ? [
          {
            href: "/admin",
            label: "Admin",
            icon: SettingsIcon,
            match: (p: string) => p.startsWith("/admin"),
          },
        ]
      : []),
  ];

  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-border bg-sidebar/95 backdrop-blur lg:hidden">
      <ul className="mx-auto flex max-w-md">
        {items.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;

          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-16 flex-col items-center justify-center gap-1 text-xs font-medium transition-colors ${
                  active ? "text-accent-text" : "text-muted"
                }`}
              >
                {active ? (
                  <span
                    aria-hidden
                    className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-accent-text"
                  />
                ) : null}
                <Icon size={22} />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
