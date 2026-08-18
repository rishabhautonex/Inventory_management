/**
 * Demo data, so a fresh database is explorable before anyone has catalogued a
 * real part. Safe to re-run: it skips anything already present.
 *
 *   npm run db:seed
 */
import { config } from "dotenv";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../src/db/schema";
import { recordMovement } from "../src/lib/ledger";

config({ path: ".env.local", quiet: true });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Fill in .env.local first.");
  process.exit(1);
}

const client = postgres(connectionString, { prepare: false, max: 4 });
const db = drizzle(client, { schema, casing: "snake_case" });

async function main() {
  console.log("Seeding…");

  // Attribute the demo movements to a real person if anyone has signed in,
  // otherwise to a clearly-labelled placeholder.
  let [actor] = await db.select().from(schema.users).limit(1);
  if (!actor) {
    [actor] = await db
      .insert(schema.users)
      .values({
        id: crypto.randomUUID(),
        googleSub: "seed-placeholder",
        email: "seed@example.invalid",
        name: "Seed Data",
        role: "admin",
      })
      .returning();
    console.log("  created placeholder user (no real account existed yet)");
  }

  const projectSpecs = [
    { name: "Falcon", code: "FAL" },
    { name: "Kestrel", code: "KES" },
  ];

  const projectIds: Record<string, string> = {};
  for (const spec of projectSpecs) {
    const [existing] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.code, spec.code));

    if (existing) {
      projectIds[spec.code] = existing.id;
      continue;
    }

    const [row] = await db.insert(schema.projects).values(spec).returning();
    projectIds[spec.code] = row.id;
    console.log(`  project ${spec.name}`);
  }

  async function ensureLocation(values: {
    name: string;
    type: "cupboard" | "shelf" | "bin" | "general";
    parentId?: string | null;
    projectId?: string | null;
  }) {
    const [existing] = await db
      .select()
      .from(schema.locations)
      .where(eq(schema.locations.name, values.name));
    if (existing) return existing.id;

    const [row] = await db
      .insert(schema.locations)
      .values({
        name: values.name,
        type: values.type,
        parentId: values.parentId ?? null,
        projectId: values.projectId ?? null,
      })
      .returning();
    console.log(`  location ${values.name}`);
    return row.id;
  }

  const cupboardFalcon = await ensureLocation({
    name: "Cupboard-Falcon",
    type: "cupboard",
    projectId: projectIds.FAL,
  });
  const falconShelf = await ensureLocation({
    name: "Falcon Shelf 1",
    type: "shelf",
    parentId: cupboardFalcon,
  });
  const cupboardKestrel = await ensureLocation({
    name: "Cupboard-Kestrel",
    type: "cupboard",
    projectId: projectIds.KES,
  });
  const generalShelf = await ensureLocation({
    name: "General Shelf",
    type: "general",
  });

  const parts = [
    {
      name: "ESP32 DevKit v1",
      mpn: "ESP32-DEVKITC-32D",
      manufacturer: "Espressif",
      category: "Dev board",
      searchTerms:
        "esp32 esp 32 wifi bluetooth ble microcontroller devkit wroom nodemcu",
      stock: [
        { location: cupboardFalcon, qty: 4 },
        { location: cupboardKestrel, qty: 10 },
      ],
    },
    {
      name: "Hikvision DS-2CD1143G0 Dome Camera",
      mpn: "DS-2CD1143G0-I",
      manufacturer: "Hikvision",
      category: "Camera",
      searchTerms:
        "cctv camera surveillance security ip dome poe 4mp outdoor onvif",
      stock: [{ location: cupboardFalcon, qty: 2 }],
    },
    {
      name: "Male Header 2.54mm 40-pin",
      mpn: "HDR-M-254-40",
      manufacturer: "Generic",
      category: "Connector",
      searchTerms: "header pin strip breadboard jumper berg 2.54 male",
      stock: [{ location: generalShelf, qty: 200 }],
    },
    {
      name: "STM32F103C8T6 Blue Pill",
      mpn: "STM32F103C8T6",
      manufacturer: "STMicroelectronics",
      category: "Dev board",
      searchTerms: "stm32 blue pill bluepill arm cortex m3 microcontroller",
      stock: [{ location: falconShelf, qty: 6 }],
    },
    {
      name: "DHT22 Temperature & Humidity Sensor",
      mpn: "AM2302",
      manufacturer: "Aosong",
      category: "Sensor",
      searchTerms: "dht22 am2302 temperature humidity sensor climate",
      stock: [{ location: generalShelf, qty: 15 }],
    },
    {
      name: "MG996R Servo Motor",
      mpn: "MG996R",
      manufacturer: "TowerPro",
      category: "Actuator",
      searchTerms: "servo motor mg996r metal gear torque rc",
      stock: [{ location: cupboardKestrel, qty: 0 }],
    },
  ];

  for (const part of parts) {
    const [existing] = await db
      .select()
      .from(schema.components)
      .where(eq(schema.components.mpn, part.mpn));

    if (existing) continue;

    const [component] = await db
      .insert(schema.components)
      .values({
        name: part.name,
        mpn: part.mpn,
        manufacturer: part.manufacturer,
        category: part.category,
        searchTerms: part.searchTerms,
        createdBy: actor.id,
      })
      .returning();

    console.log(`  part ${part.name}`);

    for (const entry of part.stock) {
      if (entry.qty <= 0) continue;
      await recordMovement(db, {
        componentId: component.id,
        locationId: entry.location,
        qtyDelta: entry.qty,
        reason: "receipt",
        userId: actor.id,
        note: "Seed data",
      });
    }

    // One threshold so the low-stock styling has something to show.
    if (part.mpn === "ESP32-DEVKITC-32D") {
      await db
        .insert(schema.stockThresholds)
        .values({
          componentId: component.id,
          locationId: cupboardFalcon,
          minQty: 5,
        })
        .onConflictDoNothing();
    }
  }

  async function componentIdByMpn(mpn: string) {
    const [row] = await db
      .select({ id: schema.components.id })
      .from(schema.components)
      .where(eq(schema.components.mpn, mpn));
    return row?.id ?? null;
  }

  // A BOM for Falcon, chosen so the shortfall table has both kinds of row:
  // parts already covered by the cupboard, and parts that are only on the
  // general shelf — which belongs to no project and therefore counts for none.
  const [existingBom] = await db
    .select()
    .from(schema.boms)
    .where(eq(schema.boms.projectId, projectIds.FAL));

  if (!existingBom) {
    const wanted = [
      { mpn: "ESP32-DEVKITC-32D", qtyNeeded: 10 },
      { mpn: "STM32F103C8T6", qtyNeeded: 4 },
      { mpn: "AM2302", qtyNeeded: 12 },
      { mpn: "HDR-M-254-40", qtyNeeded: 6 },
    ];

    const lines: Array<{ componentId: string; qtyNeeded: number }> = [];
    for (const entry of wanted) {
      const componentId = await componentIdByMpn(entry.mpn);
      if (componentId) lines.push({ componentId, qtyNeeded: entry.qtyNeeded });
    }

    if (lines.length > 0) {
      const [bom] = await db
        .insert(schema.boms)
        .values({
          projectId: projectIds.FAL,
          name: "Falcon gateway",
          version: "rev A",
          uploadedBy: actor.id,
        })
        .returning();

      await db
        .insert(schema.bomLines)
        .values(lines.map((line) => ({ bomId: bom.id, ...line })));

      console.log(`  BOM Falcon gateway (${lines.length} lines)`);
    }
  }

  // Two requests, one at each end of the workflow, so the queues are not empty.
  const [existingRequest] = await db
    .select()
    .from(schema.partRequests)
    .limit(1);

  if (!existingRequest) {
    const servo = await componentIdByMpn("MG996R");

    if (servo) {
      await db.insert(schema.partRequests).values({
        requestedBy: actor.id,
        projectId: projectIds.KES,
        componentId: servo,
        qty: 2,
        reason: "The Kestrel arm needs two more — the shelf is empty.",
      });
    }

    await db.insert(schema.partRequests).values({
      requestedBy: actor.id,
      projectId: projectIds.FAL,
      freeText: "Waveshare 7.5in e-paper display, 800×480",
      qty: 1,
      reason: "For the gateway status panel. Not catalogued yet.",
      status: "approved",
      decidedBy: actor.id,
      decidedAt: new Date(),
    });

    console.log("  part requests (one waiting, one approved)");
  }

  const [{ count }] = await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM stock_movements`,
  );

  console.log(`Done. ${count} movements in the ledger.`);
  await client.end();
}

main().catch(async (error) => {
  console.error(error);
  await client.end();
  process.exit(1);
});
