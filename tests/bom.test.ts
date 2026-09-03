import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";

import {
  bomLines,
  boms,
  components,
  locations,
  orderLines,
  orders,
  projects,
  users,
} from "../src/db/schema";
import { getBomShortfall, listProjectBoms } from "../src/db/queries/bom";
import { parseBom, readQuantity } from "../src/lib/bom-parse";
import { matchBomRows } from "../src/lib/bom-match";
import { readTable } from "../src/lib/table-parse";
import { recordMovement } from "../src/lib/ledger";
import { createTestDb, errorText, type TestDb } from "./harness";

/**
 * BOM import and shortfall.
 *
 * Two things are worth defending here. The parser must never invent a quantity
 * — the spec's review screen exists precisely so a person supplies what could
 * not be read — and the shortfall must stay scoped to the project's own
 * cupboards, because the lab's policy is that two projects needing the same
 * part buy it twice.
 */

let db: TestDb;
let client: { close: () => Promise<void> };

const ids: Record<string, string> = {};

before(async () => {
  const created = await createTestDb();
  db = created.db;
  client = created.client;

  const [admin] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      googleSub: "bom-admin",
      email: "bom-admin@autonexai360.com",
      name: "BOM Admin",
      role: "admin",
    })
    .returning();
  ids.admin = admin.id;

  const [falcon] = await db
    .insert(projects)
    .values({ name: "Falcon", code: "BOMFAL" })
    .returning();
  const [kestrel] = await db
    .insert(projects)
    .values({ name: "Kestrel", code: "BOMKES" })
    .returning();
  ids.falcon = falcon.id;
  ids.kestrel = kestrel.id;

  const [cupFalcon] = await db
    .insert(locations)
    .values({
      name: "Cupboard-BomFalcon",
      type: "cupboard",
      projectId: falcon.id,
    })
    .returning();
  const [shelfFalcon] = await db
    .insert(locations)
    .values({ name: "Shelf F1", type: "shelf", parentId: cupFalcon.id })
    .returning();
  const [cupKestrel] = await db
    .insert(locations)
    .values({
      name: "Cupboard-BomKestrel",
      type: "cupboard",
      projectId: kestrel.id,
    })
    .returning();

  ids.cupFalcon = cupFalcon.id;
  ids.shelfFalcon = shelfFalcon.id;
  ids.cupKestrel = cupKestrel.id;

  const [esp] = await db
    .insert(components)
    .values({
      name: "ESP32 DevKit v1",
      mpn: "ESP32-DEVKITC-32D",
      searchTerms: "esp32 wifi devkit microcontroller",
      createdBy: admin.id,
    })
    .returning();
  const [resistor] = await db
    .insert(components)
    .values({
      name: "Resistor 10k 1%",
      mpn: "CFR-25JB-52-10K",
      createdBy: admin.id,
    })
    .returning();
  const [motor] = await db
    .insert(components)
    .values({ name: "Motor Driver L298N", mpn: null, createdBy: admin.id })
    .returning();

  ids.esp = esp.id;
  ids.resistor = resistor.id;
  ids.motor = motor.id;
});

after(async () => {
  await client.close();
});

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

