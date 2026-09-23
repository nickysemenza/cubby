import { describe, expect, it } from "vitest";

import { placeByBranch } from "./branch-confidence";

interface Node {
  id: string;
  parent: string | null;
}

const food: Node = { id: "food", parent: null };
const prepared: Node = { id: "prepared", parent: "food" };
const snacks: Node = { id: "snacks", parent: "food" };
const household: Node = { id: "household", parent: null };

const place = (
  distribution: [Node, number][],
  selected: Node,
  selectedProbability: number,
) =>
  placeByBranch({
    distribution: distribution.map(([candidate, probability]) => ({
      candidate,
      probability,
    })),
    selected,
    selectedProbability,
    threshold: 0.85,
    idOf: (n) => n.id,
    parentIdOf: (n) => n.parent,
  });

interface Case {
  name: string;
  distribution: [Node, number][];
  selected: Node;
  probability: number;
  expected: { id: string; probability: number } | null;
}

describe("placeByBranch", () => {
  it.each<Case>([
    {
      name: "keeps a confident pick as-is",
      distribution: [
        [prepared, 0.9],
        [food, 0.1],
      ],
      selected: prepared,
      probability: 0.9,
      expected: null,
    },
    {
      name: "rolls a split leaf up to the parent whose subtree clears the floor",
      distribution: [
        [prepared, 0.7],
        [food, 0.1],
        [snacks, 0.08],
        [household, 0.12],
      ],
      selected: prepared,
      probability: 0.7,
      expected: { id: "food", probability: 0.88 },
    },
    {
      name: "leaves the pick alone when no branch reaches the floor",
      distribution: [
        [prepared, 0.5],
        [household, 0.4],
        [food, 0.1],
      ],
      selected: prepared,
      probability: 0.5,
      expected: null,
    },
    {
      name: "raises a parent pick whose children carry the rest of the mass",
      distribution: [
        [food, 0.5],
        [prepared, 0.2],
        [snacks, 0.2],
        [household, 0.1],
      ],
      selected: food,
      probability: 0.5,
      expected: { id: "food", probability: 0.9 },
    },
  ])("$name", ({ distribution, selected, probability, expected }) => {
    const result = place(distribution, selected, probability);
    expect(
      result && {
        id: result.node.id,
        probability: Math.round(result.probability * 100) / 100,
      },
    ).toEqual(expected);
  });
});
