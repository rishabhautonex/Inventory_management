import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { eq } from "drizzle-orm";

import { listOrders } from "../src/db/queries/orders";
import {
  getProject,
  getProjectAttention,
  getProjectStock,
  listProjectSignals,
} from "../src/db/queries/projects";
import { boms, bomLines, orderLines, orders, projects, stockThresholds } from "../src/db/schema";
import { canViewOrder, type SessionUser } from "../src/lib/auth";
import { issueStock, recordMovement } from "../src/lib/ledger";
import { createTestDb, makeFixtures, type TestDb } from "./harness";

/**
 * What a project head can see.
 *
 * Two things are being defended here. The first is that an empty shelf is still
 * a row: `getProjectStock()` drops `on_hand = 0` so that "in the cupboard"
 * lists what is actually there, and the head who was notified that a part hit
 * zero has to find it somewhere — `getProjectAttention()` is that somewhere.
 * The second is that every one of these views is scoped to the project asked
 * for and never leaks a neighbouring cupboard, which is the same lab policy the
 * shortfall table rests on.
 */

let db: TestDb;
let client: { close: () => Promise<void> };

before(async () => {
  const created = await createTestDb();
  db = created.db;
  client = created.client;
});

after(async () => {
  await client.close();
});

function sessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: crypto.randomUUID(),
    email: "head@autonexai360.com",
    name: "A Head",
    avatarUrl: null,
    role: "project_head",
    isActive: true,
    leadProjectIds: [],
    ...overrides,
  };
}

describe("project attention", () => {
  test("keeps a shelf that has hit zero, which the stock list drops", async () => {
    const f = await makeFixtures(db);

    await db.insert(stockThresholds).values({
      componentId: f.component.id,
      locationId: f.shelf.id,
      minQty: 4,
    });

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 6,
      reason: "receipt",
      userId: f.user.id,
    });
    await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 6,
      userId: f.user.id,
    });

    const stock = await getProjectStock(db, f.project.id);
    assert.equal(
      stock.filter((line) => line.componentId === f.component.id).length,
      0,
      "the cupboard list is what is on the shelf, so an empty shelf is absent",
    );

    const attention = await getProjectAttention(db, f.project.id);
    const line = attention.find((row) => row.componentId === f.component.id);

    assert.ok(line, "the empty shelf is exactly what this list is for");
    assert.equal(line.onHand, 0);
    assert.equal(line.minQty, 4);
    assert.equal(line.locationId, f.shelf.id);
  });

  test("lists a threshold whose shelf has never seen a movement", async () => {
    const f = await makeFixtures(db);

    await db.insert(stockThresholds).values({
      componentId: f.component.id,
      locationId: f.shelf.id,
      minQty: 2,
    });

    const attention = await getProjectAttention(db, f.project.id);
    const line = attention.find((row) => row.componentId === f.component.id);

    // No ledger row means no `stock_on_hand` row, and a LEFT JOIN is the only
    // thing keeping this shelf on the list. It is empty, not missing.
    assert.ok(line);
    assert.equal(line.onHand, 0);
  });

  test("ignores a shelf that is above its minimum, and one with no minimum", async () => {
    const f = await makeFixtures(db);

    await db.insert(stockThresholds).values({
      componentId: f.component.id,
      locationId: f.shelf.id,
      minQty: 2,
    });
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 9,
      reason: "receipt",
      userId: f.user.id,
    });

    const healthy = await getProjectAttention(db, f.project.id);
    assert.equal(healthy.length, 0);

    // A second part on the same shelf, low but unwatched: without a minimum
    // there is no standard for it to be under.
    const other = await makeFixtures(db);
    await recordMovement(db, {
      componentId: other.component.id,
      locationId: f.shelf.id,
      qtyDelta: 1,
      reason: "receipt",
      userId: f.user.id,
    });

    const still = await getProjectAttention(db, f.project.id);
    assert.equal(still.length, 0);
  });

  test("never reaches into another project's cupboard", async () => {
    const mine = await makeFixtures(db);
    const theirs = await makeFixtures(db);

    await db.insert(stockThresholds).values({
      componentId: theirs.component.id,
      locationId: theirs.shelf.id,
      minQty: 5,
    });

    const attention = await getProjectAttention(db, mine.project.id);
    assert.equal(
      attention.filter((row) => row.locationId === theirs.shelf.id).length,
      0,
    );
  });

  test("puts the emptiest shelf first, not the smallest number", async () => {
    const f = await makeFixtures(db);
    const nearlyOut = await makeFixtures(db);

    // 0 of 2 is worse than 18 of 20 even though 18 > 0.
    await db.insert(stockThresholds).values([
      { componentId: f.component.id, locationId: f.shelf.id, minQty: 20 },
      {
        componentId: nearlyOut.component.id,
        locationId: f.shelf.id,
        minQty: 2,
      },
    ]);
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 18,
      reason: "receipt",
      userId: f.user.id,
    });

    const attention = await getProjectAttention(db, f.project.id);

    assert.equal(attention.length, 2);
    assert.equal(attention[0]!.componentId, nearlyOut.component.id);
    assert.equal(attention[0]!.onHand, 0);
  });
});

