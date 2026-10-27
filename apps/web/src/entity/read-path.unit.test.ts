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

  it("reads governed values and explicit empty outcomes through nested projections", () => {
    const envelope = {
      current: {
        assignment: null,
        controls: { kind: "readonly", reason: "computed" },
      },
      work: { kind: "idle" },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: [{ name: "Example" }] },
          provenance: { kind: "computed" },
        },
      },
    };
    const record = {
      fields: {
        contributors: envelope,
        empty: {
          ...envelope,
          result: {
            kind: "live",
            decision: {
              outcome: { kind: "empty", reason: "explicit_none" },
              provenance: null,
            },
          },
        },
      },
    };
    expect(readPathValue(record, "contributors[].name")).toEqual(["Example"]);
    expect(readPathValue(record, "empty")).toBeNull();
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

  it("reads what a z.record parse read: own getters, and objects with a plain constructor", () => {
    expect(
      readPathValue(
        {
          get name() {
            return "Example";
          },
        },
        "name",
      ),
    ).toBe("Example");
    expect(
      readPathValue(
        Object.assign(Object.create({}), { name: "Example" }),
        "name",
      ),
    ).toBe("Example");
    expect(
      readPathValue({ constructor: () => undefined, name: "Example" }, "name"),
    ).toBeUndefined();
  });
});
