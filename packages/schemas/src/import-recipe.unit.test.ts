import { describe, expect, it } from "vitest";

import {
  chunkResponseOut,
  cookbookReprocessEventSchema,
} from "./import-recipe";

describe("chunkResponseOut", () => {
  it("accepts the detailed response envelope", () => {
    expect(
      chunkResponseOut.parse({
        input: { recipes: [{ name: "Weeknight soup" }] },
        usage: {
          input_tokens: 42,
          output_tokens: 12,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 0,
        },
        truncated: false,
      }),
    ).toEqual({
      input: { recipes: [{ name: "Weeknight soup" }] },
      usage: {
        input_tokens: 42,
        output_tokens: 12,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 0,
      },
      truncated: false,
    });
  });

  it("requires explicit failure classification and JSON input", () => {
    expect(
      chunkResponseOut.safeParse({
        input: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        truncated: true,
        error: { message: "cut off", kind: "payload" },
      }).success,
    ).toBe(true);
    expect(
      chunkResponseOut.safeParse({
        input: new Date(),
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        truncated: false,
      }).success,
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
