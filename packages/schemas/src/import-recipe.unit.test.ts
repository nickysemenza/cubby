import { describe, expect, it } from "vitest";

import {
  cookbookReprocessEventSchema,
  gatewayForwardInput,
  gatewayForwardOut,
} from "./import-recipe";

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
