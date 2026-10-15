import { describe, expect, it } from "vitest";

import { defineProblem, validateProblemQueries } from "./problem-query";

const entityProblem = defineProblem({
  key: "productsMissingPrice",
  problemClass: "defect",
  executionLane: "views",
  continuation: { kind: "entity-list" },
  freshness: { kind: "live" },
  title: "Missing price",
  description: "A product without a price",
  emptyMessage: "All priced",
  source: {
    kind: "entity" as const,
    entity: "product" as const,
    filters: [{ id: "price", value: "none-real" }],
  },
});

describe("Problem Query registry", () => {
  it("declares read-only action and presenter capabilities by default", () => {
    expect(entityProblem.actions).toEqual([]);
    expect(entityProblem.presenter).toEqual({
      key: "productsMissingPrice",
      detailRouting: "entity",
    });
  });

  it("rejects duplicate problem declarations", () => {
    expect(() =>
      validateProblemQueries([entityProblem, entityProblem]),
    ).toThrow('Duplicate Problem declaration "productsMissingPrice"');
  });

  it("requires derived problems to expose their operation", () => {
    expect(() =>
      defineProblem({
        key: "duplicateVendors",
        problemClass: "defect",
        executionLane: "fast",
        continuation: { kind: "none", reason: "groups" },
        freshness: { kind: "live" },
        title: "Duplicate vendors",
        description: "same normalized name",
        emptyMessage: "none",
        source: {
          kind: "derived" as const,
          diagnostic: "duplicate-vendors",
          grain: "group" as const,
          operations: [],
        },
      }),
    ).toThrow('Derived problem "duplicateVendors" must describe its operation');
  });
});
