import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { and, eq } from "drizzle-orm";

import {
  components,
  notifications,
  partRequests,
  projectLeads,
  projects,
  users,
} from "../src/db/schema";
import {
  countAwaitingMe,
  getRequestCounts,
  listRequests,
  visibilityFor,
} from "../src/db/queries/requests";
import {
  notifyRequestDecided,
  notifyRequestRaised,
} from "../src/lib/request-alerts";
import type { SessionUser } from "../src/lib/auth";
import { createTestDb, errorText, type TestDb } from "./harness";

/**
 * Part requests.
 *
 *   engineer raises  →  project head approves  →  admin converts to an order
 *
 * The rules worth defending are the ones the spec states outright: approval
 * belongs to a head of *that* project, a rejection is not a rejection without a
 * note, and the requester hears about every state change. The role-aware
 * visibility of the screen is the fourth — an engineer must not be able to read
 * the whole lab's requests by guessing an id.
 */

let db: TestDb;
let client: { close: () => Promise<void> };

const ids: Record<string, string> = {};

/** Enough of a session user for the visibility and badge helpers. */
function session(
  id: string,
  role: SessionUser["role"],
  leadProjectIds: string[] = [],
): SessionUser {
  return {
    id,
    email: `${id}@autonexai360.com`,
    name: id,
    avatarUrl: null,
    role,
    isActive: true,
    leadProjectIds,
  };
}

async function makeUser(
  key: string,
  role: "engineer" | "project_head" | "admin" | "manager",
) {
  const [row] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      googleSub: `req-${key}`,
      email: `req-${key}@autonexai360.com`,
      name: key,
      role,
    })
    .returning();
  return row;
}

async function notificationsFor(userId: string, type?: string) {
  return db
    .select()
    .from(notifications)
    .where(
      type
        ? and(
            eq(notifications.userId, userId),
            eq(notifications.type, type),
          )
        : eq(notifications.userId, userId),
    );
}

before(async () => {
  const created = await createTestDb();
  db = created.db;
  client = created.client;

  const engineer = await makeUser("engineer", "engineer");
  const falconHead = await makeUser("falcon-head", "project_head");
  const kestrelHead = await makeUser("kestrel-head", "project_head");
  const admin = await makeUser("admin", "admin");
  const manager = await makeUser("manager", "manager");

  ids.engineer = engineer.id;
  ids.falconHead = falconHead.id;
  ids.kestrelHead = kestrelHead.id;
  ids.admin = admin.id;
  ids.manager = manager.id;

  const [falcon] = await db
    .insert(projects)
    .values({ name: "Falcon", code: "REQFAL" })
    .returning();
  const [kestrel] = await db
    .insert(projects)
    .values({ name: "Kestrel", code: "REQKES" })
    .returning();
  const [orphan] = await db
    .insert(projects)
    .values({ name: "Orphan", code: "REQORP" })
    .returning();

  ids.falcon = falcon.id;
  ids.kestrel = kestrel.id;
  ids.orphan = orphan.id;

  await db.insert(projectLeads).values([
    { projectId: falcon.id, userId: falconHead.id },
    { projectId: kestrel.id, userId: kestrelHead.id },
  ]);

  const [esp] = await db
    .insert(components)
    .values({ name: "ESP32 DevKit", mpn: "REQ-ESP32", createdBy: admin.id })
    .returning();
  ids.esp = esp.id;
});

after(async () => {
  await client.close();
});

/* -------------------------------------------------------------------------- */
/* What a request may say                                                      */
/* -------------------------------------------------------------------------- */

