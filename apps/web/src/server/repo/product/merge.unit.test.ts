import { type ProductId, unsafeProductId } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";
import { findMergeComponentCycle, planProductComponentMerge } from "./merge";

/**
 * The kit-graph half of `mergeProducts` is decidable from the edge set alone,
 * so it lives here rather than behind a real merge: the cases that matter most
 * (a corrupt pre-existing cycle, a three-hop descendant chain) are awkward to
 * seed through the write path that exists precisely to prevent them.
 */
const p = (name: string): ProductId =>
  unsafeProductId(`00000000-0000-4000-8000-${name.padStart(12, "0")}`);

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
    // Both ends collapse to the survivor, so this row IS the cycle — planning a
    // re-point for it would describe work the refusal is about to cancel.
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
