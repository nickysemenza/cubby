import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

// A pinned caller and the stored AI activation observation can both be old.
// The version authority must be the DO's currently running code, and a lost
// create response must reuse the same search successor rather than duplicate it.
describe("Workflow deployment authority", () => {
  it("can await its own recovery-scheduling RPC without holding a concurrency gate", async () => {
    const name = crypto.randomUUID();
    const stub = env.AI_GATEWAY_EGRESS.getByName(name);
    await runInDurableObject(stub, async (_instance, state) => {
      await env.AI_GATEWAY_EGRESS.getByName(name).scheduleAiWorkRecovery();
      const pending =
        await state.storage.get<Record<string, string>>("manualAiWorkWakes");
      expect(pending?.authorization).toBeTypeOf("string");
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("reads current metadata without relying on the retained AI observation", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("aiRefreshObservedVersion", "synthetic-a");
      Object.defineProperty(instance, "env", {
        configurable: true,
        value: { CF_VERSION_METADATA: { id: "synthetic-b" } },
      });
      expect(await instance.currentDeploymentVersion()).toBe("synthetic-b");
      Object.defineProperty(instance, "env", {
        value: { CF_VERSION_METADATA: { id: "synthetic-a" } },
      });
      expect(await instance.currentDeploymentVersion()).toBe("synthetic-a");
      expect(await state.storage.get("aiRefreshObservedVersion")).toBe(
        "synthetic-a",
      );
    });
  });

  it("uses documented batch duplicates and propagates other provider failures", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance) => {
      const createBatch = vi.fn(async () => ({
        created: [],
        errors: [
          {
            index: 0,
            id: "synthetic-repair-next",
            code: 10405,
            message: "Synthetic duplicate result",
          },
        ],
      }));
      Object.defineProperty(instance, "env", {
        value: {
          SEARCH_INDEX_REPAIR: {
            createBatch,
            create: async () => {
              throw new Error("Synthetic opaque duplicate refusal");
            },
          },
        },
      });
      const input = {
        id: "synthetic-repair-next",
        params: { requestedAt: "2026-10-01T00:00:00Z" },
      };
      await instance.continueSearchIndexRepair(input);
      expect(createBatch).toHaveBeenCalledWith({
        instances: [
          {
            ...input,
            retention: { successRetention: "1 day", errorRetention: "7 days" },
          },
        ],
      });
      createBatch.mockResolvedValueOnce({
        created: [],
        errors: [
          {
            index: 0,
            id: input.id,
            code: 10000,
            message: "Synthetic Workflow service unavailable",
          },
        ],
      });
      await expect(instance.continueSearchIndexRepair(input)).rejects.toThrow(
        "Synthetic Workflow service unavailable",
      );
    });
  });
});
