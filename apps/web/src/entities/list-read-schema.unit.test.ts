import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compileListReadSchema } from "./list-read-schema";

describe("list field ownership", () => {
  const schema = z.object({
    id: z.string(),
    name: z.string(),
    price: z.number().nullable(),
    image: z.string().nullable(),
  });
  it("preserves explicit null and zero without inventing pending values", () => {
    const read = compileListReadSchema(schema, {
      derived: ["price"],
      media: ["image"],
    });
    expect(
      read.project(
        { id: "example", name: "Example", price: 0, image: null },
        "core",
      ),
    ).toEqual({ id: "example", name: "Example" });
    expect(read.project({ id: "example", price: 0 }, "derived")).toEqual({
      id: "example",
      price: 0,
    });
    expect(read.project({ id: "example", image: null }, "media")).toEqual({
      id: "example",
      image: null,
    });
  });
  it("rejects unowned schema fields, overlapping owners, and dependency cycles", () => {
    expect(() =>
      compileListReadSchema(schema, { derived: ["missing"] }),
    ).toThrow("Unknown list field");
    expect(() =>
      compileListReadSchema(schema, { media: ["price"], derived: ["price"] }),
    ).toThrow("multiple owners");
    expect(() =>
      compileListReadSchema(
        schema,
        { media: ["image"], derived: ["price"] },
        { media: ["derived"], derived: ["media"] },
      ),
    ).toThrow("cycle");
  });
});
