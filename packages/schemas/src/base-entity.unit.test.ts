import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deriveUpdateData } from "./base-entity";
import { productUpdateData } from "./product";

describe("deriveUpdateData", () => {
  const createShape = {
    name: z.string().min(1),
    tags: z.array(z.string()).default([]),
    count: z.number(),
    serverField: z.string(),
  };

  it("makes every required create field optional", () => {
    const schema = deriveUpdateData(createShape);
    // Omitting all fields parses cleanly — nothing is required on update.
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ name: "x", count: 1 })).toEqual({
      name: "x",
      count: 1,
    });
  });

  it("strips create-time defaults so an omitted field stays undefined", () => {
    // The core guard: a naive `.partial()` keeps `.default([])`, so omitting
    // `tags` on update would coerce to [] and wipe the existing rows.
    const schema = deriveUpdateData(createShape);
    expect(schema.parse({}).tags).toBeUndefined();
    // An explicit value still passes through.
    expect(schema.parse({ tags: ["a"] }).tags).toEqual(["a"]);
  });

  it("adds update-only fields via `extend`", () => {
    const schema = deriveUpdateData(createShape, {
      extend: { removeIds: z.array(z.uuid()).optional() },
    });
    const id = "00000000-0000-0000-0000-000000000000";
    expect(schema.parse({ removeIds: [id] }).removeIds).toEqual([id]);
  });

  it("drops server-managed fields via `omit`", () => {
    const schema = deriveUpdateData(createShape, { omit: ["serverField"] });
    // The field is gone from the shape (strict-style: not in output).
    expect("serverField" in schema.shape).toBe(false);
    expect("name" in schema.shape).toBe(true);
  });
});

// Real-world regression: the product update path must not reset array columns
// when their keys are omitted (this is what the destructive-default trap would
// silently do). Guards the deriveUpdateData wiring for the most dangerous case.
describe("productUpdateData destructive-default guard", () => {
  it("leaves unitMappings/externalIds/aliases/tags undefined when omitted", () => {
    const parsed = productUpdateData.parse({ name: "Renamed" });
    expect(parsed.name).toBe("Renamed");
    expect(parsed.unitMappings).toBeUndefined();
    expect(parsed.externalIds).toBeUndefined();
    expect(parsed.aliases).toBeUndefined();
    expect(parsed.tags).toBeUndefined();
  });
});