describe("project signals", () => {
  test("counts low and empty apart", async () => {
    const f = await makeFixtures(db);
    const low = await makeFixtures(db);

    await db.insert(stockThresholds).values([
      { componentId: f.component.id, locationId: f.shelf.id, minQty: 3 },
      { componentId: low.component.id, locationId: f.shelf.id, minQty: 10 },
    ]);
    await recordMovement(db, {
      componentId: low.component.id,
      locationId: f.shelf.id,
      qtyDelta: 4,
      reason: "receipt",
      userId: f.user.id,
    });

    const [signal] = await listProjectSignals(db, [f.project.id]);

    assert.ok(signal);
    assert.equal(signal.empty, 1, "the shelf with nothing on it");
    assert.equal(signal.low, 1, "4 of 10 is low but not empty");
  });

  test("shortfall is null for a project with no BOM, a number once it has one", async () => {
    const f = await makeFixtures(db);

    const [before] = await listProjectSignals(db, [f.project.id]);
    assert.equal(
      before?.shortLines,
      null,
      "nothing asked for is not the same as everything arrived",
    );

    const [bom] = await db
      .insert(boms)
      .values({ projectId: f.project.id, name: "Rev A" })
      .returning();
    await db.insert(bomLines).values({
      bomId: bom.id,
      componentId: f.component.id,
      qtyNeeded: 10,
    });

    const [short] = await listProjectSignals(db, [f.project.id]);
    assert.equal(short?.shortLines, 1);

    // Ten pieces on the project's own shelf closes the gap.
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 10,
      reason: "receipt",
      userId: f.user.id,
    });

    const [covered] = await listProjectSignals(db, [f.project.id]);
    assert.equal(covered?.shortLines, 0);
  });

  test("measures the newest BOM only", async () => {
    const f = await makeFixtures(db);

    // Two pieces on the shelf: enough for Rev B, nowhere near Rev A.
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 2,
      reason: "receipt",
      userId: f.user.id,
    });

    const [oldBom] = await db
      .insert(boms)
      .values({
        projectId: f.project.id,
        name: "Rev A",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning();
    await db.insert(bomLines).values({
      bomId: oldBom.id,
      componentId: f.component.id,
      qtyNeeded: 500,
    });

    const [asOfRevA] = await listProjectSignals(db, [f.project.id]);
    assert.equal(asOfRevA?.shortLines, 1);

    const [newBom] = await db
      .insert(boms)
      .values({
        projectId: f.project.id,
        name: "Rev B",
        createdAt: new Date("2026-06-01T00:00:00Z"),
      })
      .returning();
    await db.insert(bomLines).values({
      bomId: newBom.id,
      componentId: f.component.id,
      qtyNeeded: 1,
    });

    const [signal] = await listProjectSignals(db, [f.project.id]);
    assert.equal(
      signal?.shortLines,
      0,
      "Rev B asks for one and one is there — Rev A is history",
    );
  });

  test("counts an overdue order, and returns a row per project asked for", async () => {
    const a = await makeFixtures(db);
    const b = await makeFixtures(db);

    await db.insert(orders).values({
      projectId: a.project.id,
      channel: "online",
      status: "ordered",
      expectedDate: new Date("2020-01-01T00:00:00Z"),
      createdBy: a.user.id,
    });

    const rows = await listProjectSignals(db, [a.project.id, b.project.id]);
    assert.equal(rows.length, 2);

    const forA = rows.find((row) => row.projectId === a.project.id);
    const forB = rows.find((row) => row.projectId === b.project.id);

    assert.equal(forA?.overdueOrders, 1);
    assert.equal(forA?.openOrders, 1);
    assert.equal(forB?.overdueOrders, 0);
    assert.equal(forB?.openOrders, 0);
  });

  test("an empty project list is an empty answer, not every project", async () => {
    assert.deepEqual(await listProjectSignals(db, []), []);
  });
});

