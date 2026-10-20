import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

// Legacy metadata RPCs remain diagnostics for pinned callers. Search successor
// dispatch crosses the queue boundary before activated code creates an instance.
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

  it("queues legacy search successors for a fresh activated invocation", async () => {
    const stub = env.AI_GATEWAY_EGRESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance) => {
      const createBatch = vi.fn(async () => ({
        created: [{ id: "synthetic-repair-next" }],
        errors: [],
      }));
      const sendBatch = vi.fn(async () => {});
      Object.defineProperty(instance, "env", {
        value: {
          SEARCH_INDEX_REPAIR: { createBatch },
          BACKGROUND_QUEUE: { sendBatch },
        },
      });
      const input = {
        id: "synthetic-repair-next",
        params: { requestedAt: "2026-10-01T00:00:00Z" },
      };
      await instance.continueSearchIndexRepair(input);
      expect(createBatch).not.toHaveBeenCalled();
      expect(sendBatch).toHaveBeenCalledWith([
        expect.objectContaining({
          body: expect.objectContaining({
            task: expect.objectContaining({
              kind: "search-repair.continue",
              ...input,
            }),
          }),
        }),
      ]);
      sendBatch.mockRejectedValueOnce(new Error("Synthetic queue unavailable"));
      await expect(instance.continueSearchIndexRepair(input)).rejects.toThrow(
        "Synthetic queue unavailable",
      );
    });
  });
});
