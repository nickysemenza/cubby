import type { ProductId } from "@cubby/schemas/identifiers";
import { testEntityId } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  findMergeComponentCycle,
  planProductComponentMerge,
  planUnitMappingFold,
} from "./merge";

/**
 * The kit-graph half of `mergeProducts` is decidable from the edge set alone,
 * so it lives here rather than behind a real merge: the cases that matter most
 * (a corrupt pre-existing cycle, a three-hop descendant chain) are awkward to
 * seed through the write path that exists precisely to prevent them.
 */
const p = (name: string): ProductId =>
  testEntityId("product", `00000000-0000-4000-8000-${name.padStart(12, "0")}`);

const edge = (parent: ProductId, component: ProductId) => ({
  parentProductId: parent,
  componentProductId: component,
});

const row = (
  id: string,
  parent: ProductId,
  component: ProductId,
  quantity: number,
) => ({
  id,
  parentProductId: parent,
  componentProductId: component,
  quantity,
});

const KIT = p("1");
const PART = p("2");
const SUB = p("3");
const OTHER = p("4");
const STRAY_A = p("5");
const STRAY_B = p("6");

describe("findMergeComponentCycle", () => {
  it("passes a merge that touches no kit at all", () => {
    expect(
      findMergeComponentCycle({
        edges: [edge(KIT, PART)],
        keepId: STRAY_A,
        loserIds: [STRAY_B],
      }),
    ).toBeNull();
  });

  it("blocks folding a kit into a part it directly contains", () => {
    const cycle = findMergeComponentCycle({
      edges: [edge(KIT, PART)],
      keepId: KIT,
      loserIds: [PART],
    });
    expect(cycle).toEqual([KIT, KIT]);
  });

  it("blocks the same pair merged the other way round", () => {
    expect(
      findMergeComponentCycle({
        edges: [edge(KIT, PART)],
        keepId: PART,
        loserIds: [KIT],
      }),
    ).toEqual([PART, PART]);
  });

  it("blocks a descendant three hops down, not just a direct component", () => {
    const cycle = findMergeComponentCycle({
      edges: [edge(KIT, PART), edge(PART, SUB), edge(SUB, OTHER)],
      keepId: KIT,
      loserIds: [OTHER],
    });
    expect(cycle).toEqual([KIT, PART, SUB, KIT]);
  });

  it("blocks a loop that only closes once two acyclic edge sets are unioned", () => {
    // KIT → PART is fine on its own; OTHER → SUB is fine on its own. Merging
    // OTHER into PART identifies the two nodes and closes KIT → PART → KIT.
    const cycle = findMergeComponentCycle({
      edges: [edge(KIT, PART), edge(OTHER, KIT)],
      keepId: PART,
      loserIds: [OTHER],
    });
    expect(cycle).toEqual([PART, KIT, PART]);
  });

  it("terminates on a pre-existing cycle downstream instead of spinning", () => {
    // STRAY_A ⇄ STRAY_B is already corrupt data; the merge below neither
    // creates nor is implicated in it, and the walk must still finish.
    expect(
      findMergeComponentCycle({
        edges: [
          edge(KIT, STRAY_A),
          edge(STRAY_A, STRAY_B),
          edge(STRAY_B, STRAY_A),
        ],
        keepId: KIT,
        loserIds: [OTHER],
      }),
    ).toBeNull();
  });

  it("finds the back-edge even when a shorter path reached the node first", () => {
    // SUB is discovered via PART (no way back), then again via OTHER; the
    // visited set must not suppress SUB's own edge back to the survivor.
    const cycle = findMergeComponentCycle({
      edges: [edge(KIT, PART), edge(PART, SUB), edge(SUB, KIT)],
      keepId: KIT,
      loserIds: [],
    });
    expect(cycle?.at(0)).toBe(KIT);
    expect(cycle?.at(-1)).toBe(KIT);
  });
});