describe("reading a BOM", () => {
  test("reads a comma CSV with headings", () => {
    const result = parseBom(
      [
        "Part,MPN,Qty",
        "ESP32 DevKit v1,ESP32-DEVKITC-32D,4",
        "Resistor 10k 1%,CFR-25JB-52-10K,50",
      ].join("\n"),
    );

    assert.equal(result.delimiter, "comma");
    assert.equal(result.headerSkipped, true);
    assert.equal(result.rows.length, 2);
    // The MPN column identifies exactly; the name comes along as a fallback.
    assert.equal(result.rows[0].identifier, "ESP32-DEVKITC-32D");
    assert.equal(result.rows[0].secondary, "ESP32 DevKit v1");
    assert.equal(result.rows[0].qty, 4);
    assert.equal(result.rows[1].qty, 50);
  });

  test("reads a table pasted out of a spreadsheet", () => {
    const result = parseBom("Part\tQty\nESP32 DevKit v1\t4\nJumper set\t2");

    assert.equal(result.delimiter, "tab");
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].identifier, "ESP32 DevKit v1");
    assert.equal(result.rows[0].qty, 4);
  });

  test("a comma inside a quoted part name does not split the row", () => {
    const result = parseBom('Part,Qty\n"Resistor, 10k 1%",50');

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].identifier, "Resistor, 10k 1%");
    assert.equal(result.rows[0].qty, 50);
  });

  test("a description full of commas does not beat the real delimiter", () => {
    // Frequency alone would pick the comma here; consistency picks the tab.
    const result = parseBom(
      [
        "Part\tQty",
        "Sensor, temperature, humidity, I2C\t3",
        "Cable, ribbon, 10-way, 1m\t5",
      ].join("\n"),
    );

    assert.equal(result.delimiter, "tab");
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].qty, 3);
    assert.equal(result.rows[1].qty, 5);
  });

  test("reads a semicolon export", () => {
    const result = parseBom("Component;Quantity\nESP32;4\nResistor 10k;100");

    assert.equal(result.delimiter, "semicolon");
    assert.equal(result.rows[1].qty, 100);
  });

  test("a quantity that cannot be read is null, never a guess", () => {
    const result = parseBom("Part,Qty\nESP32 DevKit,as required\nResistor,2.5");

    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].qty, null);
    assert.match(result.rows[0].note ?? "", /as required/);

    // A fraction is a mistake worth surfacing, not something to round.
    assert.equal(result.rows[1].qty, null);
    assert.match(result.rows[1].note ?? "", /2\.5/);
  });

  test("rows with no part on them are dropped, not imported blank", () => {
    const result = parseBom(
      ["Part,Qty", "ESP32 DevKit,4", "TOTAL,4", "12,7"].join("\n"),
    );

    // "TOTAL" is text and survives; a row identified only by a number does not.
    assert.equal(result.rows.length, 2);
    assert.equal(result.droppedLines, 1);
    assert.ok(!result.rows.some((row) => row.identifier === "12"));
  });

  test("a blank MPN falls back to the name rather than losing the part", () => {
    // Half a lab's parts are bought by description and have no MPN at all. The
    // MPN column leading must not mean a row that left it empty disappears.
    const result = parseBom(
      [
        "Part,MPN,Qty",
        "ESP32 DevKit v1,ESP32-DEVKITC-32D,4",
        "Jumper wire set 40pin,,2",
      ].join("\n"),
    );

    assert.equal(result.droppedLines, 0);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[1].identifier, "Jumper wire set 40pin");
    assert.equal(result.rows[1].secondary, null);
    assert.equal(result.rows[1].qty, 2);
  });

  test("the shipped template reads the same as a file and as a paste", () => {
    const csv = readFileSync(
      new URL("../public/bom-template.csv", import.meta.url),
      "utf8",
    );
    // Excel's clipboard is the same cells, tab-separated.
    const pasted = readTable(csv)
      .table.map((cells) => cells.join("\t"))
      .join("\n");

    for (const [route, result] of [
      ["file", parseBom(csv)],
      ["paste", parseBom(pasted)],
    ] as const) {
      assert.equal(result.headerSkipped, true, route);
      assert.equal(result.droppedLines, 0, route);
      assert.equal(result.rows.length, 3, route);
      // Every example row is complete: nothing in the template asks the
      // reviewer to finish a quantity the template itself left blank.
      assert.ok(
        result.rows.every((row) => row.qty !== null && row.note === null),
        route,
      );
      // A quoted part name survives both routes as one cell.
      assert.equal(result.rows[1].secondary, "Resistor, 10k 1% 0805", route);
      // And the row with no MPN is identified by its name.
      assert.equal(result.rows[2].identifier, "Jumper wire set 40pin", route);
    }
  });

  test("a table with no heading row is read by shape", () => {
    const result = parseBom("ESP32 DevKit v1,4\nResistor 10k,50");

    assert.equal(result.headerSkipped, false);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].identifier, "ESP32 DevKit v1");
    assert.equal(result.rows[0].qty, 4);
  });

  test("quantities people actually type", () => {
    assert.equal(readQuantity("12"), 12);
    assert.equal(readQuantity("12 pcs"), 12);
    assert.equal(readQuantity("1,200"), 1200);
    assert.equal(readQuantity("x4"), 4);
    assert.equal(readQuantity("2 nos"), 2);

    assert.equal(readQuantity("2.5"), null);
    assert.equal(readQuantity("0"), null);
    assert.equal(readQuantity("-3"), null);
    assert.equal(readQuantity("some"), null);
  });
});

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

describe("matching rows to the catalogue", () => {
  test("an MPN wins, and normalisation makes the separators irrelevant", async () => {
    const rows = parseBom("Part,Qty\nESP32-DEVKITC 32D,4").rows;
    const matched = await matchBomRows(db, rows);

    assert.equal(matched.length, 1);
    assert.equal(matched[0].suggestedComponentId, ids.esp);
    assert.equal(matched[0].matches[0].via, "mpn");
  });

  test("a name match is offered and pre-selected when it is literal", async () => {
    const rows = parseBom("Part,Qty\nMotor Driver L298N,2").rows;
    const matched = await matchBomRows(db, rows);

    assert.equal(matched[0].matches[0].componentId, ids.motor);
    assert.equal(matched[0].matches[0].via, "name");
    assert.equal(matched[0].suggestedComponentId, ids.motor);
  });

  test("nothing recognisable is left unanswered rather than guessed at", async () => {
    const rows = parseBom("Part,Qty\nWaveshare e-paper 7.5in,1").rows;
    const matched = await matchBomRows(db, rows);

    assert.equal(matched[0].suggestedComponentId, null);
  });
});