describe("what a request may say", () => {
  test("it points at a catalogue part or describes one, never both", async () => {
    await assert.rejects(
      () =>
        db.insert(partRequests).values({
          requestedBy: ids.engineer,
          projectId: ids.falcon,
          componentId: ids.esp,
          freeText: "an ESP32, roughly",
          qty: 1,
        }),
      (error: unknown) => /part_requests_target/.test(errorText(error)),
    );
  });

  test("and it must say one of them", async () => {
    await assert.rejects(
      () =>
        db.insert(partRequests).values({
          requestedBy: ids.engineer,
          projectId: ids.falcon,
          qty: 1,
        }),
      (error: unknown) => /part_requests_target/.test(errorText(error)),
    );
  });

  test("asking for nothing is refused", async () => {
    await assert.rejects(
      () =>
        db.insert(partRequests).values({
          requestedBy: ids.engineer,
          projectId: ids.falcon,
          componentId: ids.esp,
          qty: 0,
        }),
      (error: unknown) => /part_requests_qty_positive/.test(errorText(error)),
    );
  });

  test("a rejection without a reason is not a decision", async () => {
    const [row] = await db
      .insert(partRequests)
      .values({
        requestedBy: ids.engineer,
        projectId: ids.falcon,
        componentId: ids.esp,
        qty: 2,
      })
      .returning();

    await assert.rejects(
      () =>
        db
          .update(partRequests)
          .set({
            status: "rejected",
            decidedBy: ids.falconHead,
            decidedAt: new Date(),
          })
          .where(eq(partRequests.id, row.id)),
      (error: unknown) =>
        /part_requests_rejection_needs_note/.test(errorText(error)),
    );

    // With a note it goes through.
    await db
      .update(partRequests)
      .set({
        status: "rejected",
        decidedBy: ids.falconHead,
        decidedAt: new Date(),
        decisionNote: "Six on the Kestrel shelf — use those.",
      })
      .where(eq(partRequests.id, row.id));

    const [after] = await db
      .select()
      .from(partRequests)
      .where(eq(partRequests.id, row.id));
    assert.equal(after.status, "rejected");
  });
});

/* -------------------------------------------------------------------------- */
/* Who hears about it                                                          */
/* -------------------------------------------------------------------------- */

describe("who hears about a request", () => {
  test("a new one goes to the heads of that project and nobody else", async () => {
    const [row] = await db
      .insert(partRequests)
      .values({
        requestedBy: ids.engineer,
        projectId: ids.falcon,
        componentId: ids.esp,
        qty: 5,
      })
      .returning();

    await notifyRequestRaised(db, row.id);

    const falcon = await notificationsFor(ids.falconHead, "request_pending");
    assert.equal(falcon.length, 1);
    assert.match(falcon[0].title, /5 × ESP32 DevKit/);

    const kestrel = await notificationsFor(ids.kestrelHead, "request_pending");
    assert.equal(
      kestrel.length,
      0,
      "approval is per project, so another project's head is not asked",
    );

    const manager = await notificationsFor(ids.manager, "request_pending");
    assert.equal(
      manager.length,
      0,
      "managers get a digest, not a ping for every request",
    );

    ids.falconRequest = row.id;
  });

  test("a project with no head falls through to the admins", async () => {
    const [row] = await db
      .insert(partRequests)
      .values({
        requestedBy: ids.engineer,
        projectId: ids.orphan,
        freeText: "Waveshare e-paper 7.5in",
        qty: 1,
      })
      .returning();

    await notifyRequestRaised(db, row.id);

    const admin = await notificationsFor(ids.admin, "request_pending");
    assert.equal(
      admin.length,
      1,
      "otherwise the request sits unseen for ever",
    );
    assert.match(admin[0].title, /Waveshare/);
  });

  test("approving tells the requester, and the admins who must buy it", async () => {
    await db
      .update(partRequests)
      .set({
        status: "approved",
        decidedBy: ids.falconHead,
        decidedAt: new Date(),
      })
      .where(eq(partRequests.id, ids.falconRequest));

    await notifyRequestDecided(db, ids.falconRequest);

    const requester = await notificationsFor(ids.engineer, "request_decided");
    assert.equal(requester.length, 1);
    assert.match(requester[0].title, /^Approved/);
    assert.match(requester[0].body ?? "", /falcon-head/);

    const admin = await notificationsFor(ids.admin, "request_decided");
    assert.equal(admin.length, 1);
    assert.match(admin[0].title, /Ready to order/);
  });

  test("a rejection carries the reason to the requester", async () => {
    const [row] = await db
      .insert(partRequests)
      .values({
        requestedBy: ids.engineer,
        projectId: ids.kestrel,
        componentId: ids.esp,
        qty: 3,
        status: "rejected",
        decidedBy: ids.kestrelHead,
        decidedAt: new Date(),
        decisionNote: "Buy it next quarter.",
      })
      .returning();

    await notifyRequestDecided(db, row.id);

    const requester = await notificationsFor(ids.engineer, "request_decided");
    const rejection = requester.find((n) => /Turned down/.test(n.title));

    assert.ok(rejection, "the requester is told either way");
    assert.match(rejection.body ?? "", /Buy it next quarter\./);

    const admin = await notificationsFor(ids.admin, "request_decided");
    assert.equal(
      admin.filter((n) => /Turned down/.test(n.title)).length,
      0,
      "a rejection creates no buying work, so it goes nowhere else",
    );
  });

  test("delivering a notification never fails the decision it describes", async () => {
    // A request that has since vanished must not throw out of the alert.
    await notifyRequestRaised(db, crypto.randomUUID());
    await notifyRequestDecided(db, crypto.randomUUID());
  });
});

