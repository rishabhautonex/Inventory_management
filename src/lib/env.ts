/**
 * Environment access with an error that names the missing variable, instead of
 * an `undefined` that surfaces three layers away as a confusing auth failure.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

export const env = {
  get NEXT_PUBLIC_SUPABASE_URL() {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get NEXT_PUBLIC_SUPABASE_ANON_KEY() {
    return required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  },
  get DATABASE_URL() {
    return required("DATABASE_URL");
  },
  /**
   * Server-only. Used to write invoice files to Storage and to read them back
   * through short-lived signed URLs, so the bucket itself stays private.
   */
  get SUPABASE_SERVICE_ROLE_KEY() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },
  /**
   * Server-only, and deliberately optional.
   *
   * When it is absent the app reads invoices exactly as it always has, with the
   * deterministic parser alone. A missing key is a smaller feature, never a
   * broken upload, so this returns null rather than throwing like the others.
   */
  get DEEPSEEK_API_KEY(): string | null {
    return process.env.DEEPSEEK_API_KEY?.trim() || null;
  },
  get DEEPSEEK_MODEL(): string {
    return process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-pro";
  },
  get INVOICE_BUCKET(): string {
    return process.env.INVOICE_BUCKET?.trim() || "invoices";
  },
  /**
   * Shared secret for the scheduled jobs, server-only and optional.
   *
   * Absent means the job routes refuse every caller rather than running
   * unauthenticated: an open endpoint that writes notifications for the whole
   * lab is worse than a job that has not been wired up yet. Vercel Cron sends
   * it as `Authorization: Bearer <CRON_SECRET>` automatically.
   */
  get CRON_SECRET(): string | null {
    return process.env.CRON_SECRET?.trim() || null;
  },
  /** Empty means "any domain" — only sensible for local development. */
  get ALLOWED_EMAIL_DOMAINS(): string[] {
    return (process.env.ALLOWED_EMAIL_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  },
  get BOOTSTRAP_MANAGER_EMAIL(): string | null {
    return process.env.BOOTSTRAP_MANAGER_EMAIL?.trim().toLowerCase() || null;
  },
};

/**
 * Whether the app has enough configuration to do anything at all.
 *
 * Checked before touching Supabase or the database so a fresh clone with no
 * `.env.local` shows setup instructions instead of a 500 from three layers
 * down.
 */
export function isConfigured(): { ok: boolean; missing: string[] } {
  const missing = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "DATABASE_URL",
  ].filter((name) => !process.env[name]);

  return { ok: missing.length === 0, missing };
}

/**
 * The lab's sign-in rule. Enforced server-side on every sign-in; the `hd` hint
 * passed to Google only changes which account picker appears and is trivially
 * bypassed, so it is never treated as the check.
 */
export function isAllowedEmail(email: string): boolean {
  const domains = env.ALLOWED_EMAIL_DOMAINS;
  if (domains.length === 0) return true;

  const domain = email.trim().toLowerCase().split("@")[1];
  return domain ? domains.includes(domain) : false;
}
