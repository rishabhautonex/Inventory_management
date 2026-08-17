import { env } from "@/lib/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Invoice file storage.
 *
 * The original file is always kept, exactly as uploaded — the spec is explicit
 * about that, and it is what makes the OCR text safe to treat as a lossy
 * convenience rather than the record. The bucket is private; reads go through
 * signed URLs that expire.
 */

export const ACCEPTED_INVOICE_MIMES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

/** 20 MB. A phone photo of a bill is ~3-6 MB; a multi-page scan can be larger. */
export const MAX_INVOICE_BYTES = 20 * 1024 * 1024;

export type StoredInvoice = { path: string; mime: string; bytes: number };

export type StorageResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Whether invoice storage is configured well enough to work.
 *
 * Checked before the client is built rather than after the upload fails,
 * because a placeholder service-role key produces a rejection whose message
 * says nothing useful. Read from `process.env` directly, not through `env`,
 * whose getter throws on a missing value — the whole point here is to report
 * the problem rather than raise it.
 *
 * Exported so a screen can warn about this before somebody picks a file.
 */
export function checkInvoiceStorageConfig():
  | { ok: true }
  | { ok: false; error: string } {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";

  if (key === "") {
    return {
      ok: false,
      error:
        "SUPABASE_SERVICE_ROLE_KEY is not set. Copy it from Supabase → Project Settings → API Keys → service_role into .env.local, then restart the dev server.",
    };
  }

  // The value shipped in .env.example is `<service role key>`.
  if (key.startsWith("<") || /^(your|placeholder|xxx)/i.test(key)) {
    return {
      ok: false,
      error:
        "SUPABASE_SERVICE_ROLE_KEY is still the placeholder from .env.example. Replace it with the real service_role key from Supabase → Project Settings → API Keys, then restart the dev server.",
    };
  }

  // A real key is a long JWT (`eyJ…`) or a `sb_secret_…` secret. Anything short
  // is a truncated paste, which fails in a way that looks like a bucket problem.
  if (key.length < 40) {
    return {
      ok: false,
      error: `SUPABASE_SERVICE_ROLE_KEY is only ${key.length} characters, so it cannot be a real key — it was probably truncated when pasted. Copy the whole value from Supabase → Project Settings → API Keys → service_role, then restart the dev server.`,
    };
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()) {
    return {
      ok: false,
      error: "NEXT_PUBLIC_SUPABASE_URL is not set, so there is nowhere to upload to.",
    };
  }

  return { ok: true };
}

/**
 * Turns a Supabase Storage failure into something actionable.
 *
 * Storage returns the same shape for "no such bucket", "bad key" and "no
 * permission", and the difference matters entirely to whoever has to fix it.
 * The underlying message is included because every caller here is an admin
 * screen, and a vague error costs far more than the detail reveals.
 */
function describeStorageError(
  error: { message: string; name?: string },
  action: string,
): string {
  const message = error.message.toLowerCase();
  const bucket = env.INVOICE_BUCKET;

  if (message.includes("bucket not found") || message.includes("not found")) {
    return `The storage bucket "${bucket}" does not exist. Create it in Supabase → Storage as a private bucket, then try again.`;
  }
  if (
    message.includes("jwt") ||
    message.includes("unauthor") ||
    message.includes("signature") ||
    message.includes("invalid api key") ||
    message.includes("invalid claim")
  ) {
    return `Supabase rejected the credentials for the "${bucket}" bucket. Check that SUPABASE_SERVICE_ROLE_KEY holds the real service_role key and that the dev server was restarted after editing .env.local.`;
  }
  if (message.includes("row-level security") || message.includes("policy")) {
    return `A storage policy blocked ${action} on "${bucket}". The service_role key is meant to bypass policies, so this usually means the key in .env.local is the anon key by mistake.`;
  }
  if (message.includes("already exists") || message.includes("duplicate")) {
    return "A file with that key already exists. Try the upload again.";
  }
  if (message.includes("payload") || message.includes("too large")) {
    return `The file was rejected as too large by Supabase. The bucket's own file-size limit is lower than this app's ${Math.round(MAX_INVOICE_BYTES / (1024 * 1024))} MB; raise it in Supabase → Storage → bucket settings.`;
  }
  if (message.includes("fetch") || message.includes("network")) {
    return "Supabase could not be reached. Check the connection and NEXT_PUBLIC_SUPABASE_URL.";
  }

  return `Supabase refused ${action}: ${error.message}`;
}

function extensionFor(mime: string, fallbackName: string): string {
  const fromName = fallbackName.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (fromName) return fromName.toLowerCase();

  const map: Record<string, string> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  return map[mime] ?? "bin";
}

