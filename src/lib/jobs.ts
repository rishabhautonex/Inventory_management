import { env } from "@/lib/env";

/**
 * Authorisation for the scheduled jobs.
 *
 * These routes write notifications for everybody in the lab and read across
 * every project, so they are not behind the ordinary session check — there is no
 * session on a cron request — and must therefore be behind something. That is a
 * shared secret sent as `Authorization: Bearer …`, which is exactly what Vercel
 * Cron sends when `CRON_SECRET` is set on the project.
 *
 * With no secret configured every caller is refused. An unconfigured job that
 * does nothing is recoverable; an open endpoint that spams the lab is not.
 *
 * The comparison is length-then-content on purpose rather than `===`. It is not
 * constant-time — Node's `timingSafeEqual` needs equal-length buffers — but the
 * secret never appears in a response either way, so there is nothing here to
 * oracle beyond the answer the caller already has.
 */
export function authorizeJob(request: Request): { ok: true } | { ok: false; status: number; error: string } {
  const secret = env.CRON_SECRET;

  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: "This job is not configured. Set CRON_SECRET to enable it.",
    };
  }

  const header = request.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (offered.length !== secret.length || offered !== secret) {
    return { ok: false, status: 401, error: "Not authorised." };
  }

  return { ok: true };
}
