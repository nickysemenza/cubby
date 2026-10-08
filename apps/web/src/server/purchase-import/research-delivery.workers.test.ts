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
});
