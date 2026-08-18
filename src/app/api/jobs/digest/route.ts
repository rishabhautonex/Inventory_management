import { NextResponse } from "next/server";

import { db } from "@/db";
import { authorizeJob } from "@/lib/jobs";
import { sendManagerDigest } from "@/lib/manager-digest";

/**
 * Weekly: the manager digest, which is what managers get instead of the
 * per-event stock alerts they are deliberately excluded from.
 *
 * Idempotent — the digest is keyed on the ISO week, so a retry or a manual
 * trigger on the same Monday delivers nothing a second time.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = authorizeJob(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const result = await sendManagerDigest(db);
  return NextResponse.json({ ok: true, ...result });
}
