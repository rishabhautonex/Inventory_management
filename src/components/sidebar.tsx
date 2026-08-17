"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  BellIcon,
  DashboardIcon,
  PackageIcon,
  ReceiptIcon,
  SettingsIcon,
  type IconProps,
} from "@/components/icons";

type Leaf = {
  href: string;
  label: string;
  /** Only active on an exact path match. */
  exact?: boolean;
  /** Extra path prefixes this entry owns, for detail pages under another route. */
  match?: string[];
};

type Entry =
  | { kind: "link"; icon: (props: IconProps) => React.ReactElement; leaf: Leaf }
  | {
      kind: "group";
      label: string;
      icon: (props: IconProps) => React.ReactElement;
      items: Leaf[];
    };

export function buildNav({
  canManage,
  canManageUsers,
}: {
  canManage: boolean;
  canManageUsers: boolean;
}): Entry[] {
  return [
    {
      kind: "link",
      icon: DashboardIcon,
      leaf: { href: "/dashboard", label: "Dashboard" },
    },
    {
      kind: "link",
      icon: BellIcon,
      leaf: { href: "/notifications", label: "Notifications" },
    },
    {
      kind: "group",
      label: "Inventory",
      icon: PackageIcon,
      items: [
        { href: "/", label: "Search parts", exact: true, match: ["/parts"] },
        { href: "/log", label: "Stock movements" },
        ...(canManage
          ? [
              { href: "/admin/parts", label: "All parts" },
              { href: "/admin/parts/new", label: "Add part", exact: true },
            ]
          : []),
      ],
    },
    ...(canManage
      ? [
          {
            kind: "group" as const,
            label: "Purchasing",
            icon: ReceiptIcon,
            items: [
              { href: "/orders", label: "Orders", exact: true },
              {
                href: "/orders/from-invoice",
                label: "From an invoice",
                exact: true,
              },
              { href: "/orders/new", label: "New order", exact: true },
            ],
          },
        ]
      : []),
    ...(canManage
      ? [
          {
            kind: "group" as const,
            label: "Admin",
            icon: SettingsIcon,
            items: [
              { href: "/admin", label: "Overview", exact: true },
              { href: "/admin/locations", label: "Locations" },
              { href: "/admin/projects", label: "Projects" },
              ...(canManageUsers
                ? [{ href: "/admin/users", label: "People" }]
                : []),
            ],
          },
        ]
      : []),
  ];
}

function matches(pathname: string, leaf: Leaf): boolean {
  const prefixes = [leaf.href, ...(leaf.match ?? [])];

  return prefixes.some((prefix) => {
    if (pathname === prefix) return true;
    if (leaf.exact && prefix === leaf.href) return false;
    return pathname.startsWith(`${prefix}/`);
  });
}

/**
 * Which single entry is highlighted.
 *
 * Longest match wins, so `/admin/parts/new` lights up "Add part" rather than
 * also lighting up "All parts" — a plain `startsWith` marks both.
 */
export function activeHref(pathname: string, nav: Entry[]): string | null {
  const leaves = nav.flatMap((entry) =>
    entry.kind === "link" ? [entry.leaf] : entry.items,
  );

  const hit = leaves
    .filter((leaf) => matches(pathname, leaf))
    .sort((a, b) => b.href.length - a.href.length)[0];

  return hit?.href ?? null;
}

/**
 * The desktop sidebar.
 *
 * Hidden below `lg`, where the bottom nav takes over: the spec's core flow is a
 * phone held one-handed at a cupboard, and a sidebar is not that.
 */
export function Sidebar({
  canManage,
  canManageUsers,
}: {
  canManage: boolean;
  canManageUsers: boolean;
}) {
  const pathname = usePathname();
  const nav = buildNav({ canManage, canManageUsers });
  const active = activeHref(pathname, nav);

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-border bg-sidebar lg:flex">
      <div className="flex h-16 shrink-0 items-center px-6">
        <Link
          href="/dashboard"
          className="brand-mark text-xl font-bold tracking-tight"
        >
          LabStock
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-6">
        <ul className="space-y-1">
          {nav.map((entry) =>
            entry.kind === "link" ? (
              <li key={entry.leaf.href}>
                <NavLink
                  leaf={entry.leaf}
                  icon={entry.icon}
                  active={active === entry.leaf.href}
                />
              </li>
            ) : (
              <li key={entry.label} className="pt-4 first:pt-0">
                <p className="flex items-center gap-3 px-3 py-2 text-sm font-medium text-muted">
                  <entry.icon size={18} />
                  {entry.label}
                </p>
                <ul className="mt-0.5 space-y-0.5">
                  {entry.items.map((leaf) => (
                    <li key={leaf.href}>
                      <NavLink leaf={leaf} active={active === leaf.href} inset />
                    </li>
                  ))}
                </ul>
              </li>
            ),
          )}
        </ul>
      </nav>
    </aside>
  );
}

function NavLink({
  leaf,
  icon: Icon,
  active,
  inset = false,
}: {
  leaf: Leaf;
  icon?: (props: IconProps) => React.ReactElement;
  active: boolean;
  inset?: boolean;
}) {
  return (
    <Link
      href={leaf.href}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors ${
        inset ? "pl-11" : ""
      } ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted hover:bg-surface-hover hover:text-foreground"
      }`}
    >
      {Icon ? <Icon size={18} /> : null}
      {leaf.label}
    </Link>
  );
}
