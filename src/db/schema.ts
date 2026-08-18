import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

export const roleEnum = pgEnum("role", [
  "engineer",
  "project_head",
  "admin",
  "manager",
]);

export const projectStatusEnum = pgEnum("project_status", ["active", "closed"]);

export const locationTypeEnum = pgEnum("location_type", [
  "cupboard",
  "shelf",
  "bin",
  "general",
]);

/** The only reasons a row may enter the ledger. */
export const movementReasonEnum = pgEnum("movement_reason", [
  "receipt",
  "issue",
  "return",
  "adjustment",
  "reversal",
]);

export const orderChannelEnum = pgEnum("order_channel", ["online", "offline"]);

export const orderStatusEnum = pgEnum("order_status", [
  "ordered",
  "shipped",
  "delivered",
  "shelved",
  "cancelled",
]);

export const requestStatusEnum = pgEnum("request_status", [
  "pending",
  "approved",
  "rejected",
  "ordered",
]);

/* -------------------------------------------------------------------------- */
/* People                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `id` mirrors the Supabase `auth.users.id` so a session maps to a row with no
 * extra lookup. Rows are created on first Google sign-in and never hard-deleted
 * — deactivation is `is_active = false`, because ledger rows reference users
 * forever and history must stay readable.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    googleSub: text("google_sub").notNull(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    role: roleEnum("role").notNull().default("engineer"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("users_google_sub_key").on(t.googleSub),
    uniqueIndex("users_email_key").on(sql`lower(${t.email})`),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    code: text("code").notNull(),
    status: projectStatusEnum("status").notNull().default("active"),
    /**
     * What the project is, in the project head's own words. Nullable rather
     * than defaulted to "": a project nobody has described yet is a different
     * thing from one described as nothing, and only the first should prompt.
     */
    description: text("description"),
    /** Where the firmware lives. Validated as an http(s) URL before it lands. */
    repoUrl: text("repo_url"),
    /**
     * The project's written-up documentation — a README, a wiki page, a design
     * doc in Drive.
     *
     * A link rather than stored text, and separate from `repo_url` rather than
     * derived from it. Derived would be a lie for a private repo, for a project
     * whose notes live outside Git, and for a monorepo whose README is three
     * directories down; and copying the file in would leave the app serving a
     * README that stopped matching the code the day after it was pasted.
     */
    readmeUrl: text("readme_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("projects_code_key").on(sql`lower(${t.code})`)],
);

/**
 * Join table, not a column on `projects`: a project may have several heads and
 * a person may head several projects.
 */
