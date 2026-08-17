import { eq, sql } from "drizzle-orm";

import type { Database, Executor } from "@/db/types";
import { runQuery } from "@/db/rows";
import { stockMovements } from "@/db/schema";

/**
 * ===========================================================================
 * THE LEDGER
 * ===========================================================================
 *
 * Every physical stock change in this application passes through
 * `recordMovement`. Nothing anywhere else may INSERT into `stock_movements`,
 * and nothing may UPDATE or DELETE it at all — the database refuses both (see
 * drizzle/0001_ledger_and_search.sql).
 *
 * There is no quantity column to keep in sync, because there is no quantity
 * column. On-hand is SUM(qty_delta) and nothing else.
 * ===========================================================================
 */

export type MovementReason =
  | "receipt"
  | "issue"
  | "return"
  | "adjustment"
  | "reversal";

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code:
      | "ZERO_DELTA"
      | "INSUFFICIENT_STOCK"
      | "WRONG_DIRECTION"
      | "ALREADY_REVERSED"
      | "NOT_REVERSIBLE"
      | "NOT_FOUND",
    /** On-hand at the moment of failure, for "only 3 left" style messages. */
    readonly available?: number,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

export type RecordMovementInput = {
  componentId: string;
  locationId: string;
  /** Signed. Negative removes stock, positive adds it. Never zero. */
  qtyDelta: number;
  reason: MovementReason;
  userId: string;
  orderLineId?: string | null;
  reversesMovementId?: string | null;
  note?: string | null;
};

export type Movement = typeof stockMovements.$inferSelect;

/**
 * Serialises concurrent writes for one component+location pair.
 *
 * Without this, two engineers taking the last unit at the same instant would
 * both read on-hand = 1, both pass the check, and both insert -1, leaving -1 in
 * a ledger that is supposed to be incapable of lying. The lock is transaction
 * scoped, so it releases on commit or rollback with no cleanup path to forget.
 */
