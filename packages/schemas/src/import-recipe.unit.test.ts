import { describe, expect, it } from "vitest";

import {
  cookbookReprocessEventSchema,
  gatewayForwardInput,
  gatewayForwardOut,
  importRecipeSchema,
} from "./import-recipe";

describe("importRecipeSchema", () => {
  it("requires supplied parsed ingredients to align with raw lines", () => {
    const parsed = (name: string) => ({
      name,
      amounts: [],
      usage: "normal" as const,
      parse_notes: {
        confidence: "high" as const,
        fell_back: false,
        unparsed_digit: false,
      },
    });
    const recipe = {
      meta: { title: "Soup" },
      sections: [
        {
          ingredients: ["1 onion", "2 carrots"],
          parsedIngredients: [parsed("onion")],
          instructions: [],
        },
      ],
    };

    expect(importRecipeSchema.safeParse(recipe).success).toBe(false);
    expect(
      importRecipeSchema.safeParse({
        ...recipe,
        sections: [
          {
            ...recipe.sections[0],
            parsedIngredients: [parsed("onion"), parsed("carrot")],
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("gatewayForwardInput", () => {
  const request = {
    path: "/anthropic/v1/messages",
    headers: [["content-type", "application/json"]],
    body: { model: "claude-haiku-4-5", messages: [] },
  };

  it("accepts a complete gateway request built in Rust", () => {
    expect(gatewayForwardInput.parse(request)).toEqual(request);
    expect(
      gatewayForwardInput.safeParse({
        ...request,
        path: "/compat/chat/completions",
      }).success,
    ).toBe(true);
  });

  it("rejects paths that are not a gateway provider route", () => {
    for (const path of [
      "anthropic/v1/messages",
      "/anthropic",
      "/../accounts",
      "https://evil.example/anthropic/v1/messages",
      "/anthropic/v1/messages?x=1",
      "",
    ]) {
      expect(gatewayForwardInput.safeParse({ ...request, path }).success).toBe(
        false,
      );
    }
  });

  it("returns the provider response verbatim", () => {
    expect(
      gatewayForwardOut.parse({
        status: 429,
        headers: [["retry-after", "7"]],
        body: '{"error":"Wholesale Rate limited"}',
      }).status,
    ).toBe(429);
    expect(
      gatewayForwardOut.safeParse({ status: 42, headers: [], body: "" })
        .success,
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
