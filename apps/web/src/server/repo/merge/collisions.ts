/**
 * Slot-collision planning for merges.
 *
 * Most incoming edges re-point cleanly: change the FK, done. The interesting
 * ones sit under a *partial unique index* — `(vendorId, orderId)` on Purchase,
 * `(productId, locationId)` on InventoryEntry, `(productId, source, kind)` on
 * ProductExternalId — where two of the merged rows can occupy the same slot.
 * Blind re-pointing there doesn't produce a wrong answer, it aborts the whole
 * transaction on a constraint violation.
 *
 * Every one of those cases splits the same way: for each loser row, is the slot
 * free on the survivor, or already taken? That split is what this module owns.
 * **What to do with an absorbed row is deliberately NOT here** — summing
 * inventory quantities, carrying a URL onto the keeper's identifier row, and
 * dropping a duplicate wishlist candidate are three different domain decisions,
 * and a "generic absorb" would have to be one of them and be wrong about the
 * other two.
 *
 * The one absorb rule that IS general enough to live here is
 * {@link foldAssociation}'s: a pure join row where the row *is* the pair, so an
 * absorbed duplicate carries nothing to fold.
 */

import { inArray } from "drizzle-orm";
import type {
  AnyPgColumn,
  PgTable,
  PgUpdateSetSource,
} from "drizzle-orm/pg-core";

import type { DrizzleTransaction } from "~/server/db";

/**
 * The keeper/loser split for one slotted edge.
 *
 * `into` on an absorbed row is the row already holding that slot — the keeper's
 * own row when it had one, otherwise the first loser row that claimed it.
 */
export interface SlotCollisionPlan<Row> {
  /** Loser rows whose slot is free — safe to re-point onto the survivor. */
  repoint: Row[];
  /**
   * Loser rows whose slot is taken, GROUPED BY the row they fold into. The
   * caller decides how to fold each group.
   *
   * Grouped rather than flat (`{row, into}[]`) on purpose. A slot can take more
   * than one loser — keeper + two losers at one shelf — and a flat list hands
   * the same `into` object back twice. A caller folding DATA then reads the
   * never-mutated `into` on each pass and the last write wins instead of
   * accumulating: `2 + 3 + 4` persisted as `6`, silently losing a quantity in a
   * destructive operation. The group makes the many-to-one case impossible to
   * miss, so the caller sums `rows` once.
   */
  absorb: Array<{ into: Row; rows: Row[] }>;
}

/**
 * Partition loser rows into those that can simply re-point and those whose slot
 * is already occupied.
 *
 * Resolution is over the WHOLE merge set, not pairwise keeper-vs-loser: two
 * losers colliding with *each other* are just as fatal to the unique index as
 * one colliding with the keeper. The keeper's own row always wins its slot, so
 * ids the user can already see stay stable; among losers, the first row in
 * input order claims a free slot and later ones absorb into it.
 *
 * A `null` slot key means "cannot collide" and always re-points — the same
 * reason `mergeVendors` never folds an order-less charge: a partial unique
 * index doesn't constrain rows whose key is null, and two of them are two real
 * records.
 */
export const planSlotCollisions = <Row>(args: {
  keeperRows: readonly Row[];
  loserRows: readonly Row[];
  slotKey: (row: Row) => string | null;
}): SlotCollisionPlan<Row> => {
  const occupant = new Map<string, Row>();
  for (const row of args.keeperRows) {
    const key = args.slotKey(row);
    if (key !== null && !occupant.has(key)) occupant.set(key, row);
  }

  const plan: SlotCollisionPlan<Row> = { repoint: [], absorb: [] };
  const groupByTarget = new Map<Row, { into: Row; rows: Row[] }>();
  for (const row of args.loserRows) {
    const key = args.slotKey(row);
    if (key === null) {
      plan.repoint.push(row);
      continue;
    }
    const held = occupant.get(key);
    if (held === undefined) {
      occupant.set(key, row);
      plan.repoint.push(row);
      continue;
    }
    const group = groupByTarget.get(held);
    if (group) {
      group.rows.push(row);
    } else {
      const created = { into: held, rows: [row] };
      groupByTarget.set(held, created);
      plan.absorb.push(created);
    }
  }
  return plan;
};

/**
 * Re-point a pure association row onto one owner, soft-deleting the rows whose
 * slot that owner already fills. Returns how many actually moved.
 *
 * The join tables this covers (product↔image, product↔project, product↔purchase,
 * product↔wish) share an implementation because they share a *shape*, not just a
 * plan: the row IS the pair, so an absorbed duplicate carries nothing to fold
 * into its survivor. External ids and inventory look similar and are handled
 * separately precisely because their absorbed rows DO carry something (a url; a
 * quantity).
 *
 * Lives here rather than inside `mergeProducts` because a merge is not the only
 * operation that needs it: `repointProjectUses` moves a product's project-use
 * history without merging anything, and it faces the identical partial-unique-
 * index collision. A bare `UPDATE ... SET productId` — what `repointEdge` does
 * for the unslotted edges — aborts the whole transaction the moment the
 * destination already has a row in that slot.
 */
export const foldAssociation = async <
  Row extends { id: string },
  TTable extends PgTable & { id: AnyPgColumn },
  OwnerKey extends keyof Row,
>(
  tx: DrizzleTransaction,
  args: {
    table: TTable;
    /** Property name of the FK being re-pointed, e.g. `"productId"`. */
    column: OwnerKey;
    repointValues: (keepId: Row[OwnerKey]) => PgUpdateSetSource<TTable>;
    softDeleteValues: (now: Date) => PgUpdateSetSource<TTable>;
    rows: Row[];
    keepId: Row[OwnerKey];
    slotKey: (row: Row) => string;
    now: Date;
    /**
     * A caller-owned plan built from the same rows. Product merge uses this to
     * make its advisory presentation and transactional executor consume one
     * collision decision instead of independently re-planning the edge.
     */
    plan?: SlotCollisionPlan<Row>;
  },
): Promise<number> => {
  const plan =
    args.plan ??
    planSlotCollisions({
      keeperRows: args.rows.filter((row) => row[args.column] === args.keepId),
      loserRows: args.rows.filter((row) => row[args.column] !== args.keepId),
      slotKey: args.slotKey,
    });
  if (plan.repoint.length > 0) {
    await tx
      .update(args.table)
      .set(args.repointValues(args.keepId))
      .where(
        inArray(
          args.table.id,
          plan.repoint.map((row) => row.id),
        ),
      );
  }
  if (plan.absorb.length > 0) {
    await tx
      .update(args.table)
      .set(args.softDeleteValues(args.now))
      .where(
        inArray(
          args.table.id,
          plan.absorb.flatMap(({ rows }) => rows.map((row) => row.id)),
        ),
      );
  }
  return plan.repoint.length;
};
