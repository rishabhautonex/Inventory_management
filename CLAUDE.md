# LabStock — working notes

Internal R&D lab inventory app. The authoritative requirements are in
[INVENTORY_SPEC.md](INVENTORY_SPEC.md); this file covers how the code is put
together and the rules that must not be broken.

## The one rule

**Stock quantity is never stored. It is always `SUM(qty_delta)` over the
append-only `stock_movements` ledger.**

There is no `quantity` column anywhere, and adding one is a bug, not a
shortcut. Concretely:

- Every stock change goes through `recordMovement()` in
  [src/lib/ledger.ts](src/lib/ledger.ts). Nothing else may INSERT into
  `stock_movements`.
- Nothing may UPDATE or DELETE `stock_movements` at all. The database refuses
  both via the `forbid_ledger_mutation` trigger.
- Undo means inserting a `reversal` row with the inverse delta and
  `reverses_movement_id` set. The original row is never touched.
- A movement can be reversed at most once, enforced by a partial unique index.
- A reversal's delta must be exactly the inverse of its target, enforced by the
  `check_reversal_is_inverse` trigger.

`tests/architecture.test.ts` fails the build if any file outside `lib/ledger.ts`
writes to the ledger directly, so this is checked rather than merely documented.

## Other invariants worth knowing

- **Stock is location-scoped, never global.** There are no reservations, no
  allocations and no transfers between cupboards. Lab policy is that two
  projects needing the same part buy it twice.
- **Project is derived, not stored on movements.** `location_tree` resolves each
  location's effective project by inheriting from its nearest ancestor cupboard.
- **Quantities are whole pieces.** No lengths, no weights.
- **Timestamps are UTC in the database, Asia/Kolkata on screen.** Use the
  helpers in [src/lib/format.ts](src/lib/format.ts).
- **Currency is INR.**

## Layout

```
src/db/schema.ts        tables, enums, check constraints
src/db/queries/         raw-SQL read models (search, movements, dashboard,
                        notifications, orders, requests, bom, projects)
src/db/rows.ts          runQuery(): typed rows, driver-neutral
src/lib/ledger.ts       the only ledger write path
src/lib/auth.ts         session, roles, permission predicates
src/lib/notify.ts       notification delivery, behind NotificationChannel
src/lib/stock-alerts.ts low-stock / out-of-stock triggers
src/lib/ocr.ts          invoice text extraction, behind InvoiceTextExtractor
src/lib/invoice-extract.ts  reads fields and line items off invoice text
src/lib/invoice-match.ts  suggests catalogue matches; never writes
src/lib/orders.ts       shared order+lines insert, used by both intake paths
src/lib/request-alerts.ts   request-workflow notifications
src/lib/bom-parse.ts    CSV / pasted-table reader; never guesses a quantity
src/lib/bom-match.ts    normalised MPN first, then fuzzy name; never writes
src/lib/storage.ts      private invoice bucket, staging, signed reads
src/app/(app)/          authenticated screens
src/app/actions/        server actions
src/components/ui.tsx   the design system: Card, Panel, StatCard, Badge,
                        buttons, inputs, table parts
src/components/icons.tsx  the icon set, hand-rolled, currentColor
src/components/sidebar.tsx  desktop nav; bottom-nav.tsx is its phone counterpart
drizzle/                migrations; 0001 holds triggers, views, trgm indexes
tests/                  run against real Postgres via PGlite
```

## The look

An instrument panel, not a document: near-black `#0B0F14` ground, `#121922`
surfaces, and a signal palette that only ever carries meaning — cyan `#35D6FF`
for the brand and anything selected, emerald `#31E6A8` for in and healthy,
amber `#FFB547` for out and low, red `#FF5D73` for empty and overdue. Text is
`#F5F7FA` over `#94A3B8`.

