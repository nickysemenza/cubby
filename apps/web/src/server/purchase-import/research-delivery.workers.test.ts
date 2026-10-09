import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import { fromPartial } from "@total-typescript/shoehorn";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import testModel from "../../../tests/e2e/harness-services/purchase-agent-test-model";
import type { RunServices } from "../purchase-agent/environment";
import { PurchaseImportRunAgent } from "../purchase-agent/run-agent";

// A fast model or recovered tool must not overtake the Postgres delivery ACK.
// Failed submission must remain replayable; admission, not model completion,
// authorizes the ACK. The browser service separately guards ownership/in-flight work.
describe("research observation delivery ordering", () => {
  it("holds a fast browser read behind acknowledgement of its durable observation", async () => {
    const runId = crypto.randomUUID();
    const workRef = crypto.randomUUID();
    const stub = env.DB_FRESHNESS.getByName(
      importRunAgentIdentity(runId, "product_enrichment"),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      await testModel.fetch(
        new Request("https://model.example.test/configure", {
          method: "POST",
          body: JSON.stringify({
            steps: [
              {
                call: "fast-read",
                tool: "work_observe",
                args: { workRef, action: { kind: "read" } },
              },
            ],
          }),
        }),
      );
      let acknowledged = false;
      const reads: boolean[] = [];
      const services = fromPartial<RunServices>({
        authorize: async () => {},
        admitPaidInference: async () => {},
        researchResume: async () => ({ state: "ready", workRef }),
        researchAcknowledge: async () => {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          acknowledged = true;
        },
        researchObserve: async () => {
          reads.push(acknowledged);
          return { state: "waiting" };
        },
        recordAgentUsage: async () => {},
      });
      const host = new PurchaseImportRunAgent(state, {
        services,
        gateway: () => {
          throw new Error("Only the synthetic model is authorized");
        },
        mcpTools: async () => [],
        testModel,
      });
      const delivery = host.dispatch({
        identity: { runId, purpose: "product_enrichment" },
        operationId: "synthetic-browser-delivery",
        signal: {
          type: "purchase-import.browser_result",
          body: JSON.stringify({ commandId: crypto.randomUUID() }),
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await host.alarm();
      await delivery;
      await expect.poll(() => reads, { timeout: 5_000 }).toHaveLength(1);
      expect(reads).toEqual([true]);
      await state.storage.deleteAlarm();
    });
  });
  // A semantic conversation can keep succeeding indefinitely; exhaustion must
  // survive a cold coordinator and browser wake before another model request.
  it("stops a research browser wake at its durable generation allowance before model or tool effects", async () => {
    const runId = crypto.randomUUID();
    const stub = env.DB_FRESHNESS.getByName(
      importRunAgentIdentity(runId, "product_enrichment"),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      await testModel.fetch(
        new Request("https://model.example.test/configure", {
          method: "POST",
          body: JSON.stringify({
            steps: [{ call: "over-budget-next", tool: "work_next", args: {} }],
          }),
        }),
      );
      const reviews: string[] = [];
      let modelRequests = 0;
      let nextCalls = 0;
      const services = fromPartial<RunServices>({
        authorize: async () => {},
        admitPaidInference: async () => {},
        researchResume: async () => ({
          state: "ready",
          workRef: crypto.randomUUID(),
        }),
        researchAcknowledge: async () => {},
        researchNext: async () => {
          nextCalls++;
          return { state: "done" };
        },
        reconcileSettledRun: async (
          input: Parameters<RunServices["reconcileSettledRun"]>[0],
        ) => {
          expect(input.failure).toBeUndefined();
          if (input.detail) reviews.push(input.detail);
          return { reconciled: true, status: "needs_review" };
        },
        updateAgentProgress: async () => {},
        recordAgentUsage: async () => {},
      });
      const environment = {
        services,
        gateway: () => {
          throw new Error("Synthetic model only");
        },
        mcpTools: async () => [],
        testModel: {
          fetch: (request: Request) => {
            modelRequests++;
            return testModel.fetch(request);
          },
        },
      };
      let host = new PurchaseImportRunAgent(state, environment);
      state.storage.sql.exec(
        "INSERT INTO cubby_state (key, value) VALUES (?, ?)",
        "research_generation_count",
        "256",
      );
      host = new PurchaseImportRunAgent(state, environment);
      await host.dispatch({
        identity: { runId, purpose: "product_enrichment" },
        operationId: "synthetic-exhausted-browser-wake",
        signal: {
          type: "purchase-import.browser_result",
          body: JSON.stringify({ commandId: crypto.randomUUID() }),
        },
      });
      await expect
        .poll(() => host.harness.pending(), { timeout: 5_000 })
        .toEqual([]);
      expect(
        await host.harness.wait("synthetic-exhausted-browser-wake"),
      ).toMatchObject({ status: "unanswered", reason: "model_error" });
      const [scheduled] = state.storage.sql
        .exec<{ capability: string; time: number; running: number }>(
          "SELECT capability, time, running FROM cf_agents_jobs WHERE id = ?",
          "settle:synthetic-exhausted-browser-wake",
        )
        .toArray();
      expect(scheduled).toMatchObject({
        capability: "cubby-run-settlement",
        running: 0,
      });
      // This fixture borrows another DO class's storage, so its physical alarm
      // cannot dispatch the Agent. Make the real scheduled job due, then use
      // the SDK's alarm dispatcher, retaining its payload and owner.
      state.storage.sql.exec(
        "UPDATE cf_agents_jobs SET time = ? WHERE id = ? AND capability = ?",
        0,
        "settle:synthetic-exhausted-browser-wake",
        "cubby-run-settlement",
      );
      await host.alarm();
      await expect
        .poll(() => reviews, { timeout: 5_000 })
        .toEqual([expect.stringMatching(/generation.*limit.*256/i)]);
      expect(modelRequests).toBe(0);
      expect(nextCalls).toBe(0);
      expect(
        state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM cubby_state WHERE key = ?",
            "research_generation_count",
          )
          .one().value,
      ).toBe("256");
      await state.storage.deleteAlarm();
    });
  });
  it("counts provider retries and replay of a research generation once in durable SQLite", async () => {
    const runId = crypto.randomUUID();
    const workRef = crypto.randomUUID();
    const stub = env.DB_FRESHNESS.getByName(
      importRunAgentIdentity(runId, "product_enrichment"),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      await testModel.fetch(
        new Request("https://model.example.test/configure", {
          method: "POST",
          body: JSON.stringify({
            steps: [
              { call: "retry-next", tool: "work_next", args: {} },
              {
                call: "retry-read",
                tool: "work_observe",
                args: { workRef, action: { kind: "read" } },
              },
            ],
          }),
        }),
      );
      let reads = 0;
      let requests = 0;
      const services = fromPartial<RunServices>({
        authorize: async () => {},
        admitPaidInference: async () => {},
        researchResume: async () => ({ state: "ready", workRef }),
        researchAcknowledge: async () => {},
        researchNext: async () => ({ state: "ready", workRef }),
        researchObserve: async () => {
          reads++;
          return { state: "waiting" };
        },
        recordAgentUsage: async () => {},
      });
      const environment = {
        services,
        gateway: () => {
          throw new Error("Synthetic model only");
        },
        mcpTools: async () => [],
        testModel: {
          fetch: async (request: Request) => {
            requests++;
            if (requests === 1)
              return new Response("Synthetic temporary model outage", {
                status: 503,
              });
            return testModel.fetch(request);
          },
        },
      };
      const host = new PurchaseImportRunAgent(state, environment);
      state.storage.sql.exec(
        "INSERT INTO cubby_state (key, value) VALUES (?, ?)",
        "research_generation_count",
        "254",
      );
      const input = {
        identity: { runId, purpose: "product_enrichment" as const },
        operationId: "synthetic-retry-budget",
        signal: {
          type: "purchase-import.browser_result",
          body: JSON.stringify({ commandId: crypto.randomUUID() }),
        },
      };
      await host.dispatch(input);
      await expect.poll(() => reads, { timeout: 10_000 }).toBe(1);
      await expect
        .poll(() => host.harness.pending(), { timeout: 5_000 })
        .toEqual([]);
      expect(requests).toBeGreaterThanOrEqual(3);
      expect(
        state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM cubby_state WHERE key = ?",
            "research_generation_count",
          )
          .one().value,
      ).toBe("256");
      const recovered = new PurchaseImportRunAgent(state, environment);
      await recovered.dispatch(input);
      expect(reads).toBe(1);
      expect(
        state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM cubby_state WHERE key = ?",
            "research_generation_count",
          )
          .one().value,
      ).toBe("256");
      await state.storage.deleteAlarm();
    });
  });
  it("preserves photo inventory generation behavior outside the research allowance", async () => {
    const runId = crypto.randomUUID();
    const stub = env.DB_FRESHNESS.getByName(
      importRunAgentIdentity(runId, "photo_inventory"),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      await testModel.fetch(
        new Request("https://model.example.test/configure", {
          method: "POST",
          body: JSON.stringify({ steps: [] }),
        }),
      );
      let modelTurns = 0;
      const services = fromPartial<RunServices>({
        authorize: async () => {},
        admitPaidInference: async () => {},
        recordAgentUsage: async () => {
          modelTurns++;
        },
      });
      const host = new PurchaseImportRunAgent(state, {
        services,
        gateway: () => {
          throw new Error("Synthetic model only");
        },
        mcpTools: async () => [],
        testModel,
      });
      state.storage.sql.exec(
        "INSERT INTO cubby_state (key, value) VALUES (?, ?)",
        "research_generation_count",
        "256",
      );
      await host.dispatch({
        identity: { runId, purpose: "photo_inventory" },
        operationId: "synthetic-photo-allowance",
        signal: { type: "start", body: "Inspect synthetic photo inventory." },
      });
      await expect.poll(() => modelTurns, { timeout: 5_000 }).toBe(1);
      expect(
        state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM cubby_state WHERE key = ?",
            "research_generation_count",
          )
          .one().value,
      ).toBe("256");
      await state.storage.deleteAlarm();
    });
  });
});
