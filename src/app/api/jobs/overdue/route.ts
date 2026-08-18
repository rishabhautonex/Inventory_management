import { NextResponse } from "next/server";

import { db } from "@/db";
import { authorizeJob } from "@/lib/jobs";
import { checkOverdueOrders } from "@/lib/order-alerts";

/**
 * Daily: notify admins and project heads about deliveries that have not
 * arrived. The spec's one scheduled trigger; every other notification hangs off
 * a write.
 *
 * GET rather than POST because that is what Vercel Cron issues. Nothing here is
 * cacheable, and `dynamic` says so explicitly so a build cannot decide to
 * prerender a job that writes rows.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = authorizeJob(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const result = await checkOverdueOrders(db);
  return NextResponse.json({ ok: true, ...result });
}