Both schemes are complete token sets in [globals.css](src/app/globals.css);
light is an override under `:root[data-theme="light"]`, and the toggle in the
top bar writes that attribute plus localStorage. The inline script in the root
layout re-applies it before first paint, so a light-mode user never sees a dark
flash — which is why `THEME_STORAGE_KEY` lives in [lib/theme.ts](src/lib/theme.ts)
and not beside the toggle. A Server Component importing a value out of a
`"use client"` module gets a client reference proxy rather than the string, and
that script spent a while reading `localStorage.getItem(undefined)`.

Rules that are easy to break:

- **`accent` fills, `accent-text` writes.** Cyan is bright, so a filled control
  carries dark ink (`--accent-foreground`) and lightens on hover, while links,
  badge text and active labels use `text-accent-text`. In light mode both are
  the same hue taken down far enough to sit on white.
- **A solid accent fill means "this is the action".** Primary buttons and the
  logo tile, and nothing else. Selected nav entries and filter tabs use
  `bg-accent-soft` with a lit edge — eight solid cyan pills down a rail shout
  louder than the screen they introduce.
- **Never define a colour only inside `[data-theme="light"]`.** Bare `:root` is
  the base; anything missing there is invisible in dark mode.

Four surface treatments carry the depth, all in globals.css so a card cannot
half-adopt one:

| class | for |
| --- | --- |
| `.panel` | every card: surface colour, top-lit gradient, hairline border, 1px inner highlight |
| `.panel-glass` | floating things — menus, modals, the login card |
| `.chrome-glass` | the top bar and the phone's bottom nav; no border of its own |
| `.grid-backdrop` / `.aurora` | the drawing grid behind the shell and the bloom behind a page header |

Charts are hand-rolled SVG in [components/ui.tsx](src/components/ui.tsx) —
`Sparkline`, `SplineChart`, `RadialGauge`, `Heatmap` — with no chart library and
no client component, so they render on the server and cost the browser nothing.
The curves are Catmull-Rom converted to beziers, which smooths the line *between*
readings and still passes through every measured point.

## The dashboard

Every figure and every chart on it is a read model over `stock_movements`, in
[queries/dashboard.ts](src/db/queries/dashboard.ts), and the rule that keeps it
honest is that **nothing is drawn that was not measured**:

- `getMovementSeries()` generates the day list rather than reading it off the
  ledger, so a quiet day is a zero and not a gap the spline would draw straight
  through. Days are bucketed in Asia/Kolkata, like `movements_today`.
- The on-hand sparkline is reconstructed on the page by walking today's total
  backwards through those daily nets. It is the same rows the total came from,
  not a second stored series that could drift.
- `listTopMovers()` drops both halves of a correction — the reversed movement
  and its reversal — so a mistake does not leave a part looking busy.
- `getStockHealth()` counts only pairs that have a minimum set. Without one
  there is no standard to be above, and counting them as healthy flatters the
  gauge. A threshold whose shelf has never seen a movement is empty, not
  missing.
- A trend badge, a sparkline and a signal line are each omitted when there is
  nothing honest behind them: no yesterday to compare against, no series, no
  statement that holds. `tests/dashboard.test.ts` pins these shapes.

Signals are derived, never predicted — each line restates rows already fetched.

Two navigations, one per breakpoint: `Sidebar` from `lg` up, `BottomNav` below.
The phone keeps the thumb-reachable bar because the take-out flow is someone
standing at a cupboard holding parts.

## Conventions

- Query modules take a `Database` handle as their first argument rather than
  importing `db`, so the same SQL runs in tests against PGlite.
- Raw SQL goes through `runQuery<RowType>(db, sql\`…\`)`. Calling
  `db.execute()` directly loses the row type and returns a different shape per
  driver.
- Server actions return `{ ok: true }` or `{ ok: false, error }` rather than
  throwing, so the UI can show a message inline.
- Permission checks live in `lib/auth.ts` as predicates and are re-checked
  inside every server action. The proxy only gates signed-in vs not.
- Tap targets are at least 44px. No hover-only affordances.

## Commands

