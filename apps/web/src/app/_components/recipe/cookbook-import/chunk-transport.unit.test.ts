import type { chunkResponseOut } from "@cubby/schemas/import-recipe";
import { afterEach, expect, it, vi } from "vitest";
import type { z } from "zod";

import { callChunkWithTransportRetry } from "./chunk-transport";

type Response = z.output<typeof chunkResponseOut>;
const usage = {
  input_tokens: 2,
  output_tokens: 3,
  cache_creation_input_tokens: 4,
  cache_read_input_tokens: 5,
};
const success: Response = { input: { recipes: [] }, usage, truncated: false };
afterEach(() => vi.useRealTimers());

it("retries transport errors and includes usage and truncation from failed responses", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const result = callChunkWithTransportRetry(async () => {
    calls++;
    return calls === 1
      ? {
          ...success,
          truncated: true,
          error: { kind: "transport", message: "Overloaded" },
        }
      : success;
  });
  await vi.runAllTimersAsync();
  expect(await result).toEqual({
    input: { recipes: [] },
    usage: {
      input_tokens: 4,
      output_tokens: 6,
      cache_creation_input_tokens: 8,
      cache_read_input_tokens: 10,
    },
    truncated: true,
  });
  expect(calls).toBe(2);
});

it("leaves malformed payload retries to upstream", async () => {
  let calls = 0;
  const response: Response = {
    ...success,
    input: null,
    error: { kind: "payload", message: "Invalid JSON" },
  };
  expect(
    await callChunkWithTransportRetry(async () => {
      calls++;
      return response;
    }),
  ).toEqual(response);
  expect(calls).toBe(1);
});

it("bounds failed network attempts and preserves known usage", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const result = callChunkWithTransportRetry(async () => {
    calls++;
    if (calls === 1)
      return {
        ...success,
        error: { kind: "transport", message: "Overloaded" },
      };
    throw new Error("Disconnected");
  });
  await vi.runAllTimersAsync();
  expect(await result).toEqual({
    input: null,
    usage,
    truncated: false,
    error: { kind: "transport", message: "Disconnected" },
  });
  expect(calls).toBe(3);
});
