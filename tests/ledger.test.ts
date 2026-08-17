import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { eq } from "drizzle-orm";

import { rowsOf } from "../src/db/rows";
import { stockMovements } from "../src/db/schema";
import {
  LedgerError,
  adjustToCount,
  getOnHand,
  issueStock,
  recordMovement,
  reverseMovement,
} from "../src/lib/ledger";
import { createTestDb, errorText, makeFixtures, type TestDb } from "./harness";

/**
 * These tests exist to defend one sentence from the spec:
 *
 *   "Any code that does UPDATE components SET quantity = ... is a bug."
 *
 * They assert that the database itself makes the ledger's guarantees, so the
 * guarantees survive code nobody has written yet.
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

describe("derived quantity", () => {
  test("on-hand is the sum of the ledger, never a stored column", async () => {
    const f = await makeFixtures(db);

    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 0);

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 10,
      reason: "receipt",
      userId: f.user.id,
    });
    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 10);

    await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 3,
      userId: f.user.id,
    });
    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 7);

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 1,
      reason: "return",
      userId: f.user.id,
    });
    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 8);
  });

  test("there is no quantity column on components", async () => {
    const result = await db.execute(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'components'`,
    );
    const names = rowsOf<{ column_name: string }>(result).map(
      (r) => r.column_name,
    );
    for (const forbidden of ["quantity", "qty", "stock", "on_hand"]) {
      assert.ok(
        !names.includes(forbidden),
        `components must not have a '${forbidden}' column`,
      );
    }
  });

  test("stock is location-scoped, not global", async () => {
    const f = await makeFixtures(db);
    const [otherCupboard] = await db
      .insert((await import("../src/db/schema")).locations)
      .values({ name: "Cupboard Kestrel", type: "cupboard" })
      .returning();

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 4,
      reason: "receipt",
      userId: f.user.id,
    });
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: otherCupboard.id,
      qtyDelta: 10,
      reason: "receipt",
      userId: f.user.id,
    });

    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 4);
    assert.equal(await getOnHand(db, f.component.id, otherCupboard.id), 10);
  });
});

describe("the ledger is append-only", () => {
  test("UPDATE on stock_movements is refused by the database", async () => {
    const f = await makeFixtures(db);
    const movement = await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 5,
      reason: "receipt",
      userId: f.user.id,
    });

    await assert.rejects(
      () =>
        db
          .update(stockMovements)
          .set({ qtyDelta: 999 })
          .where(eq(stockMovements.id, movement.id)),
      (e: unknown) => /append-only/i.test(errorText(e)),
    );

    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 5);
  });

  test("DELETE on stock_movements is refused by the database", async () => {
    const f = await makeFixtures(db);
    const movement = await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 5,
      reason: "receipt",
      userId: f.user.id,
    });

    await assert.rejects(
      () => db.delete(stockMovements).where(eq(stockMovements.id, movement.id)),
      (e: unknown) => /append-only/i.test(errorText(e)),
    );

    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 5);
  });

  test("a zero-quantity movement is rejected", async () => {
    const f = await makeFixtures(db);
    await assert.rejects(
      () =>
        recordMovement(db, {
          componentId: f.component.id,
          locationId: f.shelf.id,
          qtyDelta: 0,
          reason: "adjustment",
          userId: f.user.id,
        }),
      (e: unknown) => e instanceof LedgerError && e.code === "ZERO_DELTA",
    );
  });

  test("a receipt cannot remove stock and an issue cannot add it", async () => {
    const f = await makeFixtures(db);

    await assert.rejects(
      () =>
        recordMovement(db, {
          componentId: f.component.id,
          locationId: f.shelf.id,
          qtyDelta: -5,
          reason: "receipt",
          userId: f.user.id,
        }),
      (e: unknown) => e instanceof LedgerError && e.code === "WRONG_DIRECTION",
    );

    await assert.rejects(
      () =>
        recordMovement(db, {
          componentId: f.component.id,
          locationId: f.shelf.id,
          qtyDelta: 5,
          reason: "issue",
          userId: f.user.id,
        }),
      (e: unknown) => e instanceof LedgerError && e.code === "WRONG_DIRECTION",
    );
  });
});

describe("taking parts out", () => {
  test("cannot take more than is at that location, and says how many there are", async () => {
    const f = await makeFixtures(db);
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 3,
      reason: "receipt",
      userId: f.user.id,
    });

    await assert.rejects(
      () =>
        issueStock(db, {
          componentId: f.component.id,
          locationId: f.shelf.id,
          qty: 4,
          userId: f.user.id,
        }),
      (e: unknown) =>
        e instanceof LedgerError &&
        e.code === "INSUFFICIENT_STOCK" &&
        e.available === 3 &&
        /Only 3 left/.test(e.message),
    );

    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 3);
  });

  test("zero and negative quantities are rejected", async () => {
    const f = await makeFixtures(db);
    for (const qty of [0, -1, 1.5]) {
      await assert.rejects(
        () =>
          issueStock(db, {
            componentId: f.component.id,
            locationId: f.shelf.id,
            qty,
            userId: f.user.id,
          }),
        (e: unknown) => e instanceof LedgerError,
        `qty ${qty} should be rejected`,
      );
    }
  });

  test("taking exactly the last unit is allowed", async () => {
    const f = await makeFixtures(db);
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 2,
      reason: "receipt",
      userId: f.user.id,
    });
    await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 2,
      userId: f.user.id,
    });
    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 0);
  });
});

describe("correcting a miscount", () => {
  test("adjusting to a higher count records the difference, not the total", async () => {
    const f = await makeFixtures(db);
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 5,
      reason: "receipt",
      userId: f.user.id,
    });

    const movement = await adjustToCount(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      targetCount: 8,
      userId: f.user.id,
      note: "Recount",
    });

    assert.equal(movement.qtyDelta, 3, "should record +3, not 8");
    assert.equal(movement.reason, "adjustment");
    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 8);
  });

  test("adjusting to a lower count records a negative difference", async () => {
    const f = await makeFixtures(db);
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 10,
      reason: "receipt",
      userId: f.user.id,
    });

    const movement = await adjustToCount(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      targetCount: 4,
      userId: f.user.id,
      note: "Two were broken, four unaccounted for",
    });

    assert.equal(movement.qtyDelta, -6);
    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 4);
  });

  test("adjusting to zero empties the location", async () => {
    const f = await makeFixtures(db);
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 7,
      reason: "receipt",
      userId: f.user.id,
    });

    await adjustToCount(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      targetCount: 0,
      userId: f.user.id,
      note: "Bin is empty",
    });

    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 0);
  });

  test("adjusting to the count it already has is rejected", async () => {
    const f = await makeFixtures(db);
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 5,
      reason: "receipt",
      userId: f.user.id,
    });

    await assert.rejects(
      () =>
        adjustToCount(db, {
          componentId: f.component.id,
          locationId: f.shelf.id,
          targetCount: 5,
          userId: f.user.id,
          note: "No change",
        }),
      (e: unknown) =>
        e instanceof LedgerError &&
        e.code === "ZERO_DELTA" &&
        /already 5/.test(e.message),
    );
  });

  test("a negative or fractional target is rejected", async () => {
    const f = await makeFixtures(db);
    for (const targetCount of [-1, 2.5]) {
      await assert.rejects(
        () =>
          adjustToCount(db, {
            componentId: f.component.id,
            locationId: f.shelf.id,
            targetCount,
            userId: f.user.id,
            note: "Bad input",
          }),
        (e: unknown) => e instanceof LedgerError,
        `target ${targetCount} should be rejected`,
      );
    }
  });

  test("a correction can itself be undone", async () => {
    const f = await makeFixtures(db);
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 5,
      reason: "receipt",
      userId: f.user.id,
    });

    const correction = await adjustToCount(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      targetCount: 9,
      userId: f.user.id,
      note: "Miscounted",
    });

    await reverseMovement(db, correction.id, f.user.id);
    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 5);
  });
});

describe("undo", () => {
  test("undo appends a reversal and leaves the original row intact", async () => {
    const f = await makeFixtures(db);
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 10,
      reason: "receipt",
      userId: f.user.id,
    });
    const issue = await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 4,
      userId: f.user.id,
    });
    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 6);

    const reversal = await reverseMovement(db, issue.id, f.user.id);

    assert.equal(reversal.reason, "reversal");
    assert.equal(reversal.qtyDelta, 4);
    assert.equal(reversal.reversesMovementId, issue.id);
    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 10);

    const [stillThere] = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.id, issue.id));
    assert.equal(stillThere.qtyDelta, -4, "original must not be modified");
  });

  test("a movement cannot be undone twice", async () => {
    const f = await makeFixtures(db);
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 10,
      reason: "receipt",
      userId: f.user.id,
    });
    const issue = await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 2,
      userId: f.user.id,
    });

    await reverseMovement(db, issue.id, f.user.id);
    await assert.rejects(
      () => reverseMovement(db, issue.id, f.user.id),
      (e: unknown) => e instanceof LedgerError && e.code === "ALREADY_REVERSED",
    );

    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 10);
  });

  test("the database blocks a double undo even if the application check is bypassed", async () => {
    const f = await makeFixtures(db);
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 10,
      reason: "receipt",
      userId: f.user.id,
    });
    const issue = await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 2,
      userId: f.user.id,
    });
    await reverseMovement(db, issue.id, f.user.id);

    // Deliberately going around recordMovement, the way a careless future
    // feature might. The unique index has to catch it.
    await assert.rejects(() =>
      db.insert(stockMovements).values({
        componentId: f.component.id,
        locationId: f.shelf.id,
        qtyDelta: 2,
        reason: "reversal",
        userId: f.user.id,
        reversesMovementId: issue.id,
      }),
    );
  });

  test("a reversal carrying the wrong delta is refused by the database", async () => {
    const f = await makeFixtures(db);
    const receipt = await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 10,
      reason: "receipt",
      userId: f.user.id,
    });

    await assert.rejects(
      () =>
        db.insert(stockMovements).values({
          componentId: f.component.id,
          locationId: f.shelf.id,
          qtyDelta: -3, // should be -10
          reason: "reversal",
          userId: f.user.id,
          reversesMovementId: receipt.id,
        }),
      (e: unknown) => /inverse/i.test(errorText(e)),
    );
  });

  test("a reversal cannot itself be reversed", async () => {
    const f = await makeFixtures(db);
    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 10,
      reason: "receipt",
      userId: f.user.id,
    });
    const issue = await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 2,
      userId: f.user.id,
    });
    const reversal = await reverseMovement(db, issue.id, f.user.id);

    await assert.rejects(
      () => reverseMovement(db, reversal.id, f.user.id),
      (e: unknown) => e instanceof LedgerError && e.code === "NOT_REVERSIBLE",
    );
  });

  test("undoing a receipt is refused when the parts have already gone out", async () => {
    const f = await makeFixtures(db);
    const receipt = await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 10,
      reason: "receipt",
      userId: f.user.id,
    });
    await issueStock(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qty: 8,
      userId: f.user.id,
    });

    await assert.rejects(
      () => reverseMovement(db, receipt.id, f.user.id),
      (e: unknown) =>
        e instanceof LedgerError && e.code === "INSUFFICIENT_STOCK",
    );

    assert.equal(await getOnHand(db, f.component.id, f.shelf.id), 2);
  });

  test("a non-reversal may not point at another movement, and a reversal must", async () => {
    const f = await makeFixtures(db);
    const receipt = await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 5,
      reason: "receipt",
      userId: f.user.id,
    });

    await assert.rejects(() =>
      db.insert(stockMovements).values({
        componentId: f.component.id,
        locationId: f.shelf.id,
        qtyDelta: -5,
        reason: "adjustment",
        userId: f.user.id,
        reversesMovementId: receipt.id,
      }),
    );

    await assert.rejects(() =>
      db.insert(stockMovements).values({
        componentId: f.component.id,
        locationId: f.shelf.id,
        qtyDelta: -5,
        reason: "reversal",
        userId: f.user.id,
        reversesMovementId: null,
      }),
    );
  });
});
