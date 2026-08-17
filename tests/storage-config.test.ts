import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { checkInvoiceStorageConfig } from "../src/lib/storage";

/**
 * These exist because the first real upload failed with "The file could not be
 * stored. Please try again." while the actual cause was an unedited
 * `<service role key>` placeholder in .env.local.
 *
 * A misconfiguration has to name itself. Every case below asserts on the text,
 * not just the failure, because the text is the entire value of the check.
 */

const KEYS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
] as const;

let saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const key of KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** A shape that passes the length and prefix checks. */
const PLAUSIBLE_KEY = `eyJ${"x".repeat(200)}`;

describe("invoice storage configuration", () => {
  test("a real-looking key and url pass", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = PLAUSIBLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";

    assert.deepEqual(checkInvoiceStorageConfig(), { ok: true });
  });

  test("a new-style sb_secret_ key passes too", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = `sb_secret_${"y".repeat(40)}`;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";

    assert.deepEqual(checkInvoiceStorageConfig(), { ok: true });
  });

  test("a missing key says which variable to set and where from", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";

    const result = checkInvoiceStorageConfig();
    assert.equal(result.ok, false);
    assert.match(result.error, /SUPABASE_SERVICE_ROLE_KEY is not set/);
    assert.match(result.error, /service_role/);
    assert.match(result.error, /restart/i);
  });

  test("the .env.example placeholder is called out as a placeholder", () => {
    // The exact value that caused the original failure.
    process.env.SUPABASE_SERVICE_ROLE_KEY = "<service role key>";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";

    const result = checkInvoiceStorageConfig();
    assert.equal(result.ok, false);
    assert.match(result.error, /placeholder/i);
    assert.match(result.error, /\.env\.example/);
  });

  test("a truncated paste is reported as too short, with its length", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";

    const result = checkInvoiceStorageConfig();
    assert.equal(result.ok, false);
    assert.match(result.error, /16 characters/);
    assert.match(result.error, /truncated/i);
  });

  test("whitespace round the key is not mistaken for a value", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "   ";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";

    const result = checkInvoiceStorageConfig();
    assert.equal(result.ok, false);
    assert.match(result.error, /is not set/);
  });

  test("a missing url is reported once the key is good", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = PLAUSIBLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;

    const result = checkInvoiceStorageConfig();
    assert.equal(result.ok, false);
    assert.match(result.error, /NEXT_PUBLIC_SUPABASE_URL/);
  });
});
