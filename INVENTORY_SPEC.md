# R&D Lab Inventory System — Build Spec

## What this is

An internal web app for a small R&D lab (10–30 people) that buys electronic components — sensors, boards, modules — from many different online and offline vendors. It tracks what we have, where it is, who took it, and what's on order.

Target: a working v1. Not an enterprise ERP. Optimise for low-friction daily use over completeness.

---

## Core design principle (do not violate)

**Stock quantity is never stored or edited. It is always derived by summing an append-only movement ledger.**

Every physical change — receiving, taking out, returning, correcting a miscount — inserts a row in `stock_movements` with a signed `qty_delta`. Nothing is ever updated or deleted. "Undo" inserts a compensating reversal row that points back at the original.

This gives audit trail, undo, and per-project consumption history for free. Any code that does `UPDATE components SET quantity = ...` is a bug.

---

## Stack

- **Next.js** (App Router) + TypeScript
- **Postgres** — Supabase is fine (gives auth, storage, and DB in one)
- **Tailwind** for styling
- **Drizzle** or **Prisma** for the ORM (pick one, be consistent)
- **Google OAuth**, restricted to the lab's work email domain
- File storage for invoices (Supabase Storage or S3)
- OCR: `tesseract.js` server-side, or any cloud OCR. Runs async after upload.

Deployed to the cloud (Vercel + Supabase). Accessed via URL in a phone browser — **no native app, no app store**. Must be mobile-first: the primary user is standing at a cupboard holding a phone in one hand.

---

## Users and roles

Accounts are created on first Google sign-in. Role is assigned by a manager afterwards; new users default to `engineer`.

| Role | Scope |
|---|---|
| `engineer` | Search parts, take parts out, view stock and logs, raise part requests |
| `project_head` | Everything an engineer can do, plus full view of *their assigned projects* (stock, BOM, spend, requests) and **approval rights on requests for those projects** |
| `admin` | Everything an engineer can do, plus create/edit parts, create and receive orders, adjust stock, manage locations. There may be 2+ admins. |
| `manager` | Full access to everything, all projects. Assigns roles. |

Project heads are **assigned per project** — a `project_leads` join table, not a single column, so a project can have more than one head and a person can head more than one project.

---

## Physical model — important

Each project has its **own physical cupboard**. Stock is **location-scoped, not global**.

**The lab's policy is: if two projects need the same component, they buy two separately.** Parts are not shared or transferred between project cupboards. This means:

- There is **no reservation/allocation layer.** Do not build `reserved` vs `available` quantities.
- On-hand is always computed **per component per location**: "4 × ESP32 in Cupboard-Falcon" is a different number from "10 × ESP32 in Cupboard-Kestrel".
- BOM shortfall for a project compares only against *that project's* cupboard.

A **general shelf** location exists for common consumables (headers, jumper wire, resistors, standoffs) and for parts orphaned when a project closes. It is not tied to a project.

Locations are hierarchical: `Cupboard → Shelf → Bin`. Movements record the leaf-most location the user selected.

Everything counts in **whole pieces**. No length or weight units. Quantities are integers.

---

## Data model

```
users
  id, google_sub, email, name, avatar_url, role, is_active, created_at

projects
  id, name, code, status (active|closed), created_at

project_leads
  project_id, user_id                        -- composite PK

locations
  id, name, type (cupboard|shelf|bin|general),
  parent_id (nullable, self-ref), project_id (nullable), is_active

components
  id, name, mpn, manufacturer, category,
  search_terms (long text — see Search),
  product_url,            -- Amazon / Robu / Mouser link for reordering
  datasheet_url, photo_url, notes,
  created_by, created_at

stock_thresholds
  id, component_id, location_id, min_qty     -- per component PER location

stock_movements                              -- APPEND ONLY
  id, component_id, location_id,
  qty_delta (signed int, never zero),
  reason (receipt|issue|return|adjustment|reversal),
  user_id,                                   -- who did it
  order_line_id (nullable),                  -- set when reason=receipt
  reverses_movement_id (nullable),           -- set when reason=reversal
  note, created_at

vendors
  id, name, website

orders
  id, vendor_id, project_id, channel (online|offline),
  order_date, expected_date,
  tracking_number, tracking_url,
  invoice_file_url, invoice_mime, invoice_ocr_text (nullable),
  status (ordered|shipped|delivered|shelved|cancelled),
  delivered_at, shelved_at,
  total_amount, currency, created_by, created_at

order_lines
  id, order_id, component_id, qty, unit_price

boms
  id, project_id, name, version, uploaded_by, created_at

bom_lines
  id, bom_id, component_id, qty_needed

part_requests
  id, requested_by, project_id,
  component_id (nullable), free_text (nullable),   -- one of these must be set
  qty, reason,
  status (pending|approved|rejected|ordered),
  decided_by, decided_at, decision_note,
  order_id (nullable), created_at

notifications
  id, user_id, type, title, body, link_url, read_at, created_at
```