export const projectLeads = pgTable(
  "project_leads",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index("project_leads_user_idx").on(t.userId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Places                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Hierarchical: cupboard -> shelf -> bin. `project_id` is null for the general
 * shelf, which holds shared consumables and parts orphaned by closed projects.
 * A movement's project is derived by walking up to the owning cupboard.
 */
export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    type: locationTypeEnum("type").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => locations.id, {
      onDelete: "restrict",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    index("locations_parent_idx").on(t.parentId),
    index("locations_project_idx").on(t.projectId),
    // A location cannot be its own parent. Deeper cycles are prevented in the
    // application layer, which walks the chain before saving.
    check("locations_no_self_parent", sql`${t.parentId} IS DISTINCT FROM ${t.id}`),
    // The general shelf is by definition not owned by a project.
    check(
      "locations_general_has_no_project",
      sql`${t.type} <> 'general' OR ${t.projectId} IS NULL`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                   */
/* -------------------------------------------------------------------------- */

export const vendors = pgTable("vendors", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  website: text("website"),
});

/**
 * `searchBlob` and `searchSquashed` are generated columns, so they can never
 * drift from their source fields the way a trigger-maintained column can.
 *
 *  - `searchBlob`     lowercased, separators kept   -> trigram similarity, typo tolerance
 *  - `searchSquashed` lowercased, separators strippe -> makes "esp 32" and "esp-32" both
 *                                                       literal substrings of "esp32"
 *
 * Both get GIN trigram indexes in the search migration.
 */
export const components = pgTable(
  "components",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    mpn: text("mpn"),
    manufacturer: text("manufacturer"),
    category: text("category"),
    /** Unstructured keyword bag, e.g. "cctv camera surveillance ip dome poe 4mp onvif". */
    searchTerms: text("search_terms"),
    /** Vendor link used for reordering. */
    productUrl: text("product_url"),
    datasheetUrl: text("datasheet_url"),
    photoUrl: text("photo_url"),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    searchBlob: text("search_blob").generatedAlwaysAs(
      sql`lower(
        coalesce(name, '') || ' ' ||
        coalesce(mpn, '') || ' ' ||
        coalesce(manufacturer, '') || ' ' ||
        coalesce(category, '') || ' ' ||
        coalesce(search_terms, '')
      )`,
    ),
    searchSquashed: text("search_squashed").generatedAlwaysAs(
      sql`regexp_replace(
        lower(
          coalesce(name, '') || ' ' ||
          coalesce(mpn, '') || ' ' ||
          coalesce(manufacturer, '') || ' ' ||
          coalesce(category, '') || ' ' ||
          coalesce(search_terms, '')
        ),
        '[^a-z0-9]+', '', 'g'
      )`,
    ),
  },
  (t) => [
    // Same manufacturer part number must not be catalogued twice.
    uniqueIndex("components_mpn_key")
      .on(sql`regexp_replace(lower(${t.mpn}), '[^a-z0-9]+', '', 'g')`)
      .where(sql`${t.mpn} IS NOT NULL AND ${t.mpn} <> ''`),
  ],
);

/** Low-stock trigger point, set per component PER location — not globally. */
export const stockThresholds = pgTable(
  "stock_thresholds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    componentId: uuid("component_id")
      .notNull()
      .references(() => components.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    minQty: integer("min_qty").notNull(),
  },
  (t) => [
    uniqueIndex("stock_thresholds_component_location_key").on(
      t.componentId,
      t.locationId,
    ),
    check("stock_thresholds_min_qty_non_negative", sql`${t.minQty} >= 0`),
  ],
);

/* -------------------------------------------------------------------------- */
/* Purchasing                                                                  */
/* -------------------------------------------------------------------------- */

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vendorId: uuid("vendor_id").references(() => vendors.id, {
      onDelete: "restrict",
    }),
    /** Decides the destination cupboard; the exact leaf is picked while shelving. */
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    channel: orderChannelEnum("channel").notNull(),
    orderDate: timestamp("order_date", { withTimezone: true }),
    expectedDate: timestamp("expected_date", { withTimezone: true }),
    trackingNumber: text("tracking_number"),
    trackingUrl: text("tracking_url"),
    invoiceFileUrl: text("invoice_file_url"),
    invoiceMime: text("invoice_mime"),
    /** Filled asynchronously by OCR. Search only — never used to create lines. */
    invoiceOcrText: text("invoice_ocr_text"),
    status: orderStatusEnum("status").notNull().default("ordered"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    shelvedAt: timestamp("shelved_at", { withTimezone: true }),
    /** Invoice grand total as charged, incl. shipping and tax. May exceed the line sum. */
    totalAmount: numeric("total_amount", { precision: 12, scale: 2 }),
    currency: text("currency").notNull().default("INR"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("orders_status_idx").on(t.status),
    index("orders_project_idx").on(t.projectId),
    index("orders_expected_date_idx").on(t.expectedDate),
  ],
);

export const orderLines = pgTable(
  "order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    componentId: uuid("component_id")
      .notNull()
      .references(() => components.id, { onDelete: "restrict" }),
    qty: integer("qty").notNull(),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }),
  },
  (t) => [
    index("order_lines_order_idx").on(t.orderId),
    check("order_lines_qty_positive", sql`${t.qty} > 0`),
  ],
);

/* -------------------------------------------------------------------------- */
/* The ledger                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * APPEND ONLY. There is no quantity column anywhere in this schema; on-hand is
 * always SUM(qty_delta) grouped by component and location.
 *
 * Nothing here is ever UPDATEd or DELETEd. A mistake is undone by inserting a
 * `reversal` row carrying the inverse delta and pointing at the original via
 * `reverses_movement_id`. The unique index on that column is what makes
 * double-undo impossible — enforced by the database, not by a code path someone
 * can forget to call.
 *
 * Writes go through `recordMovement()` in src/lib/ledger.ts and nowhere else.
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    componentId: uuid("component_id")
      .notNull()
      .references(() => components.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    /** Signed, never zero. Negative takes stock out, positive puts it in. */
    qtyDelta: integer("qty_delta").notNull(),
    reason: movementReasonEnum("reason").notNull(),
    /** Who physically did it. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    orderLineId: uuid("order_line_id").references(() => orderLines.id, {
      onDelete: "restrict",
    }),
    reversesMovementId: uuid("reverses_movement_id").references(
      (): AnyPgColumn => stockMovements.id,
      { onDelete: "restrict" },
    ),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Drives every on-hand lookup and the part-detail stock table.
    index("stock_movements_component_location_idx").on(
      t.componentId,
      t.locationId,
    ),
    // Drives the reverse-chronological log page.
    index("stock_movements_created_at_idx").on(sql`${t.createdAt} DESC`),
    index("stock_movements_user_idx").on(t.userId),
    index("stock_movements_location_idx").on(t.locationId),

    // A movement can be reversed at most once.
    uniqueIndex("stock_movements_reverses_key")
      .on(t.reversesMovementId)
      .where(sql`${t.reversesMovementId} IS NOT NULL`),

    // A zero-delta movement is meaningless and would pollute the log.
    check("stock_movements_delta_non_zero", sql`${t.qtyDelta} <> 0`),

    // Reason and its companion column must agree, both ways.
    check(
      "stock_movements_reversal_shape",
      sql`(${t.reason} = 'reversal') = (${t.reversesMovementId} IS NOT NULL)`,
    ),
    check(
      "stock_movements_receipt_shape",
      sql`${t.orderLineId} IS NULL OR ${t.reason} = 'receipt'`,
    ),
    // Directional sanity: receipts and returns add, issues remove.
    check(
      "stock_movements_direction",
      sql`CASE
            WHEN ${t.reason} IN ('receipt', 'return') THEN ${t.qtyDelta} > 0
            WHEN ${t.reason} = 'issue' THEN ${t.qtyDelta} < 0
            ELSE true
          END`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* BOMs                                                                        */
