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
 */

/**
 * The keeper/loser split for one slotted edge.
 *
 * `into` on an absorbed row is the row already holding that slot — the keeper's
 * own row when it had one, otherwise the first loser row that claimed it.
 */
interface SlotCollisionPlan<Row> {
  /** Loser rows whose slot is free — safe to re-point onto the survivor. */
  repoint: Row[];
  /** Loser rows whose slot is taken. The caller decides how to fold each. */
  absorb: Array<{ row: Row; into: Row }>;
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
    } else {
      plan.absorb.push({ row, into: held });
    }
  }
  return plan;
};