**Derived quantity:**

```sql
SELECT component_id, location_id, SUM(qty_delta) AS on_hand
FROM stock_movements
GROUP BY component_id, location_id;
```

At this scale (under ~200 distinct parts) a plain query or a simple view is plenty. Do not prematurely materialise.

---

## Flow 1 — Taking a part out (the most important screen)

This is used dozens of times a day, on a phone, often one-handed. Optimise ruthlessly for speed.

1. User opens the app → search bar is focused by default.
2. Types a query. Results appear as a list. **Each row shows: part name, location, and current qty at that location.** If a part exists in three cupboards, that's three rows — the user taps the right one, which is how location gets chosen with zero extra taps.
3. Tap a row → modal: **"Using this?"** with `Yes` / `No`.
4. **Yes** → number input for quantity, prefilled with `1`, with `+`/`−` steppers. Confirm.
5. Movement inserted: `qty_delta = -n`, `reason = issue`, `user_id` from session, location from the tapped row.
6. Toast confirmation with an **Undo** button, visible ~30 seconds.

**Person is taken from the login. Project is inferred from the cupboard. Never ask for either.**

**No** → navigate to the part detail page (the usual reason for tapping "no" is wanting to check location or stock). The detail page has a prominent **Use** button that reopens the same quantity modal, for when they change their mind.

Guard rails:
- Block quantities that exceed on-hand at that location; show current count in the error.
- Reject zero and negative input.

---

## Flow 2 — Parts coming in

Admin creates an order: vendor, project (which decides the destination cupboard), channel (online/offline), line items (component + qty + unit price), expected delivery date, tracking number, and an invoice file.

**Invoice upload accepts both PDFs and photos/scans.** Always store the original file. For scanned images and image-only PDFs, run OCR asynchronously and save the result in `invoice_ocr_text` so invoices are full-text searchable later.

**Do not auto-populate order lines from OCR.** Order volume is low; a human types the lines. OCR text is for search only.

Status lifecycle:

```
ordered → shipped → delivered → shelved
```

`delivered` means the box reached reception. `shelved` means it's physically in the cupboard and countable.

**Only the `shelved` transition creates stock movements** — one `receipt` movement per order line, linked via `order_line_id`, with the location the admin selects while shelving. Receiving can be partial: allow shelving a subset of lines, and keep the order open until all lines are shelved.

Offline purchases can jump straight to `shelved`.

---

## Flow 3 — Part requests

An engineer needs something that isn't in stock.

```
engineer raises request → project head approves → admin converts to an order
```

- Request can point at an existing component, or be free text for something not in the catalogue yet.
- Only a head **of that project** (or a manager) can approve or reject. Rejection requires a note.
- Approved requests land in an admin queue. Converting one to an order links `part_requests.order_id` and moves status to `ordered`.
- Requester gets a notification at each state change.

---

## Flow 4 — The log

A single reverse-chronological page of every `stock_movement`: date/time, part, signed qty, reason, who, location, project.

- Filters: part, person, project/location, date range, reason.
- Every row has **Undo**, which inserts a `reversal` movement with the inverse `qty_delta` and sets `reverses_movement_id`. **Nothing is ever deleted or edited.**
- A movement that has already been reversed cannot be reversed again — show it struck through or badged instead.
- Engineers can see the log; only admins and managers can undo movements they didn't create.

---

## Search

Must find a part however the user phrases it.

