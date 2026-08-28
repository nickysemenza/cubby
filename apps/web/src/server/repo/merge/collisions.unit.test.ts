import { describe, expect, it } from "vitest";

import { planSlotCollisions } from "./collisions";

type Row = { id: string; slot: string | null };
const plan = (keeperRows: Row[], loserRows: Row[]) =>
  planSlotCollisions({ keeperRows, loserRows, slotKey: (row) => row.slot });

/**
 * The partial-unique-index split every merge with a slotted edge depends on.
 * Getting it wrong doesn't produce a subtly wrong number — the index aborts the
 * transaction — so the rules are worth pinning down away from a database.
 */
describe("planSlotCollisions", () => {
  it("re-points a loser whose slot the keeper does not hold", () => {
    const result = plan([{ id: "k1", slot: "a" }], [{ id: "l1", slot: "b" }]);
    expect(result.repoint.map((r) => r.id)).toEqual(["l1"]);
    expect(result.absorb).toEqual([]);
  });

  it("absorbs a loser into the keeper's row when the slot is taken", () => {
    const result = plan([{ id: "k1", slot: "a" }], [{ id: "l1", slot: "a" }]);
    expect(result.repoint).toEqual([]);
    expect(result.absorb).toEqual([
      { into: { id: "k1", slot: "a" }, rows: [{ id: "l1", slot: "a" }] },
    ]);
  });

  // Resolution is over the WHOLE merge set: two losers colliding with each
  // other break the index just as surely as one colliding with the keeper, and
  // a pairwise keeper-vs-loser check would miss it entirely.
  it("resolves losers against each other, first claimant winning", () => {
    const result = plan(
      [],
      [
        { id: "l1", slot: "a" },
        { id: "l2", slot: "a" },
        { id: "l3", slot: "a" },
      ],
    );
    expect(result.repoint.map((r) => r.id)).toEqual(["l1"]);
    // ONE group, both rows in it — not two entries pointing at the same `into`.
    // That shape is what stops a caller folding data from reading the unmutated
    // target twice and overwriting instead of accumulating.
    expect(
      result.absorb.map(({ into, rows }) => [into.id, rows.map((r) => r.id)]),
    ).toEqual([["l1", ["l2", "l3"]]]);
  });

  // A partial unique index doesn't constrain rows whose key is null, so two of
  // them are two real records — the same reason `mergeVendors` never folds an
  // order-less charge.
  it("never collides null slots", () => {
    const result = plan(
      [{ id: "k1", slot: null }],
      [
        { id: "l1", slot: null },
        { id: "l2", slot: null },
      ],
    );
    expect(result.repoint.map((r) => r.id)).toEqual(["l1", "l2"]);
    expect(result.absorb).toEqual([]);
  });
});
