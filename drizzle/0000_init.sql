CREATE TYPE "public"."location_type" AS ENUM('cupboard', 'shelf', 'bin', 'general');--> statement-breakpoint
CREATE TYPE "public"."movement_reason" AS ENUM('receipt', 'issue', 'return', 'adjustment', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."order_channel" AS ENUM('online', 'offline');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('ordered', 'shipped', 'delivered', 'shelved', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('pending', 'approved', 'rejected', 'ordered');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('engineer', 'project_head', 'admin', 'manager');--> statement-breakpoint
CREATE TABLE "bom_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bom_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"qty_needed" integer NOT NULL,
	CONSTRAINT "bom_lines_qty_positive" CHECK ("bom_lines"."qty_needed" > 0)
);
--> statement-breakpoint
CREATE TABLE "boms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" text,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"mpn" text,
	"manufacturer" text,
	"category" text,
	"search_terms" text,
	"product_url" text,
	"datasheet_url" text,
	"photo_url" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_blob" text GENERATED ALWAYS AS (lower(
        coalesce(name, '') || ' ' ||
        coalesce(mpn, '') || ' ' ||
        coalesce(manufacturer, '') || ' ' ||
        coalesce(category, '') || ' ' ||
        coalesce(search_terms, '')
      )) STORED,
	"search_squashed" text GENERATED ALWAYS AS (regexp_replace(
        lower(
          coalesce(name, '') || ' ' ||
          coalesce(mpn, '') || ' ' ||
          coalesce(manufacturer, '') || ' ' ||
          coalesce(category, '') || ' ' ||
          coalesce(search_terms, '')
        ),
        '[^a-z0-9]+', '', 'g'
      )) STORED
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "location_type" NOT NULL,
	"parent_id" uuid,
	"project_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "locations_no_self_parent" CHECK ("locations"."parent_id" IS DISTINCT FROM "locations"."id"),
	CONSTRAINT "locations_general_has_no_project" CHECK ("locations"."type" <> 'general' OR "locations"."project_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link_url" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"unit_price" numeric(12, 2),
	CONSTRAINT "order_lines_qty_positive" CHECK ("order_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid,
	"project_id" uuid,
	"channel" "order_channel" NOT NULL,
	"order_date" timestamp with time zone,
	"expected_date" timestamp with time zone,
	"tracking_number" text,
	"tracking_url" text,
	"invoice_file_url" text,
	"invoice_mime" text,
	"invoice_ocr_text" text,
	"status" "order_status" DEFAULT 'ordered' NOT NULL,
	"delivered_at" timestamp with time zone,
	"shelved_at" timestamp with time zone,
	"total_amount" numeric(12, 2),
	"currency" text DEFAULT 'INR' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "part_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"component_id" uuid,
	"free_text" text,
	"qty" integer NOT NULL,
	"reason" text,
	"status" "request_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "part_requests_qty_positive" CHECK ("part_requests"."qty" > 0),
	CONSTRAINT "part_requests_target" CHECK (("part_requests"."component_id" IS NOT NULL) <> ("part_requests"."free_text" IS NOT NULL AND "part_requests"."free_text" <> '')),
	CONSTRAINT "part_requests_rejection_needs_note" CHECK ("part_requests"."status" <> 'rejected' OR ("part_requests"."decision_note" IS NOT NULL AND "part_requests"."decision_note" <> ''))
);
--> statement-breakpoint
CREATE TABLE "project_leads" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "project_leads_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"qty_delta" integer NOT NULL,
	"reason" "movement_reason" NOT NULL,
	"user_id" uuid,
	"order_line_id" uuid,
	"reverses_movement_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_delta_non_zero" CHECK ("stock_movements"."qty_delta" <> 0),
	CONSTRAINT "stock_movements_reversal_shape" CHECK (("stock_movements"."reason" = 'reversal') = ("stock_movements"."reverses_movement_id" IS NOT NULL)),
	CONSTRAINT "stock_movements_receipt_shape" CHECK ("stock_movements"."order_line_id" IS NULL OR "stock_movements"."reason" = 'receipt'),
	CONSTRAINT "stock_movements_direction" CHECK (CASE
            WHEN "stock_movements"."reason" IN ('receipt', 'return') THEN "stock_movements"."qty_delta" > 0
            WHEN "stock_movements"."reason" = 'issue' THEN "stock_movements"."qty_delta" < 0
            ELSE true
          END)
);
--> statement-breakpoint
CREATE TABLE "stock_thresholds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"min_qty" integer NOT NULL,
	CONSTRAINT "stock_thresholds_min_qty_non_negative" CHECK ("stock_thresholds"."min_qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"google_sub" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"role" "role" DEFAULT 'engineer' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"website" text
);
--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_bom_id_boms_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."boms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boms" ADD CONSTRAINT "boms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boms" ADD CONSTRAINT "boms_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_parent_id_locations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_requests" ADD CONSTRAINT "part_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_leads" ADD CONSTRAINT "project_leads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_leads" ADD CONSTRAINT "project_leads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reverses_movement_id_stock_movements_id_fk" FOREIGN KEY ("reverses_movement_id") REFERENCES "public"."stock_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_thresholds" ADD CONSTRAINT "stock_thresholds_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_thresholds" ADD CONSTRAINT "stock_thresholds_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bom_lines_bom_idx" ON "bom_lines" USING btree ("bom_id");--> statement-breakpoint
CREATE UNIQUE INDEX "components_mpn_key" ON "components" USING btree (regexp_replace(lower("mpn"), '[^a-z0-9]+', '', 'g')) WHERE "components"."mpn" IS NOT NULL AND "components"."mpn" <> '';--> statement-breakpoint
CREATE INDEX "locations_parent_idx" ON "locations" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "locations_project_idx" ON "locations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id","created_at" DESC) WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "order_lines_order_idx" ON "order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_project_idx" ON "orders" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "orders_expected_date_idx" ON "orders" USING btree ("expected_date");--> statement-breakpoint
CREATE INDEX "part_requests_status_idx" ON "part_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "part_requests_project_idx" ON "part_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "part_requests_requested_by_idx" ON "part_requests" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "project_leads_user_idx" ON "project_leads" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_code_key" ON "projects" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "stock_movements_component_location_idx" ON "stock_movements" USING btree ("component_id","location_id");--> statement-breakpoint
CREATE INDEX "stock_movements_created_at_idx" ON "stock_movements" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "stock_movements_user_idx" ON "stock_movements" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stock_movements_location_idx" ON "stock_movements" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_reverses_key" ON "stock_movements" USING btree ("reverses_movement_id") WHERE "stock_movements"."reverses_movement_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_thresholds_component_location_key" ON "stock_thresholds" USING btree ("component_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_sub_key" ON "users" USING btree ("google_sub");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));