describe("planProductComponentMerge", () => {
  it("moves a merged kit's component list onto the survivor", () => {
    const plan = planProductComponentMerge({
      keepId: KIT,
      loserIds: [OTHER],
      rows: [row("a", OTHER, PART, 2)],
    });
    expect(plan.cycle).toBeNull();
    expect(plan.kit.repoint.map((r) => r.id)).toEqual(["a"]);
    expect(plan.kit.dedupe).toEqual([]);
    expect(plan.kit.conflicts).toEqual([]);
  });

  it("dedupes a component both kits list at the same quantity", () => {
    const plan = planProductComponentMerge({
      keepId: KIT,
      loserIds: [OTHER],
      rows: [row("keep", KIT, PART, 4), row("lose", OTHER, PART, 4)],
    });
    expect(plan.kit.repoint).toEqual([]);
    expect(plan.kit.dedupe.map((r) => r.id)).toEqual(["lose"]);
    expect(plan.kit.conflicts).toEqual([]);
  });

  it("reports a conflict when the two kits disagree on how many", () => {
    const plan = planProductComponentMerge({
      keepId: KIT,
      loserIds: [OTHER],
      rows: [row("keep", KIT, PART, 4), row("lose", OTHER, PART, 3)],
    });
    expect(plan.kit.dedupe).toEqual([]);
    expect(plan.kit.conflicts).toHaveLength(1);
    expect(plan.kit.conflicts[0]?.into.id).toBe("keep");
    expect(plan.kit.conflicts[0]?.rows.map((r) => r.id)).toEqual(["lose"]);
  });

  it("groups two losers on one slot so a caller sums or refuses once", () => {
    const plan = planProductComponentMerge({
      keepId: PART,
      loserIds: [STRAY_A, STRAY_B],
      rows: [
        row("keep", KIT, PART, 2),
        row("a", KIT, STRAY_A, 3),
        row("b", KIT, STRAY_B, 4),
      ],
    });
    expect(plan.part.repoint).toEqual([]);
    expect(plan.part.absorb).toHaveLength(1);
    expect(plan.part.absorb[0]?.into.id).toBe("keep");
    expect(plan.part.absorb[0]?.rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("leaves rows naming no merged product out of both plans", () => {
    const plan = planProductComponentMerge({
      keepId: KIT,
      loserIds: [OTHER],
      rows: [row("unrelated", STRAY_A, STRAY_B, 1)],
    });
    expect(plan.kit.repoint).toEqual([]);
    expect(plan.part.repoint).toEqual([]);
    expect(plan.part.absorb).toEqual([]);
  });

  it("keeps a row whose two ends both merge out of the fold plans", () => {
    const plan = planProductComponentMerge({
      keepId: KIT,
      loserIds: [PART],
      rows: [row("self", KIT, PART, 1)],
    });
    expect(plan.cycle).toEqual([KIT, KIT]);
    expect(plan.kit.repoint).toEqual([]);
    expect(plan.kit.dedupe).toEqual([]);
    expect(plan.part.repoint).toEqual([]);
  });
});

/**
 * The conversion-edge fold is pure, and its inputs are awkward to seed through
 * a real merge (two products each already holding a density), so it is tested
 * directly — the same reason the kit-graph planner is exported.
 *
 * `ProductUnitMappings` carries no unique index, so before this fold nothing
 * refused the duplicate: a merge simply left the survivor holding two answers
 * for one conversion, and which one a valuation used came down to row order.
 */
const mapping = (
  id: string,
  productId: ProductId,
  a: [number, string],
  b: [number, string],
  source: string | null = null,
) => ({
  id,
  productId,
  a: { value: a[0], unit: a[1] },
  b: { value: b[0], unit: b[1] },
  source,
});

describe("planUnitMappingFold", () => {
  it("re-points an edge whose unit pair the survivor does not state", () => {
    const plan = planUnitMappingFold({
      keeperRows: [mapping("keep", KIT, [1, "ml"], [0.92, "g"])],
      loserRows: [mapping("lose", OTHER, [1, "whole"], [750, "ml"])],
    });
    expect(plan.repoint.map((r) => r.id)).toEqual(["lose"]);
    expect(plan.absorbed).toEqual([]);
  });

  it("dedupes an identical edge without reporting it as a discard", () => {
    const plan = planUnitMappingFold({
      keeperRows: [mapping("keep", KIT, [1, "ml"], [0.92, "g"])],
      loserRows: [mapping("lose", OTHER, [1, "ml"], [0.92, "g"])],
    });
    expect(plan.repoint).toEqual([]);
    expect(plan.absorbed).toHaveLength(1);
    expect(plan.absorbed[0]?.redundant).toBe(true);
  });

  it("treats the same edge stated in reverse as one slot", () => {
    const plan = planUnitMappingFold({
      keeperRows: [mapping("keep", KIT, [1, "ml"], [0.92, "g"])],
      loserRows: [mapping("lose", OTHER, [1, "g"], [1 / 0.92, "ml"])],
    });
    expect(plan.repoint).toEqual([]);
    expect(plan.absorbed[0]?.redundant).toBe(true);
  });

  it("dedupes the same ratio expressed at a different scale", () => {
    const plan = planUnitMappingFold({
      keeperRows: [mapping("keep", KIT, [1, "ml"], [0.92, "g"])],
      loserRows: [mapping("lose", OTHER, [1000, "ml"], [920, "g"])],
    });
    expect(plan.absorbed[0]?.redundant).toBe(true);
  });

  it("flags a disagreeing ratio as a conflict, the keeper's edge standing", () => {
    const plan = planUnitMappingFold({
      keeperRows: [mapping("keep", KIT, [1, "ml"], [0.92, "g"])],
      loserRows: [mapping("lose", OTHER, [1, "ml"], [0.9, "g"], "unk")],
    });
    expect(plan.repoint).toEqual([]);
    expect(plan.absorbed).toHaveLength(1);
    expect(plan.absorbed[0]?.redundant).toBe(false);
    expect(plan.absorbed[0]?.into.id).toBe("keep");
    expect(plan.absorbed[0]?.row.id).toBe("lose");
  });

  it("normalizes unit case and whitespace into one slot", () => {
    const plan = planUnitMappingFold({
      keeperRows: [mapping("keep", KIT, [1, "ML"], [0.92, " g "])],
      loserRows: [mapping("lose", OTHER, [1, "ml"], [0.9, "g"])],
    });
    expect(plan.absorbed).toHaveLength(1);
    expect(plan.absorbed[0]?.redundant).toBe(false);
  });

  it("never silently dedupes a degenerate zero-valued edge", () => {
    // Its ratio is undefined, so it cannot be shown equal to anything.
    // Reporting is the safe direction; dropping it quietly would hide a bad row.
    const plan = planUnitMappingFold({
      keeperRows: [mapping("keep", KIT, [1, "ml"], [0.92, "g"])],
      loserRows: [mapping("lose", OTHER, [0, "ml"], [0, "g"])],
    });
    expect(plan.absorbed[0]?.redundant).toBe(false);
  });

  it("leaves unrelated edges alone", () => {
    const plan = planUnitMappingFold({
      keeperRows: [mapping("keep", KIT, [1, "ml"], [0.92, "g"])],
      loserRows: [
        mapping("a", OTHER, [1, "each"], [32, "oz"]),
        mapping("b", OTHER, [1, "cup"], [237, "ml"]),
      ],
    });
    expect(plan.repoint.map((r) => r.id)).toEqual(["a", "b"]);
    expect(plan.absorbed).toEqual([]);
  });

  it("folds two losers colliding with each other, not just with the keeper", () => {
    const plan = planUnitMappingFold({
      keeperRows: [],
      loserRows: [
        mapping("first", OTHER, [1, "ml"], [0.92, "g"]),
        mapping("second", OTHER, [1, "ml"], [0.9, "g"]),
      ],
    });
    expect(plan.repoint.map((r) => r.id)).toEqual(["first"]);
    expect(plan.absorbed).toHaveLength(1);
    expect(plan.absorbed[0]?.row.id).toBe("second");
    expect(plan.absorbed[0]?.redundant).toBe(false);
  });
});