/* -------------------------------------------------------------------------- */
/* Who sees what                                                               */
/* -------------------------------------------------------------------------- */

describe("the screen is role-aware", () => {
  test("an engineer sees their own and nothing else", async () => {
    const other = await makeUser("other-engineer", "engineer");
    await db.insert(partRequests).values({
      requestedBy: other.id,
      projectId: ids.falcon,
      componentId: ids.esp,
      qty: 9,
    });

    const mine = await listRequests(
      db,
      visibilityFor(session(ids.engineer, "engineer")),
    );

    assert.ok(mine.length > 0);
    assert.ok(
      mine.every((row) => row.requestedById === ids.engineer),
      "somebody else's request must not be readable",
    );
  });

  test("a head sees the queue for the projects they run", async () => {
    const rows = await listRequests(
      db,
      visibilityFor(session(ids.falconHead, "project_head", [ids.falcon])),
    );

    assert.ok(rows.some((row) => row.projectId === ids.falcon));
    assert.ok(
      !rows.some(
        (row) => row.projectId === ids.kestrel && row.requestedById !== ids.falconHead,
      ),
      "a project they do not head is not theirs to read",
    );
  });

  test("an admin sees the lot", async () => {
    const rows = await listRequests(db, visibilityFor(session(ids.admin, "admin")));
    const projectsSeen = new Set(rows.map((row) => row.projectId));

    assert.ok(projectsSeen.has(ids.falcon));
    assert.ok(projectsSeen.has(ids.kestrel));
    assert.ok(projectsSeen.has(ids.orphan));
  });

  test("waiting-on-me is narrower than can-see", async () => {
    // The head's own request against a project they do not run is visible to
    // them and not theirs to decide.
    await db.insert(partRequests).values({
      requestedBy: ids.falconHead,
      projectId: ids.kestrel,
      componentId: ids.esp,
      qty: 1,
    });

    const visible = await listRequests(
      db,
      visibilityFor(session(ids.falconHead, "project_head", [ids.falcon])),
    );
    assert.ok(visible.some((row) => row.projectId === ids.kestrel));

    const awaiting = await countAwaitingMe(
      db,
      session(ids.falconHead, "project_head", [ids.falcon]),
    );
    const pendingFalcon = visible.filter(
      (row) => row.projectId === ids.falcon && row.status === "pending",
    ).length;

    assert.equal(awaiting, pendingFalcon);
  });

  test("an admin's queue is what has been approved", async () => {
    const counts = await getRequestCounts(
      db,
      visibilityFor(session(ids.admin, "admin")),
    );
    const awaiting = await countAwaitingMe(db, session(ids.admin, "admin"));

    assert.equal(awaiting, counts.approved);
    assert.ok(counts.approved > 0);
  });

  test("an engineer has no queue at all", async () => {
    const awaiting = await countAwaitingMe(
      db,
      session(ids.engineer, "engineer"),
    );
    assert.equal(awaiting, 0);
  });
});
