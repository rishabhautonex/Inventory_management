import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { eq } from "drizzle-orm";

import { locations, stockMovements, stockThresholds } from "../src/db/schema";
import { recordMovement, reverseMovement } from "../src/lib/ledger";
import { deleteLocationCascade } from "../src/lib/locations";
import { createTestDb, errorText, makeFixtures, type TestDb } from "./harness";

/**
 * Deleting a location.
 *
 * Retiring is the reversible option and is what a shelf that has been used
 * gets; deleting is for one that should never have existed. The line between
 * them is the whole point of these tests, and it is drawn by the ledger rather
 * than by how full the shelf is right now: a location any movement has ever
 * named cannot be deleted, because every row of the log names a location and a
 * row naming somewhere that is gone cannot be read.
 *
 * The counts matter as much as the refusals. They are what the confirmation
 * states beforehand and what the toast reports afterwards, so a wrong one is a
 * lie told at exactly the moment somebody is deciding.
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

describe("deleting an unused location", () => {
  test("takes the shelves inside it, and says how many went", async () => {
    const f = await makeFixtures(db);

    const result = await deleteLocationCascade(db, f.cupboard.id);

    assert.ok(result.ok);
    assert.equal(result.deleted.name, f.cupboard.name);
    // The cupboard and the shelf in it. `locations.parent_id` is `restrict`,
    // so the shelf has to go first — asking somebody to delete a mistyped
    // cupboard leaf-first would be ceremony.
    assert.equal(result.deleted.deletedLocations, 2);

    assert.deepEqual(
      await db.select().from(locations).where(eq(locations.id, f.cupboard.id)),
      [],
    );
    assert.deepEqual(
      await db.select().from(locations).where(eq(locations.id, f.shelf.id)),
      [],
    );
  });

  test("clears the minimums set on it, and counts them", async () => {
    const f = await makeFixtures(db);

    await db.insert(stockThresholds).values({
      componentId: f.component.id,
      locationId: f.shelf.id,
      minQty: 5,
    });

    const result = await deleteLocationCascade(db, f.cupboard.id);

    assert.ok(result.ok);
    assert.equal(result.deleted.clearedThresholds, 1);

    assert.deepEqual(
      await db
        .select()
        .from(stockThresholds)
        .where(eq(stockThresholds.locationId, f.shelf.id)),
      [],
    );
  });

  test("a location that is already gone refuses rather than throwing", async () => {
    const f = await makeFixtures(db);

    assert.ok((await deleteLocationCascade(db, f.shelf.id)).ok);

    const again = await deleteLocationCascade(db, f.shelf.id);
    assert.equal(again.ok, false);
    assert.equal(again.ok === false && again.reason, "missing");
  });
});

describe("a location the ledger has named", () => {
  test("is refused, and named, and left exactly as it was", async () => {
    const f = await makeFixtures(db);

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 6,
      reason: "receipt",
      userId: f.user.id,
    });

    const result = await deleteLocationCascade(db, f.shelf.id);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "history");
    assert.equal(result.ok === false && result.reason === "history" && result.movements, 1);
    assert.deepEqual(
      result.ok === false && result.reason === "history" ? result.named : [],
      [f.shelf.name],
    );

    const [shelf] = await db
      .select()
      .from(locations)
      .where(eq(locations.id, f.shelf.id));
    assert.ok(shelf, "the shelf is still there to be retired");

    const movements = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.locationId, f.shelf.id));
    assert.equal(movements.length, 1);
  });

  test("stops the cupboard around it going too, and says which shelf", async () => {
    const f = await makeFixtures(db);

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 3,
      reason: "receipt",
      userId: f.user.id,
    });

    // Nothing has ever moved through the cupboard itself. It still cannot go,
    // because taking it would take the shelf that holds the history with it.
    const result = await deleteLocationCascade(db, f.cupboard.id);

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.ok === false && result.reason === "history" ? result.named : [],
      [f.shelf.name],
    );

    const [cupboard] = await db
      .select()
      .from(locations)
      .where(eq(locations.id, f.cupboard.id));
    assert.ok(cupboard);
  });

  test("counts history, not what is on the shelf now", async () => {
    const f = await makeFixtures(db);

    const receipt = await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 4,
      reason: "receipt",
      userId: f.user.id,
    });
    await reverseMovement(db, receipt.id, f.user.id);

    // On hand is back to zero and the shelf looks untouched. The log is not:
    // it holds a receipt and a reversal, both naming this shelf.
    const result = await deleteLocationCascade(db, f.shelf.id);

    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.reason === "history" && result.movements,
      2,
    );
  });

  test("the database refuses it too, by a route that is not this function", async () => {
    const f = await makeFixtures(db);

    await recordMovement(db, {
      componentId: f.component.id,
      locationId: f.shelf.id,
      qtyDelta: 1,
      reason: "receipt",
      userId: f.user.id,
    });

    // `deleteLocationCascade()` refuses first so that somebody is told which
    // shelf and what to do instead. The `restrict` underneath is what makes
    // that a guarantee rather than a guard somebody can forget to call.
    await assert.rejects(
      () => db.delete(locations).where(eq(locations.id, f.shelf.id)),
      (error: unknown) =>
        /stock_movements_location_id_locations_id_fk/.test(errorText(error)),
    );
  });

  test("a parent still cannot be pulled out from under its children", async () => {
    const f = await makeFixtures(db);

    await assert.rejects(
      () => db.delete(locations).where(eq(locations.id, f.cupboard.id)),
      (error: unknown) =>
        /locations_parent_id_locations_id_fk/.test(errorText(error)),
    );
  });
});
