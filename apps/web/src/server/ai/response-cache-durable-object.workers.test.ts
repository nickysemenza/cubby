import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { setCfEnv } from "~/server/cf-env";

import { withAiResponseCache } from "./response-cache";

describe("AI response cache Durable Object", () => {
  it("shares one model result through the Worker cache client", async () => {
    setCfEnv(env);
    try {
      const keyInput = {
        feature: "test",
        model: "test-model",
        promptVersion: "1",
        input: {
          state: crypto.randomUUID(),
          questions: {
            selection: {
              type: "choice" as const,
              instructions: "Choose one.",
              criteria: { c0: "one" },
            },
          },
        },
      };
      let calls = 0;
      const args = {
        enabled: true,
        keyInput,
        validate: z.object({ choice: z.string() }).parse,
        compute: async () => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { choice: "one" };
        },
      };
      const answers = await Promise.all([
        withAiResponseCache(args),
        withAiResponseCache(args),
      ]);
      expect(answers).toEqual([{ choice: "one" }, { choice: "one" }]);
      expect(calls).toBe(1);
    } finally {
      setCfEnv(undefined);
    }
  });

  it("coordinates claims across stubs and retains completed values after eviction", async () => {
    const name = crypto.randomUUID();
    const first = env.AI_RESPONSE_CACHE.getByName(name);
    const second = env.AI_RESPONSE_CACHE.getByName(name);
    const claim = await first.readOrClaim("key", false);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("claim missing");
    expect(await second.readOrClaim("key", false)).toEqual({ kind: "busy" });
    expect(
      await first.publish(
        "key",
        claim.token,
        JSON.stringify({ choice: "one" }),
        60_000,
      ),
    ).toBe(true);
    expect(await second.readOrClaim("key", false)).toEqual({
      kind: "hit",
      value: JSON.stringify({ choice: "one" }),
    });
    await evictDurableObject(first);
    expect(await second.readOrClaim("key", false)).toMatchObject({
      kind: "hit",
    });
    const refresh = await second.readOrClaim("key", true);
    expect(refresh.kind).toBe("claimed");
    if (refresh.kind !== "claimed") throw new Error("refresh claim missing");
    expect(await first.publish("key", claim.token, "stale", 60_000)).toBe(
      false,
    );
    await second.release("key", refresh.token);
    expect((await first.readOrClaim("key", false)).kind).toBe("claimed");
  });

  it("reclaims an expired cached value", async () => {
    const stub = env.AI_RESPONSE_CACHE.getByName(crypto.randomUUID());
    const claim = await stub.readOrClaim("key", false);
    if (claim.kind !== "claimed") throw new Error("claim missing");
    await stub.publish("key", claim.token, "old", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await stub.readOrClaim("key", false)).kind).toBe("claimed");
  });

  it("reclaims an abandoned lease without accepting a late publisher", async () => {
    const stub = env.AI_RESPONSE_CACHE.getByName(crypto.randomUUID());
    const abandoned = await stub.readOrClaim("key", false);
    if (abandoned.kind !== "claimed") throw new Error("claim missing");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE responses SET lease_expires_at = 0 WHERE key = ?",
        "key",
      );
    });
    const replacement = await stub.readOrClaim("key", false);
    expect(replacement.kind).toBe("claimed");
    expect(await stub.publish("key", abandoned.token, "late", 60_000)).toBe(
      false,
    );
  });
});
