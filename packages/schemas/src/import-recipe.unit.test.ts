import { describe, expect, it } from "vitest";

import {
  chunkResponseOut,
  cookbookReprocessEventSchema,
} from "./import-recipe";

describe("chunkResponseOut", () => {
  it("accepts JSON response fields and rejects opaque runtime values", () => {
    expect(
      chunkResponseOut.parse({
        recipes: [{ name: "Weeknight soup" }],
        page: 2,
        complete: false,
      }),
    ).toEqual({
      recipes: [{ name: "Weeknight soup" }],
      page: 2,
      complete: false,
    });
    expect(
      chunkResponseOut.safeParse({ generatedAt: new Date() }).success,
    ).toBe(false);
  });
});

describe("cookbookReprocessEventSchema", () => {
  it("preserves the names of recipes that remain importable", () => {
    expect(
      cookbookReprocessEventSchema.parse({
        type: "done",
        result: {
          reprocessed: 3,
          importableExtras: ["Waffles", "Pancakes"],
        },
      }),
    ).toEqual({
      type: "done",
      result: {
        reprocessed: 3,
        importableExtras: ["Waffles", "Pancakes"],
      },
    });
  });

  it("rejects the former count-only contract", () => {
    expect(
      cookbookReprocessEventSchema.safeParse({
        type: "done",
        result: { reprocessed: 3, importableExtras: 2 },
      }).success,
    ).toBe(false);
  });
});
