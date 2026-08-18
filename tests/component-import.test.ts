import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { findCatalogueClashes } from "../src/db/queries/components";
import { parseComponents } from "../src/lib/component-import";
import { createTestDb, makeFixtures, type TestDb } from "./harness";

/**
 * The catalogue import — the spec's "simple CSV import for components".
 *
 * The rule under test throughout is that the importer reads what the file says
 * and nothing else: an unnamed column is not guessed at, a missing name is not
 * invented, and a part the catalogue already holds is reported rather than
 * duplicated.
 */

describe("reading a catalogue file", () => {
  test("maps columns off the heading row", () => {
    const result = parseComponents(
      [
        "Name,MPN,Manufacturer,Category,Search terms,Product URL,Datasheet",
        "ESP32 DevKit v1,ESP32-DEVKITC-32D,Espressif,Dev board,esp32 esp 32 wifi,https://robu.in/p/esp32,https://example.com/esp32.pdf",
      ].join("\n"),
    );

    assert.equal(result.headerSkipped, true);
    assert.equal(result.rows.length, 1);

    const row = result.rows[0];
    assert.equal(row.name, "ESP32 DevKit v1");
    assert.equal(row.mpn, "ESP32-DEVKITC-32D");
    assert.equal(row.manufacturer, "Espressif");
    assert.equal(row.category, "Dev board");
    assert.equal(row.searchTerms, "esp32 esp 32 wifi");
    assert.equal(row.productUrl, "https://robu.in/p/esp32");
    assert.equal(row.datasheetUrl, "https://example.com/esp32.pdf");
    assert.deepEqual(row.problems, []);
  });

  test("a part-number heading is not read as a name", () => {
    // "partnumber" contains "part", which the name pattern also matches — the
    // specific heading has to win or every MPN column lands in the name field.
    const result = parseComponents(
      ["Part Number,Description", "TCRT5000,IR proximity sensor"].join("\n"),
    );

    assert.equal(result.rows[0].mpn, "TCRT5000");
    assert.equal(result.rows[0].name, "IR proximity sensor");
  });

  test("a datasheet column is not read as the product link", () => {
    const result = parseComponents(
      [
        "Name,Datasheet URL,Buy link",
        "BME280,https://example.com/bme280.pdf,https://robu.in/p/bme280",
      ].join("\n"),
    );

    assert.equal(result.rows[0].datasheetUrl, "https://example.com/bme280.pdf");
    assert.equal(result.rows[0].productUrl, "https://robu.in/p/bme280");
  });

  test("a comma inside a quoted name survives", () => {
    const result = parseComponents(
      ['Name,MPN', '"Resistor, 10k 1%",CFR-25JB-52-10K'].join("\n"),
    );

    assert.equal(result.rows[0].name, "Resistor, 10k 1%");
    assert.equal(result.rows[0].mpn, "CFR-25JB-52-10K");
  });

  test("a tab-separated paste reads the same as a CSV", () => {
    const result = parseComponents(
      ["Name\tMPN\tCategory", "ESP32 DevKit\tESP32-X\tDev board"].join("\n"),
    );

    assert.equal(result.delimiter, "tab");
    assert.equal(result.rows[0].mpn, "ESP32-X");
    assert.equal(result.rows[0].category, "Dev board");
  });

  test("with no heading row, only the name is read and the row says so", () => {
    const result = parseComponents(
      ["ESP32 DevKit v1,Espressif,4", "BME280 sensor,Bosch,2"].join("\n"),
    );

    assert.equal(result.headerSkipped, false);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].name, "ESP32 DevKit v1");

    // Espressif is not assigned to a field by position — that would fill the
    // catalogue with values nobody typed.
    assert.equal(result.rows[0].manufacturer, null);
    assert.match(result.rows[0].problems.join(" "), /heading row/);
  });

  test("a bare list of names needs no heading row and carries no complaint", () => {
    const result = parseComponents("ESP32 DevKit v1\nBME280 sensor\nTCRT5000");

    assert.equal(result.rows.length, 3);
    assert.deepEqual(
      result.rows.map((r) => r.name),
      ["ESP32 DevKit v1", "BME280 sensor", "TCRT5000"],
    );
    assert.deepEqual(result.rows[0].problems, []);
  });

  test("a missing name is null and blocking, never invented", () => {
    const result = parseComponents(
      ["Name,MPN", ",TCRT5000", "BME280,BME280"].join("\n"),
    );

    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].name, null);
    assert.equal(result.rows[0].mpn, "TCRT5000");
    assert.match(result.rows[0].problems.join(" "), /No name in the file/);
  });

  test("a row with nothing identifying on it is dropped, not imported blank", () => {
    const result = parseComponents(
      ["Name,MPN", "ESP32,ESP32-X", ",", "Total,3"].join("\n"),
    );

    assert.deepEqual(
      result.rows.map((r) => r.name),
      ["ESP32", "Total"],
    );
    assert.equal(result.droppedLines, 1);
  });

  test("something that is not a web address is dropped with a reason", () => {
    const result = parseComponents(
      ["Name,Product URL", "ESP32,ask Rahul"].join("\n"),
    );

    assert.equal(result.rows[0].productUrl, null);
    assert.match(result.rows[0].problems.join(" "), /not a web address/);
  });

  test("a bare domain is accepted as https", () => {
    const result = parseComponents(
      ["Name,Product URL", "ESP32,robu.in/product/esp32"].join("\n"),
    );

    assert.equal(result.rows[0].productUrl, "https://robu.in/product/esp32");
    assert.deepEqual(result.rows[0].problems, []);
  });

  test("the same part number twice in one file is flagged", () => {
    const result = parseComponents(
      [
        "Name,MPN",
        "ESP32 DevKit,ESP32-DEVKITC-32D",
        "ESP32 board,esp32 devkitc 32d",
      ].join("\n"),
    );

    // Squashed the same way the catalogue's unique index squashes it, so the
    // reviewer hears about it here rather than from a constraint violation.
    assert.match(result.rows[1].problems.join(" "), /row 2 of this file/);
  });

  test("a heading nobody recognises is reported, never silently dropped", () => {
    const result = parseComponents(
      ["Name,MPN,Shelf,Reorder point", "ESP32,ESP32-X,A3,5"].join("\n"),
    );

    assert.deepEqual(result.unmappedHeadings, ["Shelf", "Reorder point"]);
    assert.ok(result.mappedFields.includes("name"));
    assert.ok(result.mappedFields.includes("mpn"));
  });

  test("empty input is empty, not an error", () => {
    const result = parseComponents("   \n\n  ");
    assert.deepEqual(result.rows, []);
    assert.equal(result.droppedLines, 0);
  });
});

