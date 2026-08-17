import { db } from "@/db";
import { countUnread, listNotifications } from "@/db/queries/notifications";
import { requireUser, canManageInventory, canManageUsers } from "@/lib/auth";
import { ToastProvider } from "@/components/toast";
import { AccountMenu } from "@/components/account-menu";
import { BottomNav } from "@/components/bottom-nav";
import { NotificationBell } from "@/components/notification-bell";
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

  // Rendered here rather than fetched by the bell itself, so the unread badge
  // is right on first paint instead of popping in a moment later.
  const [recentNotifications, unreadCount] = await Promise.all([
    listNotifications(db, user.id, { limit: 8 }),
    countUnread(db, user.id),
  ]);

  return (
    <ToastProvider>
      <Sidebar canManage={canManage} canManageUsers={canUsers} />

      <div className="flex min-h-dvh flex-col lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6 lg:px-8">
          <span className="brand-mark text-lg font-bold tracking-tight lg:hidden">
            LabStock
          </span>

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
