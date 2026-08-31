import { describe, expect, it } from "vitest";

import { findDirectedDependencyCycles } from "./dependency-graph";

describe("findDirectedDependencyCycles", () => {
  it("returns no path for an acyclic graph", () => {
    expect(
      findDirectedDependencyCycles([
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ]),
    ).toEqual([]);
  });

  it("returns one stable closed path per cyclic component", () => {
    expect(
      findDirectedDependencyCycles([
        { from: "b", to: "c" },
        { from: "c", to: "a" },
        { from: "a", to: "b" },
        { from: "x", to: "x" },
      ]),
    ).toEqual([
      ["a", "b", "c", "a"],
      ["x", "x"],
    ]);
  });
});
