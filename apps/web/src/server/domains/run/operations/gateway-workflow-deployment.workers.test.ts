import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

// A pinned caller and the stored AI activation observation can both be old.
// The version authority must be the DO's currently running code, and a lost
// create response must reuse the same search successor rather than duplicate it.
describe("Workflow deployment authority", () => {
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

  it("accepts only an already-created successor and propagates other provider failures", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance) => {
      const create = vi.fn(async () => {
        throw new Error("10405: An instance with this ID already exists.");
      });
      Object.defineProperty(instance, "env", {
        value: { SEARCH_INDEX_REPAIR: { create } },
      });
      const input = {
        id: "synthetic-repair-next",
        params: { requestedAt: "2026-10-01T00:00:00Z" },
      };
      await instance.continueSearchIndexRepair(input);
      expect(create).toHaveBeenCalledWith({
        ...input,
        retention: { successRetention: "1 day", errorRetention: "7 days" },
      });
      create.mockRejectedValueOnce(
        new Error("Synthetic Workflow service unavailable"),
      );
      await expect(instance.continueSearchIndexRepair(input)).rejects.toThrow(
        "Synthetic Workflow service unavailable",
      );
    });
  });
});