describe("order visibility", () => {
  test("a head reads their own project's orders and nobody else's", () => {
    const head = sessionUser({ leadProjectIds: ["p1"] });

    assert.equal(canViewOrder(head, "p1"), true);
    assert.equal(canViewOrder(head, "p2"), false);
  });

  test("an order on the general shelf has no head, so it stays with admins", () => {
    const head = sessionUser({ leadProjectIds: ["p1"] });
    const admin = sessionUser({ role: "admin" });

    // A null project must never read as "anyone may see this".
    assert.equal(canViewOrder(head, null), false);
    assert.equal(canViewOrder(admin, null), true);
  });

  test("an engineer sees no orders even for a project they work on", () => {
    const engineer = sessionUser({ role: "engineer" });
    assert.equal(canViewOrder(engineer, "p1"), false);
  });

  test("listOrders scoped to a project list returns only those orders", async () => {
    const mine = await makeFixtures(db);
    const theirs = await makeFixtures(db);

    for (const fixture of [mine, theirs]) {
      const [order] = await db
        .insert(orders)
        .values({
          projectId: fixture.project.id,
          channel: "online",
          status: "ordered",
          createdBy: fixture.user.id,
        })
        .returning();
      await db.insert(orderLines).values({
        orderId: order.id,
        componentId: fixture.component.id,
        qty: 2,
      });
    }

    // The general shelf: no project, so no head.
    await db.insert(orders).values({
      channel: "offline",
      status: "shelved",
      createdBy: mine.user.id,
    });

    const scoped = await listOrders(db, {
      scope: { projectIds: [mine.project.id] },
    });

    assert.ok(scoped.length > 0);
    assert.ok(
      scoped.every((order) => order.projectId === mine.project.id),
      "no other project's orders, and nothing off the general shelf",
    );

    const unscoped = await listOrders(db, {});
    assert.ok(unscoped.length > scoped.length);
  });

  test("a head with no projects sees nothing rather than everything", async () => {
    const scoped = await listOrders(db, { scope: { projectIds: [] } });
    assert.deepEqual(scoped, []);
  });
});

describe("project details", () => {
  test("description and repository link come back off the project row", async () => {
    const f = await makeFixtures(db);

    await db
      .update(projects)
      .set({
        description: "Soil sensor for the greenhouse trial.",
        repoUrl: "https://github.com/autonex/soil-sensor",
      })
      .where(eq(projects.id, f.project.id));

    const project = await getProject(db, f.project.id);

    assert.equal(project?.description, "Soil sensor for the greenhouse trial.");
    assert.equal(project?.repoUrl, "https://github.com/autonex/soil-sensor");
  });

  test("a project nobody has described reads as null, not as an empty string", async () => {
    const f = await makeFixtures(db);
    const project = await getProject(db, f.project.id);

    assert.equal(project?.description, null);
    assert.equal(project?.repoUrl, null);
    assert.equal(project?.readmeUrl, null);
  });

  test("the documentation link is its own column, not derived from the repo", async () => {
    const f = await makeFixtures(db);

    // A monorepo's README is rarely at the repo root and a private repo will
    // refuse the reader outright, so the link somebody set is the only one the
    // record may claim as this project's documentation.
    await db
      .update(projects)
      .set({
        repoUrl: "https://github.com/autonex/fleet",
        readmeUrl: "https://github.com/autonex/fleet/blob/main/soil/README.md",
      })
      .where(eq(projects.id, f.project.id));

    const project = await getProject(db, f.project.id);

    assert.equal(project?.repoUrl, "https://github.com/autonex/fleet");
    assert.equal(
      project?.readmeUrl,
      "https://github.com/autonex/fleet/blob/main/soil/README.md",
    );
  });

  test("a repo with no documentation link leaves readmeUrl null", async () => {
    const f = await makeFixtures(db);

    await db
      .update(projects)
      .set({ repoUrl: "https://github.com/autonex/soil-sensor" })
      .where(eq(projects.id, f.project.id));

    const project = await getProject(db, f.project.id);

    // The panel offers GitHub's own #readme anchor in this case, but it is
    // offered as a guess and never written to the row.
    assert.equal(project?.readmeUrl, null);
  });
});
