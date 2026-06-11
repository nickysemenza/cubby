import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import { describe, expect, it } from "vitest";
import { addWithReferences, topoOrderSelected } from "./import-order";

// Minimal ImportRecipe builder: a title plus the titles it references.
const r = (title: string, refs: string[] = []): ImportRecipe => ({
  meta: { title },
  sections: [{ ingredients: [], instructions: [] }],
  references: refs.map((t) => ({
    title: t,
    line: t,
    confidence: "title_match" as const,
  })),
});

describe("topoOrderSelected", () => {
  it("places a referenced recipe before the recipe that references it", () => {
    // index 0 (Galette) references index 1 (Piecrust).
    const recipes = [
      r("Apple Galette", ["The Only Piecrust"]),
      r("The Only Piecrust"),
    ];
    const order = topoOrderSelected(recipes, [0, 1]);
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(0));
  });

  it("orders a transitive chain leaves-first (C, B, A)", () => {
    // A→B→C
    const recipes = [r("A", ["B"]), r("B", ["C"]), r("C")];
    expect(topoOrderSelected(recipes, [0, 1, 2])).toEqual([2, 1, 0]);
  });

  it("ignores references to unselected recipes", () => {
    const recipes = [r("A", ["B"]), r("B")];
    // Only A selected — B isn't imported, so A is simply emitted.
    expect(topoOrderSelected(recipes, [0])).toEqual([0]);
  });

  it("includes every selected recipe exactly once even with a cycle", () => {
    // A↔B cycle plus an independent C.
    const recipes = [r("A", ["B"]), r("B", ["A"]), r("C")];
    const order = topoOrderSelected(recipes, [0, 1, 2]);
    expect([...order].sort((x, y) => x - y)).toEqual([0, 1, 2]);
  });
});

describe("addWithReferences", () => {
  it("adds referenced recipes transitively", () => {
    const recipes = [r("A", ["B"]), r("B", ["C"]), r("C"), r("D")];
    const selected = new Set<number>();
    addWithReferences(recipes, selected, 0);
    expect([...selected].sort((x, y) => x - y)).toEqual([0, 1, 2]);
  });

  it("does not pull in unrelated recipes", () => {
    const recipes = [r("A", ["B"]), r("B"), r("C")];
    const selected = new Set<number>();
    addWithReferences(recipes, selected, 2); // C references nothing
    expect([...selected]).toEqual([2]);
  });

  it("terminates on a reference cycle", () => {
    const recipes = [r("A", ["B"]), r("B", ["A"])];
    const selected = new Set<number>();
    addWithReferences(recipes, selected, 0);
    expect([...selected].sort((x, y) => x - y)).toEqual([0, 1]);
  });
});