describe("what the catalogue already holds", () => {
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

  test("recognises a part number however it is punctuated", async () => {
    const f = await makeFixtures(db, {
      componentName: "STM32 Blue Pill",
      mpn: "STM32F103C8T6",
    });

    const clashes = await findCatalogueClashes(db, {
      mpns: ["stm32-f103-c8t6"],
      names: [],
    });

    assert.equal(clashes.length, 1);
    assert.equal(clashes[0].componentId, f.component.id);
    assert.equal(clashes[0].via, "mpn");
  });

  test("recognises the same name, and only the same name", async () => {
    const f = await makeFixtures(db, { componentName: "Jumper Wire Set 40pin" });

    const exact = await findCatalogueClashes(db, {
      mpns: [],
      names: ["jumper wire set 40 pin"],
    });
    assert.equal(exact.length, 1);
    assert.equal(exact[0].componentId, f.component.id);
    assert.equal(exact[0].via, "name");

    // A merely similar name is a different part far more often than not, and
    // warning about those trains the reviewer to tick past every warning.
    const similar = await findCatalogueClashes(db, {
      mpns: [],
      names: ["Jumper wire set 20pin"],
    });
    assert.deepEqual(similar, []);
  });

  test("says nothing about a part the catalogue does not hold", async () => {
    await makeFixtures(db);

    const clashes = await findCatalogueClashes(db, {
      mpns: ["NOTHING-LIKE-THIS"],
      names: ["A part nobody catalogued"],
    });

    assert.deepEqual(clashes, []);
  });
});