```bash
npm run dev          # dev server
npm run build        # production build
npm test             # ledger, search and architecture tests (no DB needed)
npm run typecheck
npm run lint
npm run db:generate  # new migration from schema.ts
npm run db:migrate   # apply migrations
npm run db:seed      # demo data
```

## Build order

Steps 1–5 of the spec are done: auth and roles, locations and projects,
components and fuzzy search, the ledger and take-out flow, the log and undo.

Step 8 is partly done. Low-stock and out-of-stock notifications work end to end:
`checkStockAlerts()` runs after every ledger write and after a threshold change,
recipients are admins plus that project's heads (never managers, who are owed a
digest instead), and the spec's seven-day dedupe window is enforced inside the
INSERT via `notifications.dedupe_key`. Not yet built from that step: the manager
digest, and the daily job for overdue deliveries — that one needs orders first.

Steps 6, 7, 9 and 10 are done: orders, receiving, invoice upload and invoice
OCR; part requests and approvals; BOM import and shortfall.

The one rule that matters here is that **an order is an intention, not stock**.
Nothing an order does touches the ledger until a line is put away, and that
happens through `recordMovement()` with `reason: "receipt"` and `order_line_id`
set, like any other movement. Consequently:

- How much of a line has arrived is `SUM(qty_delta)` over its un-reversed
  receipts (`SHELVED_QTY` in [queries/orders.ts](src/db/queries/orders.ts)).
  There is no `shelved_qty` column, so undoing a receipt in the log reopens the
  line by itself.
- `shelved` is not a status anyone can set. `setOrderStatusAction` refuses it;
  it becomes true when every line's full quantity has arrived. A button for it
  would let the record claim stock that never reached a shelf.
- Receiving is partial in both senses: a subset of lines, and part of a line.
- Online orders must be `delivered` before anything is put away; offline
  purchases skip straight there, as the spec allows.

## Invoice intake

