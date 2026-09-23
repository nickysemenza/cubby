import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { aiResponseCacheKey, withAiResponseCache } from "./response-cache";

const input = (name: string) => ({
  feature: "test",
  model: "test",
  promptVersion: "1",
  input: {
    state: name,
    questions: {
      selection: {
        type: "choice" as const,
        instructions: "Choose one.",
        criteria: { c0: "one", c1: "two" },
      },
    },
  },
});
const validate = z.object({ choice: z.string() }).parse;

describe("AI response cache", () => {
  it("keys the effective input while preserving choice order", async () => {
    const a = await aiResponseCacheKey(input("alpha"));
    const b = await aiResponseCacheKey({
      promptVersion: "1",
      model: "test",
      feature: "test",
      input: {
        questions: {
          selection: {
            criteria: { c1: "two", c0: "one" },
            instructions: "Choose one.",
            type: "choice",
          },
        },
        state: "alpha",
      },
    });
    expect(a).toBe(b);
    expect(
      await aiResponseCacheKey({ ...input("alpha"), effort: undefined }),
    ).toBe(a);
    expect(await aiResponseCacheKey(input("alpha"))).not.toBe(
      await aiResponseCacheKey({
        ...input("alpha"),
        input: {
          ...input("alpha").input,
          questions: {
            selection: {
              ...input("alpha").input.questions.selection,
              criteria: { c0: "two", c1: "one" },
            },
          },
        },
      }),
    );
    expect(
      await aiResponseCacheKey({ ...input("alpha"), promptVersion: "2" }),
    ).not.toBe(await aiResponseCacheKey(input("alpha")));
  });

  it("shares simultaneous work, reuses success, and refreshes when forced", async () => {
    const keyInput = input(crypto.randomUUID());
    let finish!: (value: { choice: string }) => void;
    const pending = new Promise<{ choice: string }>((resolve) => {
      finish = resolve;
    });
    const compute = vi.fn(async () => pending);
    const args = { enabled: true, keyInput, validate, compute };
    const first = withAiResponseCache(args);
    const second = withAiResponseCache(args);
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    finish({ choice: "one" });
    expect(await first).toEqual({ choice: "one" });
    expect(await second).toEqual({ choice: "one" });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(await withAiResponseCache(args)).toEqual({ choice: "one" });
    const refreshed = await withAiResponseCache({
      ...args,
      force: true,
      compute: async () => ({ choice: "two" }),
    });
    expect(refreshed).toEqual({ choice: "two" });
    expect(await withAiResponseCache(args)).toEqual({ choice: "two" });
  });

  it("does not retain failures or invalid answers", async () => {
    const keyInput = input(crypto.randomUUID());
    await expect(
      withAiResponseCache({
        enabled: true,
        keyInput,
        validate,
        compute: async () => {
          throw new Error("429");
        },
      }),
    ).rejects.toThrow("429");
    await expect(
      withAiResponseCache({
        enabled: true,
        keyInput,
        validate,
        compute: async () => JSON.parse('{"choice":7}'),
      }),
    ).rejects.toThrow("Invalid input: expected string");
    expect(
      await withAiResponseCache({
        enabled: true,
        keyInput,
        validate,
        compute: async () => ({ choice: "one" }),
      }),
    ).toEqual({ choice: "one" });
  });

  it("releases an oversized result so the next call can proceed", async () => {
    const keyInput = input(crypto.randomUUID());
    const huge = "x".repeat(1_000_001);
    expect(
      await withAiResponseCache({
        enabled: true,
        keyInput,
        validate,
        compute: async () => ({ choice: huge }),
      }),
    ).toEqual({ choice: huge });
    expect(
      await withAiResponseCache({
        enabled: true,
        keyInput,
        validate,
        compute: async () => ({ choice: "fresh" }),
      }),
    ).toEqual({ choice: "fresh" });
  });
});
