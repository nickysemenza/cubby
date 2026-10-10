import { describe, expect, it } from "vitest";

import { recordResearchToolOutcome } from "./research-failure-bound";

// Failures: eviction loses the bound, recovery counts twice, a different task
// inherits another task's refusal, or success cannot reset the identical action.
describe("durable repeated research failure bound", () => {
  it("stops three distinct unchanged failures across reconstructed storage readers, not replay of one call", async () => {
    const values = new Map<string, string>();
    const record = (
      callId: string,
      args = {
        workRef: "synthetic-task",
        url: "https://shop.example.test/item",
      },
      error: string | undefined = "HTTP 403",
    ) =>
      recordResearchToolOutcome(
        {
          read: (key) => values.get(key),
          write: (key, value) => {
            values.set(key, value);
          },
          atomic: (effect) => effect(),
        },
        "web_read",
        args,
        callId,
        error,
      );
    expect(await record("first")).toBeUndefined();
    expect(await record("first")).toBeUndefined();
    expect(
      await record("other-task", {
        workRef: "different-task",
        url: "https://shop.example.test/item",
      }),
    ).toBeUndefined();
    expect(await record("second")).toBeUndefined();
    expect(await record("third")).toContain("HTTP 403");
    expect(await record("third")).toContain("HTTP 403");
  });

  it("resets after success and separates changed arguments and diagnostics", async () => {
    const values = new Map<string, string>();
    const store = {
      read: (key: string) => values.get(key),
      write: (key: string, value: string) => {
        values.set(key, value);
      },
      atomic: <T>(effect: () => T) => effect(),
    };
    const record = (
      callId: string,
      error?: string,
      args = { url: "https://shop.example.test/item" },
    ) => recordResearchToolOutcome(store, "web_read", args, callId, error);
    await record("first", "HTTP 403");
    await record("second", "HTTP 403");
    expect(await record("changed-error", "HTTP 429")).toBeUndefined();
    expect(
      await record("changed-url", "HTTP 403", {
        url: "https://shop.example.test/other",
      }),
    ).toBeUndefined();
    await record("successful");
    expect(await record("third", "HTTP 403")).toBeUndefined();
    expect(await record("fourth", "HTTP 403")).toBeUndefined();
    expect(await record("fifth", "HTTP 403")).toContain("HTTP 403");
  });
});
