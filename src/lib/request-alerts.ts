import { sql } from "drizzle-orm";

import { runQuery } from "@/db/rows";
import type { Database } from "@/db/types";
import type { RequestStatus } from "@/db/queries/requests";
import { notify } from "@/lib/notify";

/**
 * Notifications for the request workflow.
 *
 * Called after the row has changed, never inside the same statement, and — like
 * the stock alerts — nothing in here is allowed to throw. A request that was
 * genuinely approved must stay approved even if telling somebody about it
 * fails.
 *
 * Unlike low stock, none of these carry a dedupe key: each one marks a distinct
 * transition that happened once, so suppressing a repeat would only ever hide a
 * real event.
 */

type RequestSummary = {
  id: string;
  projectId: string;
  projectName: string;
  requestedBy: string;
  requesterName: string;
  label: string;
  qty: number;
  status: RequestStatus;
  decisionNote: string | null;
  deciderName: string | null;
};

async function readSummary(
  db: Database,
  requestId: string,
): Promise<RequestSummary | null> {
  const rows = await runQuery<{
    id: string;
    project_id: string;
    project_name: string;
    requested_by: string;
    requester_name: string;
    label: string;
    qty: string | number;
    status: RequestStatus;
    decision_note: string | null;
    decider_name: string | null;
  }>(
    db,
    sql`
      SELECT
        r.id,
        r.project_id,
        p.name  AS project_name,
        r.requested_by,
        ru.name AS requester_name,
        COALESCE(c.name, r.free_text) AS label,
        r.qty,
        r.status,
        r.decision_note,
        du.name AS decider_name
      FROM part_requests r
      JOIN projects p        ON p.id = r.project_id
      JOIN users ru          ON ru.id = r.requested_by
      LEFT JOIN users du     ON du.id = r.decided_by
      LEFT JOIN components c ON c.id = r.component_id
      WHERE r.id = ${requestId}
    `,
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    requestedBy: row.requested_by,
    requesterName: row.requester_name,
    label: row.label ?? "a part",
    qty: Number(row.qty),
    status: row.status,
    decisionNote: row.decision_note,
    deciderName: row.decider_name,
  };
}

/**
 * The heads of one project.
 *
 * Approval rights are per project, so this is the exact set of people who can
 * act on a pending request — nobody else is asked to look at it.
 */
async function findApprovers(
  db: Database,
  projectId: string,
): Promise<string[]> {
  const rows = await runQuery<{ id: string }>(
    db,
    sql`
      SELECT u.id
      FROM users u
      JOIN project_leads pl ON pl.user_id = u.id
      WHERE u.is_active AND pl.project_id = ${projectId}
    `,
  );
  return rows.map((r) => r.id);
}

async function findAdmins(db: Database): Promise<string[]> {
  const rows = await runQuery<{ id: string }>(
    db,
    sql`SELECT id FROM users WHERE is_active AND role = 'admin'`,
  );
  return rows.map((r) => r.id);
}

function quantityOf(summary: RequestSummary): string {
  return `${summary.qty} × ${summary.label}`;
}

/**
 * A new request needs a decision from that project's heads.
 *
 * Managers can approve anything but are not pinged here, matching how the stock
 * alerts treat them. A project with no head assigned is the one exception: the
 * request would otherwise sit unseen forever, so it falls through to the admins
 * who can escalate it.
 */
export async function notifyRequestRaised(
  db: Database,
  requestId: string,
): Promise<void> {
  try {
    const summary = await readSummary(db, requestId);
    if (!summary) return;

    const heads = await findApprovers(db, summary.projectId);
    const recipients = heads.length > 0 ? heads : await findAdmins(db);

    // Somebody approving their own request still gets a row otherwise, which
    // reads as noise rather than as news.
    const audience = recipients.filter((id) => id !== summary.requestedBy);
    if (audience.length === 0) return;

    await notify(db, audience, {
      type: "request_pending",
      title: `${summary.requesterName} wants ${quantityOf(summary)}`,
      body: `For ${summary.projectName}. Waiting on your approval.`,
      linkUrl: `/requests/${summary.id}`,
    });
  } catch (error) {
    console.error("[request alerts] raised", error);
  }
}

/**
 * The requester is told at every state change, per the spec.
 *
 * An approval also tells the admins, because approving is not buying — somebody
 * still has to turn it into an order, and that queue is theirs.
 */
export async function notifyRequestDecided(
  db: Database,
  requestId: string,
): Promise<void> {
  try {
    const summary = await readSummary(db, requestId);
    if (!summary) return;

    const decider = summary.deciderName ?? "A project head";

    let title: string;
    let body: string;

    switch (summary.status) {
      case "approved":
        title = `Approved: ${quantityOf(summary)}`;
        body = `${decider} approved it for ${summary.projectName}. An admin will order it.`;
        break;
      case "rejected":
        title = `Turned down: ${quantityOf(summary)}`;
        body = summary.decisionNote
          ? `${decider} said: ${summary.decisionNote}`
          : `${decider} turned it down.`;
        break;
      case "ordered":
        title = `Ordered: ${quantityOf(summary)}`;
        body = `It is on its way for ${summary.projectName}.`;
        break;
      default:
        return;
    }

    await notify(db, [summary.requestedBy], {
      type: "request_decided",
      title,
      body,
      linkUrl: `/requests/${summary.id}`,
    });

    if (summary.status === "approved") {
      const admins = (await findAdmins(db)).filter(
        (id) => id !== summary.requestedBy,
      );
      if (admins.length > 0) {
        await notify(db, admins, {
          type: "request_decided",
          title: `Ready to order: ${quantityOf(summary)}`,
          body: `Approved for ${summary.projectName} and waiting to be bought.`,
          linkUrl: `/requests/${summary.id}`,
        });
      }
    }
  } catch (error) {
    console.error("[request alerts] decided", error);
  }
}