/* -------------------------------------------------------------------------- */
/* Shortfall                                                                   */
/* -------------------------------------------------------------------------- */

describe("the shortfall table", () => {
  test("needed minus what is in this project's own cupboards", async () => {
    const [bom] = await db
      .insert(boms)
      .values({ projectId: ids.falcon, name: "Falcon v1", uploadedBy: ids.admin })
      .returning();

    await db.insert(bomLines).values([
      { bomId: bom.id, componentId: ids.esp, qtyNeeded: 10 },
      { bomId: bom.id, componentId: ids.resistor, qtyNeeded: 4 },
    ]);

    // Four on a shelf inside Falcon's cupboard — inherited project, not a
    // direct project_id, which is the case a naive query gets wrong.
    await recordMovement(db, {
      componentId: ids.esp,
      locationId: ids.shelfFalcon,
      qtyDelta: 4,
      reason: "receipt",
      userId: ids.admin,
    });

    // Plenty of the same part next door. It must not count.
    await recordMovement(db, {
      componentId: ids.esp,
      locationId: ids.cupKestrel,
      qtyDelta: 99,
      reason: "receipt",
      userId: ids.admin,
    });

    await recordMovement(db, {
      componentId: ids.resistor,
      locationId: ids.cupFalcon,
      qtyDelta: 6,
      reason: "receipt",
      userId: ids.admin,
    });

    const shortfall = await getBomShortfall(db, bom.id);
    assert.ok(shortfall);

    const esp = shortfall.lines.find((line) => line.componentId === ids.esp);
    assert.equal(esp?.needed, 10);
    assert.equal(esp?.inProject, 4, "Kestrel's stock must not be counted");
    assert.equal(esp?.toBuy, 6);

    const resistor = shortfall.lines.find(
      (line) => line.componentId === ids.resistor,
    );
    assert.equal(resistor?.inProject, 6);
    assert.equal(resistor?.toBuy, 0, "a covered line is not negative");

    assert.equal(shortfall.totals.shortLines, 1);
    assert.equal(shortfall.totals.piecesToBuy, 6);

    ids.falconBom = bom.id;
  });

  test("an open order shows as on order without filling the gap", async () => {
    const [order] = await db
      .insert(orders)
      .values({
        projectId: ids.falcon,
        channel: "online",
        status: "ordered",
        createdBy: ids.admin,
      })
      .returning();

    const [line] = await db
      .insert(orderLines)
      .values({ orderId: order.id, componentId: ids.esp, qty: 6 })
      .returning();

    const before = await getBomShortfall(db, ids.falconBom);
    const espBefore = before?.lines.find((l) => l.componentId === ids.esp);

    assert.equal(espBefore?.onOrder, 6);
    assert.equal(
      espBefore?.toBuy,
      6,
      "a box that has not arrived is not stock, so the gap stays open",
    );

    // Putting it away is what closes both.
    await recordMovement(db, {
      componentId: ids.esp,
      locationId: ids.shelfFalcon,
      qtyDelta: 6,
      reason: "receipt",
      userId: ids.admin,
      orderLineId: line.id,
    });

    const after = await getBomShortfall(db, ids.falconBom);
    const espAfter = after?.lines.find((l) => l.componentId === ids.esp);

    assert.equal(espAfter?.onOrder, 0);
    assert.equal(espAfter?.inProject, 10);
    assert.equal(espAfter?.toBuy, 0);
  });

  test("the same part cannot appear twice in one BOM", async () => {
    const [bom] = await db
      .insert(boms)
      .values({ projectId: ids.kestrel, name: "Kestrel v1" })
      .returning();

    await db
      .insert(bomLines)
      .values({ bomId: bom.id, componentId: ids.esp, qtyNeeded: 3 });

    await assert.rejects(
      () =>
        db
          .insert(bomLines)
          .values({ bomId: bom.id, componentId: ids.esp, qtyNeeded: 5 }),
      (error: unknown) =>
        /bom_lines_bom_component_key/.test(errorText(error)),
      "a duplicate line would make 'how many are needed' ambiguous",
    );
  });

  test("a quantity of zero is refused", async () => {
    const [bom] = await db
      .insert(boms)
      .values({ projectId: ids.kestrel, name: "Kestrel v2" })
      .returning();

    await assert.rejects(
      () =>
        db
          .insert(bomLines)
          .values({ bomId: bom.id, componentId: ids.motor, qtyNeeded: 0 }),
      (error: unknown) => /bom_lines_qty_positive/.test(errorText(error)),
    );
  });

  test("uploads accumulate rather than replacing each other", async () => {
    const list = await listProjectBoms(db, ids.kestrel);

    assert.equal(list.length, 2);
    // Newest first: the project page measures against the latest upload.
    assert.equal(list[0].name, "Kestrel v2");
  });
});
