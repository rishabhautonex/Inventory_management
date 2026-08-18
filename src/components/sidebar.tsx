"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  BellIcon,
  CubeIcon,
  DashboardIcon,
  LayersIcon,
  PackageIcon,
  ReceiptIcon,
  RequestIcon,
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
  canSeeProjects,
  canSeeOrders,
}: {
  canManage: boolean;
  canManageUsers: boolean;
  /** Admins and managers, plus anybody who heads at least one project. */
  canSeeProjects: boolean;
  /**
   * Same set as `canSeeProjects`. A head reads the orders bought for their
   * projects — they approved the request behind them and are told when one is
   * overdue — but raising and receiving stay with `canManage`, so the group
   * holds only "Orders" for them.
   */
  canSeeOrders: boolean;
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
    // Above Inventory rather than inside Purchasing: raising one is the
    // engineer's move when a cupboard is empty, not an admin's buying step.
    {
      kind: "link",
      icon: RequestIcon,
      leaf: { href: "/requests", label: "Requests" },
    },
    ...(canSeeProjects
      ? [
          {
            kind: "link" as const,
            icon: LayersIcon,
            leaf: { href: "/projects", label: "Projects" },
          },
        ]
      : []),
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
              { href: "/admin/parts/import", label: "Import a list", exact: true },
              { href: "/admin/thresholds", label: "Minimums" },
            ]
          : []),
      ],
    },
    ...(canSeeOrders
      ? [
          {
            kind: "group" as const,
            label: "Purchasing",
            icon: ReceiptIcon,
            items: [
              { href: "/orders", label: "Orders", exact: true },
              ...(canManage
                ? [{ href: "/admin/vendors", label: "Vendors", exact: true }]
                : []),
              ...(canManage
                ? [
                    {
                      href: "/orders/from-invoice",
                      label: "From an invoice",
                      exact: true,
                    },
                    { href: "/orders/new", label: "New order", exact: true },
                  ]
                : []),
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
  canSeeProjects,
  canSeeOrders,
}: {
  canManage: boolean;
  canManageUsers: boolean;
  canSeeProjects: boolean;
  canSeeOrders: boolean;
}) {
  const pathname = usePathname();
  const nav = buildNav({
    canManage,
    canManageUsers,
    canSeeProjects,
    canSeeOrders,
  });
  const active = activeHref(pathname, nav);

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-border bg-sidebar lg:flex">
      <div className="flex h-16 shrink-0 items-center gap-2.5 px-5">
        <span
          aria-hidden
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-foreground shadow-[0_6px_16px_-8px_var(--accent)]"
        >
          <CubeIcon size={18} />
        </span>
        <span className="min-w-0">
          <Link
            href="/dashboard"
            className="brand-mark block text-lg font-bold leading-none tracking-tight"
          >
            LabStock
          </Link>
          <span className="eyebrow mt-1 block text-[0.5625rem] text-muted">
            R&amp;D inventory
          </span>
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
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
              <li key={entry.label} className="pt-5 first:pt-0">
                {/* A section heading, not a link — the group has no page of its
                    own, and styling it like one invites a dead click. */}
                <p className="eyebrow flex items-center gap-2 px-3 py-1.5 text-muted">
                  <entry.icon size={14} />
                  {entry.label}
                </p>
                <ul className="mt-1 space-y-0.5">
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

      <div className="shrink-0 border-t border-border px-5 py-3.5">
        <p className="flex items-center gap-2 text-[11px] font-medium text-muted">
          <span className="relative flex h-1.5 w-1.5 text-positive">
            <span
              aria-hidden
              className="pulse-ring absolute inset-0 rounded-full bg-current"
            />
            <span className="relative h-1.5 w-1.5 rounded-full bg-current" />
          </span>
          Append-only ledger
        </p>
      </div>
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
      /* Active is a tinted pill with a lit left edge rather than a solid
         accent block: the accent is a bright signal colour, and eight of them
         down a rail would shout louder than the screen it introduces. */
      className={`relative flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors ${
        inset ? "pl-10" : ""
      } ${
        active
          ? "bg-accent-soft text-accent-text"
          : "text-muted hover:bg-surface-hover hover:text-foreground"
      }`}
    >
      {active ? (
        <span
          aria-hidden
          className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]"
        />
      ) : null}
      {Icon ? <Icon size={18} /> : null}
      {leaf.label}
    </Link>
  );
}
