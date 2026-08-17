import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { components, locations, projects, users } from "../src/db/schema";
import { searchComponents } from "../src/db/queries/search";
import { recordMovement } from "../src/lib/ledger";
import { createTestDb, type TestDb } from "./harness";

/**
 * The spec calls fuzzy search a hard requirement and warns that everything
 * depends on getting it right early. These tests pin the phrasings it names
 * explicitly, plus the ranking and location-row behaviour the take-out flow
 * relies on.
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
      googleSub: "search-admin",
      email: "admin@autonexai360.com",
      name: "Admin",
      role: "admin",
    })
    .returning();

  const [falcon] = await db
    .insert(projects)
    .values({ name: "Falcon", code: "FAL" })
    .returning();
  const [kestrel] = await db
    .insert(projects)
    .values({ name: "Kestrel", code: "KES" })
    .returning();

  const [cupFalcon] = await db
    .insert(locations)
    .values({ name: "Cupboard-Falcon", type: "cupboard", projectId: falcon.id })
    .returning();
  const [cupKestrel] = await db
    .insert(locations)
    .values({
      name: "Cupboard-Kestrel",
      type: "cupboard",
      projectId: kestrel.id,
    })
    .returning();
  const [general] = await db
    .insert(locations)
    .values({ name: "General Shelf", type: "general" })
    .returning();

  ids.falcon = cupFalcon.id;
  ids.kestrel = cupKestrel.id;
  ids.general = general.id;

  const catalogue = [
    {
      key: "esp32",
      name: "ESP32 DevKit v1",
      mpn: "ESP32-DEVKITC-32D",
      manufacturer: "Espressif",
      category: "Dev board",
      searchTerms: "esp32 wifi bluetooth microcontroller devkit wroom",
    },
    {
      key: "cctv",
      name: "Hikvision DS-2CD1143G0",
      mpn: "DS-2CD1143G0-I",
      manufacturer: "Hikvision",
      category: "Camera",
      searchTerms:
        "cctv camera surveillance security ip dome poe 4mp outdoor onvif",
    },
    {
      key: "header",
      name: "Male Header 2.54mm 40-pin",
      mpn: "HDR-M-254-40",
      manufacturer: "Generic",
      category: "Connector",
      searchTerms: "header pin strip breadboard jumper 2.54 berg",
    },
    {
      key: "stm32",
      name: "STM32F103C8T6 Blue Pill",
      mpn: "STM32F103C8T6",
      manufacturer: "STMicroelectronics",
      category: "Dev board",
      searchTerms: "stm32 bluepill arm cortex m3 microcontroller",
    },
  ];

  for (const c of catalogue) {
    const [row] = await db
      .insert(components)
      .values({ ...c, createdBy: admin.id })
      .returning();
    ids[c.key] = row.id;
  }

  // ESP32 lives in two cupboards with different counts, which is the exact
  // scenario the spec uses to explain location-scoped stock.
  await recordMovement(db, {
    componentId: ids.esp32,
    locationId: ids.falcon,
    qtyDelta: 4,
    reason: "receipt",
    userId: admin.id,
  });
  await recordMovement(db, {
    componentId: ids.esp32,
    locationId: ids.kestrel,
    qtyDelta: 10,
    reason: "receipt",
    userId: admin.id,
  });
  await recordMovement(db, {
    componentId: ids.header,
    locationId: ids.general,
    qtyDelta: 200,
    reason: "receipt",
    userId: admin.id,
  });
  // Received then fully consumed: must still be findable, shown as zero.
  await recordMovement(db, {
    componentId: ids.cctv,
    locationId: ids.falcon,
    qtyDelta: 2,
    reason: "receipt",
    userId: admin.id,
  });
  await recordMovement(db, {
    componentId: ids.cctv,
    locationId: ids.falcon,
    qtyDelta: -2,
    reason: "issue",
    userId: admin.id,
  });
});

after(async () => {
  await client.close();
});

describe("fuzzy matching", () => {
  // The spec names these two cases directly.
  for (const query of ["esp 32", "esp-32", "ESP32", "esp32", "Esp_32"]) {
    test(`"${query}" finds the ESP32`, async () => {
      const hits = await searchComponents(db, query);
      assert.ok(
        hits.some((h) => h.componentId === ids.esp32),
        `expected ESP32 in results, got: ${hits.map((h) => h.name).join(", ")}`,
      );
    });
  }

  test("typos still match", async () => {
    for (const query of ["esp32 devkti", "hikvsion", "bluepil"]) {
      const hits = await searchComponents(db, query);
      assert.ok(hits.length > 0, `"${query}" should still find something`);
    }
  });

  test("matches on search_terms, not just the name", async () => {
    // "surveillance" appears only in the keyword bag.
    const hits = await searchComponents(db, "surveillance");
    assert.equal(hits[0]?.componentId, ids.cctv);
  });

  test("matches on manufacturer and mpn", async () => {
    const byManufacturer = await searchComponents(db, "espressif");
    assert.ok(byManufacturer.some((h) => h.componentId === ids.esp32));

    const byMpn = await searchComponents(db, "DS-2CD1143G0-I");
    assert.ok(byMpn.some((h) => h.componentId === ids.cctv));
  });

  test("an unrelated query returns nothing", async () => {
    const hits = await searchComponents(db, "hydraulic pump gasket");
    assert.equal(hits.length, 0);
  });

  test("an empty query returns nothing rather than everything", async () => {
    assert.deepEqual(await searchComponents(db, ""), []);
    assert.deepEqual(await searchComponents(db, "   "), []);
  });
});

describe("result shape", () => {
  test("one row per component-location pair, so location needs no extra tap", async () => {
    const hits = await searchComponents(db, "esp32");
    const esp = hits.filter((h) => h.componentId === ids.esp32);

    assert.equal(esp.length, 2, "ESP32 is in two cupboards, so two rows");

    const byLocation = new Map(esp.map((h) => [h.locationId, h]));
    assert.equal(byLocation.get(ids.falcon)?.onHand, 4);
    assert.equal(byLocation.get(ids.kestrel)?.onHand, 10);
  });

  test("each row carries its location and project for the log and for inference", async () => {
    const hits = await searchComponents(db, "esp32");
    const falconRow = hits.find((h) => h.locationId === ids.falcon);

    assert.equal(falconRow?.locationName, "Cupboard-Falcon");
    assert.equal(falconRow?.projectName, "Falcon");
  });

  test("the general shelf has stock but no project", async () => {
    const [row] = await searchComponents(db, "header");
    assert.equal(row.locationName, "General Shelf");
    assert.equal(row.projectId, null);
    assert.equal(row.onHand, 200);
  });

  test("out-of-stock rows are shown last, not hidden", async () => {
    const hits = await searchComponents(db, "camera");
    const cctv = hits.find((h) => h.componentId === ids.cctv);

    assert.ok(cctv, "a fully consumed part must still be findable");
    assert.equal(cctv.onHand, 0);
  });

  test("in-stock rows outrank out-of-stock ones", async () => {
    const hits = await searchComponents(db, "board");
    const firstOutOfStock = hits.findIndex((h) => h.onHand === 0);
    const lastInStock = hits.map((h) => h.onHand > 0).lastIndexOf(true);

    if (firstOutOfStock !== -1 && lastInStock !== -1) {
      assert.ok(
        lastInStock < firstOutOfStock,
        "every in-stock row must come before every out-of-stock row",
      );
    }
  });
});

describe("ranking", () => {
  test("a name match outranks a keyword-only match", async () => {
    // "microcontroller" is in both boards' keyword bags; "stm32" names one.
    const hits = await searchComponents(db, "stm32");
    assert.equal(hits[0]?.componentId, ids.stm32);
  });

  test("higher stock breaks ties between locations of the same part", async () => {
    const hits = await searchComponents(db, "esp32");
    const esp = hits.filter((h) => h.componentId === ids.esp32);
    assert.equal(
      esp[0].locationId,
      ids.kestrel,
      "the cupboard with 10 should sort above the one with 4",
    );
  });

  test("limit is respected", async () => {
    const hits = await searchComponents(db, "microcontroller", { limit: 1 });
    assert.equal(hits.length, 1);
  });
});
