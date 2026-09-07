import {
  SMART_COLLECTION_STARTERS,
  smartCollectionDefinition,
  smartCollectionRule,
  type SmartCollectionDefinition,
} from "@cubby/schemas/collection";
import { describe, expect, it } from "vitest";

import {
  evaluateSmartCollections,
  type SmartCollectionGraph,
} from "./smart-collection-membership";

const graph: SmartCollectionGraph = {
  products: [
    { id: "brush", manufacturer: "  FESTOOL ", tags: ["collection:painting"] },
    { id: "vessel", manufacturer: "Other", tags: [] },
    { id: "measure", manufacturer: "Other", tags: [] },
    {
      id: "unplaced",
      manufacturer: "Festoolish",
      tags: ["Collection:painting"],
    },
  ],
  locations: [
    { id: "root", name: "Glue and PAINT", parentId: null, productId: null },
    { id: "bin", name: "Measuring bin", parentId: "root", productId: "vessel" },
  ],
  inventory: [
    { productId: "brush", locationId: "bin" },
    { productId: "brush", locationId: "root" },
    { productId: "brush", locationId: "bin" },
    { productId: "measure", locationId: "bin" },
    { productId: "vessel", locationId: "bin" },
  ],
  expenses: [{ productId: "brush", shortcode: "EXP-TEST", trade: "finishes" }],
};

describe("smart Collection predicates", () => {
  it("validates starters and rejects unsupported, blank, and malformed rules", () => {
    for (const starter of SMART_COLLECTION_STARTERS)
      expect(smartCollectionDefinition.safeParse(starter).success).toBe(true);
    expect(
      smartCollectionRule.safeParse({
        kind: "locationNameContains",
        value: "   ",
      }).success,
    ).toBe(false);
    expect(
      smartCollectionRule.safeParse({
        kind: "manufacturerEquals",
        value: "Example",
        regex: true,
      }).success,
    ).toBe(false);
    expect(
      smartCollectionRule.safeParse({
        kind: "historicalExpenseTrade",
        value: "painting",
      }).success,
    ).toBe(false);
  });

  it("matches all starters through OR conditions, retaining every source without double counting", () => {
    const [painting, measuring, festool] = evaluateSmartCollections(
      graph,
      SMART_COLLECTION_STARTERS,
    );
    expect(painting?.summary).toMatchObject({
      totalCount: 2,
      sourceCounts: {
        productTagEquals: 1,
        historicalExpenseTrade: 1,
        locationNameContains: 2,
        manufacturerEquals: 0,
      },
    });
    expect(painting?.members.get("brush")?.map((match) => match.kind)).toEqual([
      "historicalExpenseTrade",
      "locationNameContains",
      "productTagEquals",
    ]);
    expect(
      painting?.members
        .get("brush")
        ?.find((match) => match.kind === "locationNameContains")?.evidence,
    ).toHaveLength(2);
    expect(measuring?.summary.totalCount).toBe(2);
    expect(festool?.summary.totalCount).toBe(1);
    expect(festool?.members.has("unplaced")).toBe(false);
  });

  it("does not inherit through a vessel's own self-placement but permits independent evidence", () => {
    const definition: SmartCollectionDefinition = {
      key: "painting",
      name: "Vessel",
      rules: [{ kind: "locationNameContains", value: "paint" }],
    };
    expect(
      evaluateSmartCollections(graph, [definition])[0]?.members.has("vessel"),
    ).toBe(false);
    const independentlyPlaced = {
      ...graph,
      inventory: [
        ...graph.inventory,
        { productId: "vessel", locationId: "root" },
      ],
    };
    expect(
      evaluateSmartCollections(independentlyPlaced, [
        definition,
      ])[0]?.members.has("vessel"),
    ).toBe(true);
  });

  it("matches nothing with no rules and terminates on cycles or missing ancestors", () => {
    expect(
      evaluateSmartCollections(graph, [
        { key: "painting", name: "Empty", rules: [] },
      ])[0]?.summary.totalCount,
    ).toBe(0);
    const cyclic = {
      ...graph,
      locations: graph.locations.map((location) => ({
        ...location,
        parentId: location.id === "root" ? "bin" : "root",
      })),
    };
    expect(
      evaluateSmartCollections(cyclic, SMART_COLLECTION_STARTERS)[0]?.summary
        .totalCount,
    ).toBe(2);
    const missing = {
      ...graph,
      locations: graph.locations.map((location) => ({
        ...location,
        parentId: "missing",
      })),
    };
    expect(
      evaluateSmartCollections(missing, SMART_COLLECTION_STARTERS)[0]?.summary
        .totalCount,
    ).toBe(1);
  });
});
