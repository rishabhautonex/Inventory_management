import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

/**
 * The spec asks that every stock change go through one server-side function and
 * that nothing else write to the table directly. That is an architectural rule,
 * not a runtime one, so it is checked by reading the source.
 *
 * The database also refuses UPDATE and DELETE outright (see the ledger tests),
 * but a stray INSERT elsewhere would still be legal SQL while bypassing the
 * overdraw check and the advisory lock. This test is what catches that.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");

/** The one module allowed to touch the ledger table. */
const LEDGER_MODULE = path.join("src", "lib", "ledger.ts");

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe("the ledger has exactly one write path", () => {
  test("nothing outside lib/ledger.ts inserts into stock_movements", () => {
    const offenders: string[] = [];

    for (const file of walk(srcDir)) {
      const relative = path.relative(path.join(here, ".."), file);
      if (relative === LEDGER_MODULE) continue;

      const source = fs.readFileSync(file, "utf8");

      // Drizzle query-builder form, and raw SQL form.
      if (
        /\.insert\s*\(\s*stockMovements\s*\)/.test(source) ||
        /insert\s+into\s+["`']?stock_movements/i.test(source)
      ) {
        offenders.push(relative);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `these files write to the ledger directly instead of calling recordMovement(): ${offenders.join(", ")}`,
    );
  });

  test("nothing anywhere updates or deletes stock_movements", () => {
    const offenders: string[] = [];

    for (const file of walk(srcDir)) {
      const source = fs.readFileSync(file, "utf8");
      const relative = path.relative(path.join(here, ".."), file);

      if (
        /\.update\s*\(\s*stockMovements\s*\)/.test(source) ||
        /\.delete\s*\(\s*stockMovements\s*\)/.test(source) ||
        /update\s+["`']?stock_movements/i.test(source) ||
        /delete\s+from\s+["`']?stock_movements/i.test(source)
      ) {
        offenders.push(relative);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `the ledger is append-only; these files try to mutate it: ${offenders.join(", ")}`,
    );
  });

  test("no code stores a quantity instead of deriving it", () => {
    const schemaSource = fs.readFileSync(
      path.join(srcDir, "db", "schema.ts"),
      "utf8",
    );

    // A quantity column on components is the specific mistake the spec calls
    // out by name. order_lines.qty and bom_lines.qty_needed are intended
    // quantities, not stock, so the check is scoped to the components table.
    const componentsBlock = schemaSource.slice(
      schemaSource.indexOf('pgTable(\n  "components"'),
      schemaSource.indexOf('pgTable(\n  "stock_thresholds"'),
    );

    for (const forbidden of ["quantity", "onHand", "on_hand", "stockLevel"]) {
      assert.ok(
        !componentsBlock.includes(forbidden),
        `components must not carry a '${forbidden}' column — on-hand is derived from the ledger`,
      );
    }
  });
});
