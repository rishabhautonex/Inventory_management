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
                        notifications)
src/db/rows.ts          runQuery(): typed rows, driver-neutral
src/lib/ledger.ts       the only ledger write path
src/lib/auth.ts         session, roles, permission predicates
src/lib/notify.ts       notification delivery, behind NotificationChannel
src/lib/stock-alerts.ts low-stock / out-of-stock triggers
src/lib/ocr.ts          invoice text extraction, behind InvoiceTextExtractor
src/lib/invoice-extract.ts  reads fields and line items off invoice text
src/lib/invoice-match.ts  suggests catalogue matches; never writes
src/lib/orders.ts       shared order+lines insert, used by both intake paths
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

Dark by default with a `#2661C8` brand blue. Both schemes are complete token
sets in [globals.css](src/app/globals.css); light is an override under
`:root[data-theme="light"]`, and the toggle in the top bar writes that attribute
plus localStorage. The inline script in the root layout re-applies it before
first paint, so a light-mode user never sees a dark flash.

Two rules that are easy to break:

- **`accent` fills, `accent-text` writes.** `#2661C8` is too dark to read
  against a near-black page, so links, badge text and active labels use
  `text-accent-text` (a lightened blue in dark, a deepened one in light) while
  buttons and the active nav pill use `bg-accent`.
- **Never define a colour only inside `[data-theme="light"]`.** Bare `:root` is
  the base; anything missing there is invisible in dark mode.

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

Steps 6 and 10 are done: orders, receiving, invoice upload and invoice OCR.

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

Still to come: part requests, BOM import, the manager digest, and the daily
overdue-delivery job.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
