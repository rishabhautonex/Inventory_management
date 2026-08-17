# LabStock

Inventory for a small R&D lab that buys electronic components from many
vendors. Tracks what we have, where it is, who took it, and what's on order.

Mobile-first: the primary user is standing at a cupboard holding a phone in one
hand, and taking a part out is two taps and a number.

Requirements live in [INVENTORY_SPEC.md](INVENTORY_SPEC.md). Architecture notes
and the rules that must not be broken are in [CLAUDE.md](CLAUDE.md).

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind 4 · Postgres via Supabase ·
Drizzle ORM · Google OAuth restricted to the lab's domain.

## Setup

### 1. Create a Supabase project

At [supabase.com](https://supabase.com), then collect:

| Value | Where |
|---|---|
| Project URL, anon key | Project Settings → Data API |
| Service role key | Project Settings → API Keys |
| Connection string | Connect → ORMs → Drizzle |

### 2. Enable Google sign-in

In Supabase: **Authentication → Providers → Google**. It needs a Google OAuth
client from the [Google Cloud console](https://console.cloud.google.com/apis/credentials):

- Authorised redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`
- Paste the client ID and secret into Supabase.

Then under **Authentication → URL Configuration**, add your site URL and
`http://localhost:3000/**` to the redirect allow-list.

### 3. Configure the app

```bash
cp .env.example .env.local
```

Fill in the values. Two matter beyond the Supabase credentials:

- `ALLOWED_EMAIL_DOMAINS` — only these domains may sign in. Enforced
  server-side on every sign-in, so it cannot be bypassed by editing the OAuth
  URL.
- `BOOTSTRAP_MANAGER_EMAIL` — the first account with this address becomes a
  `manager`, so there is somebody who can assign every other role. Everyone
  else starts as an `engineer`.

### 4. Create the schema

```bash
npm install
npm run db:migrate
npm run db:seed     # optional demo data
npm run dev
```

Open http://localhost:3000.

### 5. First run

Sign in with the bootstrap address, then:

1. **Admin → Projects** — create a project.
2. **Admin → Locations** — a cupboard per project, plus one general shelf for
   shared consumables. Shelves and bins nest underneath.
3. **Admin → Parts** — add parts. Fill the search keywords generously; that
   field is what makes a part findable.
4. **Admin → People** — assign roles as others sign in.

## Tests

```bash
npm test
```

Runs against a real Postgres compiled to WebAssembly (PGlite), applying the
actual migration files — so the triggers, check constraints and trigram search
under test are the same ones that run in production. No database or Docker
required.

The suite covers the ledger invariants (append-only, undo-once, reversal must
be an exact inverse, no negative stock), the search behaviours the spec names
by hand (`esp 32` and `esp-32` both find `ESP32`), and an architectural guard
that fails if any code outside `lib/ledger.ts` writes to the ledger.

## Deploying

Vercel plus Supabase. Set the same environment variables in the Vercel project,
and add your production URL to Supabase's redirect allow-list. Run
`npm run db:migrate` against the production database as part of release.
