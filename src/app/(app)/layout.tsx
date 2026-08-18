import Link from "next/link";

import { db } from "@/db";
import { countUnread, listNotifications } from "@/db/queries/notifications";
import { requireUser, canManageInventory, canManageUsers } from "@/lib/auth";
import { ToastProvider } from "@/components/toast";
import { AccountMenu } from "@/components/account-menu";
import { BottomNav } from "@/components/bottom-nav";
import { NotificationBell } from "@/components/notification-bell";
import { SearchIcon } from "@/components/icons";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * The app shell.
 *
 * Two navigations, one per breakpoint: a fixed sidebar from `lg` up, and the
 * bottom bar below it. Only one is ever mounted visibly, so there is no
 * duplicated chrome on either — and the phone keeps the thumb-reachable
 * navigation the take-out flow is built around.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  const canManage = canManageInventory(user);
  const canUsers = canManageUsers(user);
  // A head sees the project screens for the projects they run, which is what
  // puts the BOM and its shortfall in reach without making them an admin.
  const canSeeProjects = canManage || user.leadProjectIds.length > 0;

  // Rendered here rather than fetched by the bell itself, so the unread badge
  // is right on first paint instead of popping in a moment later.
  const [recentNotifications, unreadCount] = await Promise.all([
    listNotifications(db, user.id, { limit: 8 }),
    countUnread(db, user.id),
  ]);

  return (
    <ToastProvider>
      <Sidebar
        canManage={canManage}
        canManageUsers={canUsers}
        canSeeProjects={canSeeProjects}
        canSeeOrders={canSeeProjects}
      />

      <div className="grid-backdrop flex min-h-dvh flex-col lg:pl-64">
        <header className="chrome-glass sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-6 lg:px-8">
          <span className="brand-mark text-lg font-bold tracking-tight lg:hidden">
            LabStock
          </span>

          {/* A link dressed as a field rather than a live input: search has a
              screen of its own with the fuzzy ranking on it, and a second box
              here would either duplicate that or quietly do less. */}
          <Link
            href="/"
            className="hidden min-h-9 max-w-sm flex-1 items-center gap-2.5 rounded-lg border border-border bg-surface/60 px-3 text-sm text-muted transition-colors hover:border-border-strong hover:text-foreground lg:flex"
          >
            <SearchIcon size={16} />
            Search parts, MPNs, cupboards…
          </Link>

          <div className="ml-auto flex items-center gap-1">
            <NotificationBell
              items={recentNotifications}
              unreadCount={unreadCount}
            />
            <ThemeToggle />
            <AccountMenu
              name={user.name}
              email={user.email}
              role={user.role}
              avatarUrl={user.avatarUrl}
            />
          </div>
        </header>

        <main className="flex flex-1 flex-col pb-20 lg:pb-0">{children}</main>

        <BottomNav canManage={canManage} />
      </div>
    </ToastProvider>
  );
}
