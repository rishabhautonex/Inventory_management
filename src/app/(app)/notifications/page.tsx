import { db } from "@/db";
import { countUnread, listNotifications } from "@/db/queries/notifications";
import { requireUser } from "@/lib/auth";
import { Card, EmptyState, Page, PageHeader } from "@/components/ui";
import { MarkAllReadButton } from "./mark-all-read-button";
import { NotificationItem } from "@/components/notification-item";

export const metadata = { title: "Notifications · LabStock" };

export default async function NotificationsPage() {
  const user = await requireUser();

  const [items, unread] = await Promise.all([
    listNotifications(db, user.id, { limit: 60 }),
    countUnread(db, user.id),
  ]);

  return (
    <Page>
      <PageHeader
        title="Notifications"
        description={
          unread > 0
            ? `${unread} unread. Alerts about low stock and empty shelves arrive here.`
            : "Alerts about low stock and empty shelves arrive here."
        }
        action={unread > 0 ? <MarkAllReadButton /> : undefined}
      />

      <Card className="overflow-hidden">
        {items.length === 0 ? (
          <EmptyState
            title="Nothing yet"
            description="When a part drops to its minimum, or a shelf empties out, the admins and that project's heads get told here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <NotificationItem key={item.id} item={item} />
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