**This deviates from the spec deliberately, on the product owner's decision.**
[INVENTORY_SPEC.md:175](INVENTORY_SPEC.md#L175) says not to populate order lines
from OCR, and line 276 lists it as a non-goal. `/orders/from-invoice` does read
lines off an invoice — vendor, date, total, tracking number, tracking link, and
one row per component. Do not "fix" it back; it is wanted.

What makes it safe is the shape, and that part must not be weakened:

- **`analyseInvoiceAction` writes nothing to the database.** It stores the file
  and returns proposals. `commitInvoiceIntakeAction` takes only what the reviewer
  confirmed on screen, and never re-reads the invoice. An edit made in the review
  popup is the value that lands.
- **Receipts still go through `recordMovement()`.** There is no second write path
  into the ledger for this feature.
- **A quantity that could not be read is `null`, not a guess.** The review screen
  leaves the field blank and refuses to save until a person types it.

Extraction is in [lib/invoice-extract.ts](src/lib/invoice-extract.ts) and the
key idea is that **arithmetic constrains the reading**. Given

```
Jumper Wire Set 40pin 4 99.00 396.00
```

the numeric tail is `4, 99, 396`, and the reading is chosen by searching ordered
triples for one where `qty × rate = amount`. 4 × 99 = 396 holds, so the quantity
is 4. Even if 40 were a candidate, 40 × 99 = 3960 rules it out. Lines that
multiply out are `high` confidence; lines needing a guess are marked and
surfaced. Two filters keep letterhead out of the parts list: a line item must
carry figures, and must not contain a URL.

Line parsing is tokenised, never one regex over the tail. A character class like
`[₹Rs.]` under `/i` also matches a bare `r` or `s` and silently truncates
"Motor" — there is a test pinning exactly that.

The read-only panel on an existing order's page still only *suggests* matches
against lines already typed; [lib/invoice-match.ts](src/lib/invoice-match.ts)
shares its line parsing with the intake flow so the two cannot disagree.

Extraction lives in [lib/ocr.ts](src/lib/ocr.ts) behind `InvoiceTextExtractor`:
`unpdf` for a PDF's own text layer, tesseract for photos, and rasterise-then-OCR
for image-only PDFs. It never throws — a failed pass leaves the file stored and
merely unsearchable. `@napi-rs/canvas`, `tesseract.js` and `unpdf` are in
`serverExternalPackages`; the native binding cannot be bundled.

Invoices go to a **private** Supabase Storage bucket (`INVOICE_BUCKET`) and are
read back through short-lived signed URLs. Storage keys are derived from the
order id, never from the uploaded filename.

Still to come: the manager digest, and the daily overdue-delivery job.

## Part requests

```
engineer raises → project head approves → admin converts to an order
```

The screens are at `/requests`, the writes in
[actions/requests.ts](src/app/actions/requests.ts). Three things hold it
together:

- **A request is a want, not stock, and not yet a purchase.** Approving creates
  nothing; converting calls `insertOrderWithLines()`, so what comes out is an
  ordinary order that receives like any other and only becomes stock when a line
  is put away.
- **Every transition is guarded on the state it is leaving, inside the UPDATE.**
  Two heads tapping Approve at the same moment produce one approval and one
  "already decided", rather than racing over `decided_by`. Same for converting,
  which is guarded on `approved` so a double click cannot attach a second order
  and orphan the first.
- **Visibility is a value, not a branch.** `visibilityFor(user)` in
  [queries/requests.ts](src/db/queries/requests.ts) is the only place the role
  rule lives, and it is applied inside the lookup — so a request for a project
  somebody does not lead is a 404, not a refusal that confirms it exists.

A rejection needs a note: the spec asks for it, the `part_requests_rejection_needs_note`
check enforces it, and the form asks for it before offering the button. A
free-text request cannot be converted, because an order line needs a real
catalogue part; the UI sends the admin to catalogue it first rather than
inventing a component with no search keywords.

Requests raised for a project with no head assigned fall through to the admins.
Without that they would sit unseen for ever.

## BOM import

`/projects/[id]/bom`, and it is the invoice intake's shape again:
`analyseBomAction` reads and proposes and **writes nothing**;
`commitBomAction` takes only what the reviewer confirmed on screen and never
re-reads the uploaded text.

- **A quantity that could not be read is `null`, not a guess** — the same rule
  as the invoice flow. The review row leaves the field blank and carries a note.
- **Nothing here creates a component.** Unmatched rows link out to
  `/admin/parts/new`, per the spec, because a part conjured mid-import arrives
  with no search keywords and an unfindable part is what the catalogue exists to
  prevent.
- **Matching is exact-then-fuzzy**, in that order:
  [bom-match.ts](src/lib/bom-match.ts) resolves normalised MPN through
  `squash_search` — the same normalisation as the unique index on
  `components.mpn` — before falling back to the ordinary fuzzy search. Only MPN
  hits and literal name containment are pre-selected; a merely similar name is
  offered and left unticked.
- **The delimiter is detected by consistency, not frequency.** A description
  column full of commas otherwise beats the tabs that actually separate the
  columns, so the candidate with the steadiest cell count per line wins. Quoted
  fields are honoured, because `Resistor, 10k 1%` is an ordinary part name.

Shortfall lives in [queries/bom.ts](src/db/queries/bom.ts) and is derived, like
every quantity here: `needed - SUM(on_hand)` over **that project's own**
locations, resolved through `location_tree` so a bin inherits its cupboard's
project. Another cupboard's stock is never an answer — lab policy is that two
projects needing the same part buy it twice.

`on_order` and `requested` sit beside `to_buy` without being subtracted from
it. A box that has not arrived is not stock, so netting it off would show zero
short for a part nobody has; what they do is stop somebody buying the same thing
twice on the screen that makes that easy. Both one-click paths — raise requests,
order the gaps — re-derive quantities server-side from the ledger, so a tab left
open while a delivery was put away does nothing rather than ordering air.

A new upload does not replace the old one. Only the newest is what the project
page measures against; the rest stay readable, and a switcher puts the choice in
the URL.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
