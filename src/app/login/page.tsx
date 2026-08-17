import { Suspense } from "react";

import { isConfigured } from "@/lib/env";
import { CubeIcon } from "@/components/icons";
import { LoginButton } from "./login-button";

const ERROR_MESSAGES: Record<string, string> = {
  domain:
    "That account is not on the lab's domain. Sign in with your work Google account.",
  no_email: "That Google account has no email address attached.",
  missing_code: "Sign-in was interrupted. Please try again.",
  exchange_failed: "Sign-in could not be completed. Please try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const message = params.error
    ? (ERROR_MESSAGES[params.error] ?? params.error)
    : null;

  const config = isConfigured();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-16 shrink-0 items-center px-6">
        <span className="brand-mark text-xl font-bold tracking-tight">
          LabStock
        </span>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        {config.ok ? (
          <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-(--shadow-panel) sm:p-8">
            <div className="flex flex-col items-center text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent/15 text-accent-text">
                <CubeIcon size={30} />
              </span>

              <h1 className="mt-5 text-2xl font-bold tracking-tight">
                Sign in to LabStock
              </h1>
              <p className="mt-1.5 text-sm text-muted">
                R&amp;D lab inventory — what we have, where it is, who took it.
              </p>
            </div>

            {message ? (
              <p
                role="alert"
                className="mt-6 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm font-medium text-danger"
              >
                {message}
              </p>
            ) : null}

            <div className="mt-7">
              <Suspense>
                <LoginButton next={params.next} />
              </Suspense>
            </div>

            <p className="mt-6 text-center text-xs text-muted">
              Use your lab Google account. New accounts start as an engineer —
              ask a manager for more access.
            </p>
          </div>
        ) : (
          <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-(--shadow-panel) sm:p-8">
            <h1 className="text-2xl font-bold tracking-tight">
              LabStock needs setting up
            </h1>
            <p className="mt-2 text-sm text-muted">
              Copy <code className="font-mono">.env.example</code> to{" "}
              <code className="font-mono">.env.local</code> and fill in these
              values, then restart the dev server:
            </p>
            <ul className="mt-4 space-y-1 rounded-lg border border-border bg-surface-muted p-4 font-mono text-sm">
              {config.missing.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
            <p className="mt-4 text-sm text-muted">
              The README walks through creating the Supabase project and the
              Google OAuth client.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
