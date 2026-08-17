import { NextResponse, type NextRequest } from "next/server";

import { syncUserFromAuth } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * OAuth landing point. Exchanges the code for a session, then enforces the
 * lab's email-domain rule before the user is allowed any further.
 *
 * The domain check happens here rather than in Google's `hd` parameter alone,
 * which is only a hint to the account chooser and can be removed by anyone
 * crafting the URL themselves.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";
  const oauthError = searchParams.get("error_description") ?? searchParams.get("error");

  if (oauthError) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(oauthError)}`,
    );
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(error?.message ?? "exchange_failed")}`,
    );
  }

  const result = await syncUserFromAuth(data.user);

  if (!result.ok) {
    // Not a lab account: end the session immediately so a rejected sign-in
    // leaves nothing behind.
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=${result.reason}`);
  }

  // Only allow relative redirects, so `?next=` cannot bounce anyone offsite.
  const destination = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return NextResponse.redirect(`${origin}${destination}`);
}
