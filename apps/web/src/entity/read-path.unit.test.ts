import { describe, expect, it } from "vitest";

import { readPathValue } from "./read-path";

describe("readPathValue", () => {
  const row = {
    id: "PRD-2345",
    category: { path: [{ name: "Pantry" }, { name: "Baking" }] },
    sourceRefs: [{ source: "receipt" }, { other: 1 }, { source: "label" }],
  };

  it("reads keys, indexes, and projections", () => {
    expect(readPathValue(row, "id")).toBe("PRD-2345");
    expect(readPathValue(row, "category.path[1].name")).toBe("Baking");
    expect(readPathValue(row, "sourceRefs[].source")).toEqual([
      "receipt",
      "label",
    ]);
  });

  it("reads missing links as undefined", () => {
    expect(readPathValue(row, "category.missing.name")).toBeUndefined();
    expect(readPathValue(null, "id")).toBeUndefined();
    expect(readPathValue("PRD-2345", "length")).toBeUndefined();
  });

  // Key steps read only a plain object's own properties, as the `z.record`
  // parse they replaced did.
  it("does not read keys off arrays, class instances, or prototypes", () => {
    expect(readPathValue({ list: ["a"] }, "list.length")).toBeUndefined();
    expect(readPathValue({ at: new Date(0) }, "at.getTime")).toBeUndefined();
    expect(readPathValue({}, "toString")).toBeUndefined();
    expect(readPathValue(Object.create({ inherited: 1 }), "inherited")).toBe(
      undefined,
    );
  });
});