async function lockStockLine(
  tx: Executor,
  componentId: string,
  locationId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${componentId} || ':' || ${locationId}, 0))`,
  );
}

/** On-hand for one component at one location. Always derived, never stored. */
export async function getOnHand(
  db: Executor,
  componentId: string,
  locationId: string,
): Promise<number> {
  const rows = await runQuery<{ on_hand: string | number | null }>(
    db,
    sql`
      SELECT COALESCE(SUM(qty_delta), 0) AS on_hand
      FROM stock_movements
      WHERE component_id = ${componentId} AND location_id = ${locationId}
    `,
  );
  const [row] = rows;
  return Number(row?.on_hand ?? 0);
}

/** On-hand for one component across every location that has ever held it. */
export async function getOnHandByLocation(
  db: Executor,
  componentId: string,
): Promise<
  Array<{
    locationId: string;
    locationName: string;
    locationPath: string;
    projectId: string | null;
    projectName: string | null;
    onHand: number;
    minQty: number | null;
    lastMovementAt: Date | null;
  }>
> {
  const rows = await runQuery<{
    location_id: string;
    location_name: string;
    location_path: string;
    project_id: string | null;
    project_name: string | null;
    on_hand: string | number;
    min_qty: number | null;
    last_movement_at: string | Date | null;
  }>(
    db,
    sql`
    SELECT
      soh.location_id,
      lt.name  AS location_name,
      lt.path  AS location_path,
      p.id     AS project_id,
      p.name   AS project_name,
      soh.on_hand,
      st.min_qty,
      soh.last_movement_at
    FROM stock_on_hand soh
    JOIN location_tree lt ON lt.id = soh.location_id
    LEFT JOIN projects p  ON p.id = lt.effective_project_id
    LEFT JOIN stock_thresholds st
           ON st.component_id = soh.component_id AND st.location_id = soh.location_id
    WHERE soh.component_id = ${componentId}
    ORDER BY (soh.on_hand > 0) DESC, lt.path ASC
  `,
  );

  return rows.map((r) => ({
    locationId: r.location_id,
    locationName: r.location_name,
    locationPath: r.location_path,
    projectId: r.project_id,
    projectName: r.project_name,
    onHand: Number(r.on_hand),
    minQty: r.min_qty === null ? null : Number(r.min_qty),
    lastMovementAt: r.last_movement_at ? new Date(r.last_movement_at) : null,
  }));
}

/**
 * The single write path. Inserts one row and returns it.
 *
 * Refuses anything that would leave on-hand negative, because stock going below
 * zero means the ledger no longer describes physical reality — and the whole
 * design rests on it doing exactly that.
 */
export async function recordMovement(
  db: Database,
  input: RecordMovementInput,
): Promise<Movement> {
  const { componentId, locationId, qtyDelta, reason } = input;

  if (!Number.isInteger(qtyDelta)) {
    throw new LedgerError(
      "Quantity must be a whole number of pieces.",
      "ZERO_DELTA",
    );
  }
  if (qtyDelta === 0) {
    throw new LedgerError("A movement of zero changes nothing.", "ZERO_DELTA");
  }

  if ((reason === "receipt" || reason === "return") && qtyDelta < 0) {
    throw new LedgerError(
      `A ${reason} must add stock, not remove it.`,
      "WRONG_DIRECTION",
    );
  }
  if (reason === "issue" && qtyDelta > 0) {
    throw new LedgerError(
      "Taking a part out must remove stock, not add it.",
      "WRONG_DIRECTION",
    );
  }

  return db.transaction(async (tx) => {
    await lockStockLine(tx, componentId, locationId);

    if (qtyDelta < 0) {
      const available = await getOnHand(tx, componentId, locationId);
      if (available + qtyDelta < 0) {
        throw new LedgerError(
          available === 0
            ? "There is none of this part left at this location."
            : `Only ${available} left at this location.`,
          "INSUFFICIENT_STOCK",
          available,
        );
      }
    }

    const [row] = await tx
      .insert(stockMovements)
      .values({
        componentId,
        locationId,
        qtyDelta,
        reason,
        userId: input.userId,
        orderLineId: input.orderLineId ?? null,
        reversesMovementId: input.reversesMovementId ?? null,
        note: input.note ?? null,
      })
      .returning();

    return row;
  });
}

/**
 * Undo, the only way it is ever done: append a `reversal` carrying the inverse
 * delta and pointing back at the original. The original row is left exactly as
 * it was, so the log still shows what happened and that it was undone.
 */
export async function reverseMovement(
  db: Database,
  movementId: string,
  userId: string,
  note?: string,
): Promise<Movement> {
  return db.transaction(async (tx) => {
    const [original] = await tx
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.id, movementId));

    if (!original) {
      throw new LedgerError("That movement no longer exists.", "NOT_FOUND");
    }

    if (original.reason === "reversal") {
      throw new LedgerError(
        "A reversal cannot itself be undone. Record a new movement instead.",
        "NOT_REVERSIBLE",
      );
    }

    const [existing] = await tx
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(eq(stockMovements.reversesMovementId, movementId));

    if (existing) {
      throw new LedgerError(
        "This movement has already been undone.",
        "ALREADY_REVERSED",
      );
    }

    await lockStockLine(tx, original.componentId, original.locationId);

    const inverse = -original.qtyDelta;

    // Undoing a receipt after the parts were issued out would drive the
    // location negative. Better to say so plainly than to let the ledger record
    // an impossibility.
    if (inverse < 0) {
      const available = await getOnHand(
        tx,
        original.componentId,
        original.locationId,
      );
      if (available + inverse < 0) {
        throw new LedgerError(
          `Cannot undo this: it would leave ${available + inverse} in stock. ` +
            `${original.qtyDelta} came in but only ${available} ${available === 1 ? "is" : "are"} still here.`,
          "INSUFFICIENT_STOCK",
          available,
        );
      }
    }

    const [row] = await tx
      .insert(stockMovements)
      .values({
        componentId: original.componentId,
        locationId: original.locationId,
        qtyDelta: inverse,
        reason: "reversal",
        userId,
        reversesMovementId: original.id,
        note: note ?? null,
      })
      .returning();

    return row;
  });
}

/** Ids of movements that already have a reversal, for striking them through. */
export async function findReversedMovementIds(
  db: Executor,
  movementIds: string[],
): Promise<Set<string>> {
  if (movementIds.length === 0) return new Set();

  const rows = await runQuery<{ reverses_movement_id: string }>(
    db,
    sql`
      SELECT reverses_movement_id
      FROM stock_movements
      WHERE reverses_movement_id = ANY(${sql.param(movementIds)}::uuid[])
    `,
  );

  return new Set(rows.map((r) => r.reverses_movement_id));
}

/**
 * Stocktake correction: "the shelf actually holds N".
 *
 * Takes the target count rather than a delta, and works out the difference
 * inside the locked transaction. Computing the delta in the browser would race
 * — two admins correcting the same bin from a stale reading would each apply
 * their own difference and the second would overshoot.
 */
export async function adjustToCount(
  db: Database,
  args: {
    componentId: string;
    locationId: string;
    targetCount: number;
    userId: string;
    note: string;
  },
): Promise<Movement> {
  if (!Number.isInteger(args.targetCount) || args.targetCount < 0) {
    throw new LedgerError(
      "Enter a whole number of pieces, zero or more.",
      "ZERO_DELTA",
    );
  }

  return db.transaction(async (tx) => {
    await lockStockLine(tx, args.componentId, args.locationId);

    const current = await getOnHand(tx, args.componentId, args.locationId);
    const delta = args.targetCount - current;

    if (delta === 0) {
      throw new LedgerError(
        `The count is already ${current}.`,
        "ZERO_DELTA",
        current,
      );
    }

    const [row] = await tx
      .insert(stockMovements)
      .values({
        componentId: args.componentId,
        locationId: args.locationId,
        qtyDelta: delta,
        reason: "adjustment",
        userId: args.userId,
        note: args.note,
      })
      .returning();

    return row;
  });
}

/** Convenience wrapper for the take-out flow. `qty` is a positive count. */
export async function issueStock(
  db: Database,
  args: {
    componentId: string;
    locationId: string;
    qty: number;
    userId: string;
    note?: string;
  },
): Promise<Movement> {
  if (!Number.isInteger(args.qty) || args.qty <= 0) {
    throw new LedgerError(
      "Enter a whole number of pieces, at least 1.",
      "ZERO_DELTA",
    );
  }
  return recordMovement(db, {
    componentId: args.componentId,
    locationId: args.locationId,
    qtyDelta: -args.qty,
    reason: "issue",
    userId: args.userId,
    note: args.note,
  });
}
