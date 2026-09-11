import type { CookbookExtraction } from "@cubby/schemas/cookbook";
import { describe, expect, it } from "vitest";

import {
  addWithDependencies,
  dependencyEdges,
  flattenRecipes,
  topoOrder,
} from "./cookbook-graph";

const recipe = (id: string, name: string) => ({
  kind: "recipe" as const,
  id,
  title: name,
  name,
  meta: { description: [], equipment: [] },
  sections: [],
  photos: [],
  notes: [],
  span: { start: 0, end: 1, doc_path: "c.xhtml" },
});

const book: CookbookExtraction = {
  contract: "cookbook-indexed-v1",
  source: {
    label: "book",
    sha256: "x",
    title: "Book",
    authors: [],
    identifiers: [],
    subjects: [],
  },
  chapters: [
    {
      id: "ch01",
      title: "Pies",
      items: [
        recipe("001.0001", "Apple Pie"),
        {
          kind: "essay",
          id: "001.0040",
          title: "On butter",
          name: "On butter",
          photos: [],
          span: { start: 40, end: 41, doc_path: "c.xhtml" },
        },
        recipe("001.0050", "Pie Dough"),
      ],
    },
    {
      id: "ch02",
      title: "Basics",
      items: [recipe("002.0001", "Crème Fraîche"), recipe("002.0020", "Stock")],
    },
  ],
  edges: [
    { from: "001.0001", to: "001.0050", kind: "ingredient", method: "anchor" },
    { from: "001.0050", to: "002.0001", kind: "ingredient", method: "title" },
    { from: "002.0001", to: "001.0001", kind: "step", method: "title" },
    { from: "002.0020", to: "002.0001", kind: "note", method: "page" },
  ],
};

describe("cookbook graph", () => {
  it("flattens recipes with their chapters and keeps only dependency edges", () => {
    expect(flattenRecipes(book).map((f) => [f.recipe.name, f.chapter])).toEqual(
      [
        ["Apple Pie", "Pies"],
        ["Pie Dough", "Pies"],
        ["Crème Fraîche", "Basics"],
        ["Stock", "Basics"],
      ],
    );
    expect(dependencyEdges(book).map((e) => `${e.from}->${e.to}`)).toEqual([
      "001.0001->001.0050",
      "001.0050->002.0001",
    ]);
  });

  it("selecting a recipe pulls in its sub-recipes transitively", () => {
    const selected = new Set<string>();
    addWithDependencies(book, selected, "001.0001");
    expect([...selected].sort()).toEqual(["001.0001", "001.0050", "002.0001"]);
  });

  it("orders dependencies before dependents and tolerates cycles", () => {
    expect(topoOrder(book, ["001.0001", "001.0050", "002.0001"])).toEqual([
      "002.0001",
      "001.0050",
      "001.0001",
    ]);
    // An unselected dependency does not block its dependent.
    expect(topoOrder(book, ["001.0001", "002.0020"])).toEqual([
      "001.0001",
      "002.0020",
    ]);
    const cyclic: CookbookExtraction = {
      ...book,
      edges: [
        {
          from: "001.0001",
          to: "001.0050",
          kind: "ingredient",
          method: "anchor",
        },
        {
          from: "001.0050",
          to: "001.0001",
          kind: "variation",
          method: "title",
        },
      ],
    };
    expect(topoOrder(cyclic, ["001.0050", "001.0001"])).toEqual([
      "001.0001",
      "001.0050",
    ]);
  });
});
