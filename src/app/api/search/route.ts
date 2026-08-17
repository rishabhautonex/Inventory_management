import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db";
import { searchComponents } from "@/db/queries/search";
import { getSessionUser } from "@/lib/auth";

/**
 * Search-as-you-type endpoint for the home screen.
 *
 * A GET route rather than a server action because this fires on every
 * keystroke: it can be aborted mid-flight when the query changes, which server
 * actions cannot do.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const query = request.nextUrl.searchParams.get("q") ?? "";
  if (query.trim() === "") {
    return NextResponse.json({ results: [] });
  }

  const results = await searchComponents(db, query, { limit: 40 });
  return NextResponse.json({ results });
}
