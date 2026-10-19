import { agentConversationSchema } from "@cubby/schemas/agent-conversation";
import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  ROOT_CONVERSATION_ID,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { openPiSessionStore } from "agents/harness/pi";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("purchase agent host observation", () => {
  it("answers a cold stream from retained storage without constructing the agent", async () => {
    const stub = env.PURCHASE_IMPORT_RUN.getByName(
      importRunAgentIdentity(crypto.randomUUID(), "photo_inventory"),
    );

    const response = await stub.fetch("https://purchase-agent.internal/stream");

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(agentConversationSchema.parse(await response.json())).toMatchObject({
      status: "absent",
    });
    // Constructing the agent opens pi, which resumes pending tasks; its
    // constructor leaves cubby_state behind.
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE name = 'cubby_state'")
          .toArray(),
      ).toEqual([]);
    });
  });

  it("reports pi's per-model token totals from retained storage", async () => {
    const stub = env.PURCHASE_IMPORT_RUN.getByName(
      importRunAgentIdentity(crypto.randomUUID(), "photo_inventory"),
    );
    const usage = (input: number) => ({
      input,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: input + 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    await runInDurableObject(stub, async (_instance, state) => {
      const context = BACKGROUND_CONTEXT;
      const pi = await Harness.open(
        await openPiSessionStore(state.storage),
        { models: createModels(), registry: createRegistry() },
        context,
      );
      const root = await pi.root(context);
      await root.commit(async (tx) => {
        const doc = await tx.doc(UsageDoc, ROOT_CONVERSATION_ID);
        doc.models["synthetic/turn-model"] = usage(11);
        doc.models["synthetic/summary-model"] = usage(5);
      }, context);
      await pi.close(context);
    });

    const response = await stub.fetch("https://purchase-agent.internal/stream");

    expect(
      agentConversationSchema.parse(await response.json()).modelUsage,
    ).toEqual([
      {
        model: "synthetic/summary-model",
        inputTokens: 5,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
      },
      {
        model: "synthetic/turn-model",
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
      },
    ]);
  });
});