/**
 * Validates and stores one invoice file under the given key prefix.
 *
 * The MIME type is taken from the upload, so it is a claim rather than a fact —
 * which is why nothing downstream trusts it for anything dangerous. It only
 * chooses which text-extraction path to try, and a wrong guess there degrades to
 * "no OCR text", never to executing anything.
 */
async function putInvoiceFile(
  prefix: string,
  file: File,
): Promise<StorageResult<StoredInvoice>> {
  if (file.size === 0) {
    return { ok: false, error: "That file is empty." };
  }
  if (file.size > MAX_INVOICE_BYTES) {
    const mb = Math.round(MAX_INVOICE_BYTES / (1024 * 1024));
    return { ok: false, error: `Invoices must be under ${mb} MB.` };
  }

  const mime = file.type || "application/octet-stream";
  if (!ACCEPTED_INVOICE_MIMES.includes(mime as (typeof ACCEPTED_INVOICE_MIMES)[number])) {
    return {
      ok: false,
      error: "Upload a PDF or a photo of the invoice (JPEG, PNG, WebP or HEIC).",
    };
  }

  // Configuration first: a placeholder key fails with a message about buckets,
  // which sends whoever is debugging it in entirely the wrong direction.
  const config = checkInvoiceStorageConfig();
  if (!config.ok) return { ok: false, error: config.error };

  // Path is derived, never taken from the upload: a filename is attacker-chosen
  // and `../` in one has no business reaching a storage key.
  const path = `${prefix}/invoice-${Date.now()}.${extensionFor(mime, file.name)}`;

  try {
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.storage
      .from(env.INVOICE_BUCKET)
      .upload(path, await file.arrayBuffer(), {
        contentType: mime,
        upsert: false,
      });

    if (error) {
      console.error("[storage] invoice upload failed", error);
      return { ok: false, error: describeStorageError(error, "the upload") };
    }

    return { ok: true, data: { path, mime, bytes: file.size } };
  } catch (cause) {
    console.error("[storage] invoice upload threw", cause);
    const detail = cause instanceof Error ? ` (${cause.message})` : "";
    return {
      ok: false,
      error: `The file could not be stored${detail}. The server log has the full error.`,
    };
  }
}

/** Stores an invoice against an order that already exists. */
export function storeInvoiceFile(
  orderId: string,
  file: File,
): Promise<StorageResult<StoredInvoice>> {
  return putInvoiceFile(`orders/${orderId}`, file);
}

/**
 * Stores an invoice before its order exists.
 *
 * The intake flow reads the invoice first and creates the order from what it
 * finds, so the file needs somewhere to live in the meantime. Staged keys are
 * distinct from order keys, which keeps abandoned reviews identifiable rather
 * than leaving them mixed in with real orders' invoices.
 */
export function stageInvoiceFile(
  file: File,
): Promise<StorageResult<StoredInvoice>> {
  return putInvoiceFile(`intake/${crypto.randomUUID()}`, file);
}

/**
 * Moves a staged invoice to its order once that order has been created.
 *
 * A failure here is not fatal: the file is still stored and readable at its
 * staged key, so the caller keeps whichever path actually holds the bytes.
 */
export async function promoteStagedInvoice(
  stagedPath: string,
  orderId: string,
): Promise<string> {
  if (!stagedPath.startsWith("intake/")) return stagedPath;

  const filename = stagedPath.split("/").pop() ?? `invoice-${Date.now()}`;
  const destination = `orders/${orderId}/${filename}`;

  try {
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.storage
      .from(env.INVOICE_BUCKET)
      .move(stagedPath, destination);

    if (error) {
      console.error("[storage] promoting the staged invoice failed", error);
      return stagedPath;
    }
    return destination;
  } catch (cause) {
    console.error("[storage] promoting the staged invoice threw", cause);
    return stagedPath;
  }
}

/** Short-lived read URL for a stored invoice. Null when it cannot be signed. */
export async function signInvoiceUrl(
  path: string,
  expiresInSeconds = 300,
): Promise<string | null> {
  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.storage
      .from(env.INVOICE_BUCKET)
      .createSignedUrl(path, expiresInSeconds);

    if (error || !data?.signedUrl) {
      console.error("[storage] signing failed", error);
      return null;
    }
    return data.signedUrl;
  } catch (cause) {
    console.error("[storage] signing threw", cause);
    return null;
  }
}

/** Raw bytes of a stored invoice, for the OCR pass. */
export async function readInvoiceBytes(
  path: string,
): Promise<Uint8Array | null> {
  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.storage
      .from(env.INVOICE_BUCKET)
      .download(path);

    if (error || !data) {
      console.error("[storage] download failed", error);
      return null;
    }
    return new Uint8Array(await data.arrayBuffer());
  } catch (cause) {
    console.error("[storage] download threw", cause);
    return null;
  }
}
