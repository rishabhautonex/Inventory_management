-- ===========================================================================
-- Ledger enforcement, derived quantity, and fuzzy search.
--
-- Everything here is the part of the design the ORM cannot express: database
-- guarantees that hold no matter what any future code path tries to do.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The ledger is append-only, and the database is what enforces it.
--
-- The spec's central rule is that stock is never edited, only appended to. A
-- code review can miss an UPDATE; this trigger cannot. Corrections happen by
-- inserting a compensating `reversal` or `adjustment` row.
--
-- DDL is unaffected, so migrations that alter the table still work.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION forbid_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'stock_movements is append-only; % is not permitted. Insert a reversal or adjustment movement instead.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stock_movements_forbid_update ON stock_movements;
--> statement-breakpoint
CREATE TRIGGER stock_movements_forbid_update
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS stock_movements_forbid_truncate ON stock_movements;
--> statement-breakpoint
CREATE TRIGGER stock_movements_forbid_truncate
  BEFORE TRUNCATE ON stock_movements
  FOR STATEMENT EXECUTE FUNCTION forbid_ledger_mutation();
--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- 2. A reversal must actually be the inverse of what it reverses.
--
-- Without this, a reversal row could carry an arbitrary delta and silently
-- invent or destroy stock while looking like a legitimate undo.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION check_reversal_is_inverse()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  original stock_movements%ROWTYPE;
BEGIN
  IF NEW.reverses_movement_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO original
  FROM stock_movements
  WHERE id = NEW.reverses_movement_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cannot reverse movement %: it does not exist.',
      NEW.reverses_movement_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF original.reason = 'reversal' THEN
    RAISE EXCEPTION 'Cannot reverse movement %: it is itself a reversal.',
      NEW.reverses_movement_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.qty_delta <> -original.qty_delta THEN
    RAISE EXCEPTION
      'Reversal delta must be exactly the inverse of movement % (expected %, got %).',
      original.id, -original.qty_delta, NEW.qty_delta
      USING ERRCODE = 'check_violation';
  END IF;

  -- A reversal undoes the movement where it happened, not somewhere else.
  IF NEW.component_id <> original.component_id
     OR NEW.location_id <> original.location_id THEN
    RAISE EXCEPTION
      'Reversal must target the same component and location as movement %.',
      original.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stock_movements_check_reversal ON stock_movements;
--> statement-breakpoint
CREATE TRIGGER stock_movements_check_reversal
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION check_reversal_is_inverse();
--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- 3. Derived quantity.
--
-- The spec is explicit: at this scale a plain view is plenty, do not
-- prematurely materialise. `stock_movements_component_location_idx` is what
-- keeps this cheap.
--
-- Zero rows are deliberately kept. A component that has been emptied out of a
-- cupboard should still be findable there, shown as out of stock rather than
-- vanishing from search.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW stock_on_hand AS
SELECT
  component_id,
  location_id,
  SUM(qty_delta)::int AS on_hand,
  MAX(created_at)     AS last_movement_at
FROM stock_movements
GROUP BY component_id, location_id;
--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- 4. Location tree.
--
-- Resolves each location's display path ("Cupboard-Falcon / Shelf 2 / Bin A")
-- and its effective project. Only the cupboard normally carries `project_id`;
-- shelves and bins inherit it from their nearest ancestor that has one. This is
-- how "project is inferred from the cupboard" is answered in one join, and how
-- the log page gets a project column that `stock_movements` does not store.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW location_tree AS
WITH RECURSIVE walk AS (
  SELECT
    l.id,
    l.name,
    l.type,
    l.parent_id,
    l.project_id,
    l.is_active,
    l.name::text        AS path,
    l.project_id        AS effective_project_id,
    l.id                AS root_id,
    1                   AS depth
  FROM locations l
  WHERE l.parent_id IS NULL

  UNION ALL

  SELECT
    child.id,
    child.name,
    child.type,
    child.parent_id,
    child.project_id,
    child.is_active AND parent.is_active,
    parent.path || ' / ' || child.name,
    COALESCE(child.project_id, parent.effective_project_id),
    parent.root_id,
    parent.depth + 1
  FROM locations child
  JOIN walk parent ON child.parent_id = parent.id
)
SELECT * FROM walk;
--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- 5. Fuzzy search.
--
-- Two indexes because there are two distinct failure modes to defeat:
--
--   search_blob      keeps separators -> trigram similarity catches typos and
--                    partial words ("esp32 devkti" still finds the DevKit)
--   search_squashed  strips separators -> makes "esp 32", "esp-32" and "ESP32"
--                    all reduce to the identical string "esp32", so the match
--                    is exact rather than merely similar
--
-- gin_trgm_ops accelerates both `%` similarity and unanchored LIKE '%...%',
-- which is what the squashed lookup needs.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS components_search_blob_trgm
  ON components USING gin (search_blob gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS components_search_squashed_trgm
  ON components USING gin (search_squashed gin_trgm_ops);
--> statement-breakpoint

-- Same normalisation the generated columns use, exposed so the application can
-- squash the incoming query with provably identical rules. Drift between how
-- the query and the column are normalised is the classic way fuzzy search
-- quietly stops matching.
CREATE OR REPLACE FUNCTION squash_search(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT regexp_replace(lower(COALESCE(input, '')), '[^a-z0-9]+', '', 'g');
$$;