/* -------------------------------------------------------------------------- */

export const boms = pgTable("boms", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  version: text("version"),
  uploadedBy: uuid("uploaded_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const bomLines = pgTable(
  "bom_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bomId: uuid("bom_id")
      .notNull()
      .references(() => boms.id, { onDelete: "cascade" }),
    componentId: uuid("component_id")
      .notNull()
      .references(() => components.id, { onDelete: "restrict" }),
    qtyNeeded: integer("qty_needed").notNull(),
  },
  (t) => [
    index("bom_lines_bom_idx").on(t.bomId),
    check("bom_lines_qty_positive", sql`${t.qtyNeeded} > 0`),
    // One row per part per BOM. Two rows for the same component would make
    // "how many are needed" ambiguous and force the shortfall table to pick
    // one; the import merges duplicate rows before they get here instead.
    uniqueIndex("bom_lines_bom_component_key").on(t.bomId, t.componentId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

export const partRequests = pgTable(
  "part_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    /** Either an existing catalogue part, or free text for something new. */
    componentId: uuid("component_id").references(() => components.id, {
      onDelete: "set null",
    }),
    freeText: text("free_text"),
    qty: integer("qty").notNull(),
    reason: text("reason"),
    status: requestStatusEnum("status").notNull().default("pending"),
    /**
     * How many the head actually approved, when that differs from the ask.
     *
     * A separate column rather than an edit to `qty`, for the reason the ledger
     * is append-only: what somebody asked for and what they were granted are two
     * facts, and overwriting the first to record the second loses the only
     * evidence that a decision was made at all. Null means "as asked", so an
     * ordinary approval writes nothing here.
     */
    approvedQty: integer("approved_qty"),
    decidedBy: uuid("decided_by").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    /** Set when an admin converts an approved request into a purchase. */
    orderId: uuid("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("part_requests_status_idx").on(t.status),
    index("part_requests_project_idx").on(t.projectId),
    index("part_requests_requested_by_idx").on(t.requestedBy),
    check("part_requests_qty_positive", sql`${t.qty} > 0`),
    // An approval for zero is a rejection, and rejections need a note.
    check(
      "part_requests_approved_qty_positive",
      sql`${t.approvedQty} IS NULL OR ${t.approvedQty} > 0`,
    ),
    // Exactly one of component_id / free_text identifies what is wanted.
    check(
      "part_requests_target",
      sql`(${t.componentId} IS NOT NULL) <> (${t.freeText} IS NOT NULL AND ${t.freeText} <> '')`,
    ),
    // A rejection without an explanation is not actionable.
    check(
      "part_requests_rejection_needs_note",
      sql`${t.status} <> 'rejected' OR (${t.decisionNote} IS NOT NULL AND ${t.decisionNote} <> '')`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* Notifications                                                               */
/* -------------------------------------------------------------------------- */

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    linkUrl: text("link_url"),
    /**
     * Identity of the underlying condition, e.g.
     * `low_stock:<component_id>:<location_id>`.
     *
     * The spec requires that the same low-stock condition is not re-notified
     * more than once every seven days while it stays low, which needs something
     * stable to compare against. Deriving that from `link_url` would tie a
     * dedupe rule to a display string, so it gets its own column.
     */
    dedupeKey: text("dedupe_key"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Powers the unread badge.
    index("notifications_user_unread_idx")
      .on(t.userId, sql`${t.createdAt} DESC`)
      .where(sql`${t.readAt} IS NULL`),
    // Powers the dedupe lookup on every alert write.
    index("notifications_dedupe_idx")
      .on(t.userId, t.dedupeKey, sql`${t.createdAt} DESC`)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
    // Drives the notifications page.
    index("notifications_user_created_idx").on(
      t.userId,
      sql`${t.createdAt} DESC`,
    ),
  ],
);