- Each component has a **`search_terms`** free-text field: an unstructured bag of keywords the admin fills in. For a CCTV camera that might be `cctv camera surveillance security ip dome poe 4mp outdoor onvif`.
- Search matches across `name`, `mpn`, `manufacturer`, `category`, and `search_terms`.
- **Fuzzy matching is required** — `esp 32` must find `ESP32`, `esp-32` must find `ESP32`. Use Postgres `pg_trgm` with a GIN index, plus normalisation (lowercase, strip spaces/hyphens/underscores) on both sides.
- Results ranked by relevance, one row per component-location pair that has stock, with out-of-stock rows shown last rather than hidden.

---

## BOMs

- A project head or admin uploads a BOM (CSV, and paste-a-table also works).
- Columns: component identifier (name or MPN), quantity needed.
- On import, try to match each row to an existing component by normalised MPN first, then fuzzy name. **Show a review screen with the matches before committing** — never auto-create components silently. Unmatched rows offer "create new part".
- Once saved, the project page shows a shortfall table: `needed` vs `in this project's cupboard` vs `to buy`, with a one-click path to raise requests or an order for the gaps.

---

## Notifications

**In-app only for v1** — a bell icon with an unread count, and a notifications page.

Build the delivery layer behind a small interface (`notify(userId, type, payload)`) with an in-app implementation, so email can be added later as a second implementation without touching the trigger logic.

| Trigger | Recipients |
|---|---|
| Stock at or below `min_qty` for a component+location | Admins + heads of that project |
| Stock hits zero | Admins + heads of that project |
| Order past `expected_date` and not yet delivered | Admins + heads of that project |
| New part request pending approval | Heads of that project |
| Request approved / rejected | The requester |

Managers do **not** get individually pinged for every low-stock event — give them a weekly digest instead.

Triggers run on a daily scheduled job (overdue deliveries) and on write (stock thresholds, request state changes). Deduplicate: don't re-notify for the same component+location low-stock condition more than once every 7 days while it stays low.

---

## Screens

1. **Search / home** — focused search box, results list. The default landing page.
2. **Part detail** — name, photo, MPN, category, per-location stock table, product link, datasheet, recent movements, **Use** button. Admins additionally see edit, adjust-stock, and threshold controls.
3. **Log** — filterable movement history with undo.
4. **Orders** — list with status badges, overdue highlighted; detail page with lines, invoice preview, tracking link, and status transitions.
5. **New order** — admin form.
6. **Requests** — role-aware: engineers see their own, heads see a pending-approval queue for their projects, admins see approved requests waiting to be ordered.
7. **Projects** — list; detail shows the cupboard's stock, BOM shortfall, requests, and spend total.
8. **Locations** — admin management of the cupboard/shelf/bin tree.
9. **Notifications** — bell dropdown plus a full page.
10. **Admin/users** — manager-only role assignment and project head assignment.

---

## Explicitly out of scope for v1

- QR / barcode scanning (planned for v2 — keep `locations` and `components` addressable by a stable URL like `/scan/:locationId/:componentId` so this drops in cleanly later)
- Email, WhatsApp, or Slack notifications
- Automatic extraction of line items from invoices via OCR
- Serial-number or lot tracking of individual units
- Migration of existing stock data (it's scattered and messy — admins will add parts as they encounter them). **Do** provide a simple CSV import for components in case any of it turns out usable.
- Non-piece units (length, weight)
- Reservations, allocations, or transfers between project cupboards
- Approval workflows on spend limits

---

## Build order

1. Auth (Google, domain-restricted) + users + roles
2. Locations, projects, project leads
3. Components + search (get fuzzy search right early — everything depends on it)
4. Movement ledger + derived quantity + the take-out flow
5. Log page + undo
6. Orders + receiving + invoice upload
7. Requests + approvals
8. Thresholds + notifications
9. BOM import + shortfall
10. OCR on invoices

Ship after step 5 if you can. That alone is a usable system; everything after it is upside.

---

## Notes for whoever builds this

- Mobile-first is not a nice-to-have. Tap targets ≥ 44px, no hover-dependent UI, the take-out flow must work one-handed.
- The take-out flow should be reachable in **two taps and a number** from opening the app. If a change adds a tap there, push back on it.
- Keep the ledger sacred. Every stock change goes through one server-side function that inserts a movement — no direct table writes from anywhere else in the codebase.
- Timestamps in UTC, displayed in Asia/Kolkata.
- Currency is INR.
