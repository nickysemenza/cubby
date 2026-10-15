import { cubbyPiProviders, piTokenUsage } from "@cubby/shared/ai/pi-providers";
import { createModels } from "@earendil-works/pi-ai";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { snapshotAiUsagePrice } from "~/server/ai/pricing";
import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import { run, aiUsage } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { startAgentRunFixture } from "../service/import-run.fixtures";
import { runServicesFor } from "./agent-services";

// A Run without an agent must not acquire agent MCP/legacy mutation authority
// through the host adapter, even if a caller bypasses the tool registry.
describe("non-agent host service authority", () => {
  const ctx = withTestDb();
  afterEach(() => {
    setCfEnv(undefined);
  });
  async function services() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic import member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const owned = await insertWithShortcode(ctx.db, "run", {
      // An agent identity on a non-agent purpose must still be refused.
      agentSessionId: "synthetic-legacy-agent",
      purpose: "file_import",
      trigger: "manual",
      status: "running",
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: party.name,
      actorEmail: "member@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: party.kind,
    });
    const env = fromPartial<Env>({
      HYPERDRIVE: fromPartial({ connectionString: ctx.databaseUrl }),
    });
    return {
      party,
      env,
      owned,
      host: runServicesFor(env, { waitUntil: () => {} }, owned.id),
    };
  }
  it("rejects broad MCP on a non-agent Run before delegation or endpoint dispatch", async () => {
    const { host } = await services();
    await expect(
      host.mcpFetch(
        new Request("https://cubby.internal/api/mcp", {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      ),
    ).rejects.toThrow(/photo.inventory/i);
  }, 60_000);
  it("rejects legacy photo review on a non-agent Run without stopping its work", async () => {
    const { owned, host } = await services();
    await expect(
      host.stopForReview({
        operationId: "synthetic-review",
        reason: "other",
        detail: "A legacy caller cannot stop a member import.",
      }),
    ).rejects.toThrow(/photo.inventory/i);
    const [current] = await getDb(ctx.db)
      .select({ status: run.status, endedAt: run.endedAt })
      .from(run)
      .where(eq(run.id, owned.id));
    expect(current).toEqual({ status: "running", endedAt: null });
  }, 60_000);
  // The RPC input parser must retain the SDK comparison snapshot before plan normalization.
  it("keeps a plan turn's SDK comparison price and snapshot through host ingestion", async () => {
    const { party, env } = await services();
    const owned = await startAgentRunFixture(ctx.db, {
      ledgerPartyId: party.id,
    });
    const models = createModels();
    for (const provider of cubbyPiProviders(
      (_provider, markUnbilled) => async () => {
        markUnbilled?.();
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: { id: "synthetic-response", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    ))
      models.setProvider(provider);
    const model = models.getModel("openai", "gpt-6-sol");
    if (!model) throw new Error("The fixture model must be declared");
    const message = await models.complete(model, { messages: [] });
    const accounting = piTokenUsage(message);
    expect(accounting.standardCost).toBeGreaterThan(0);
    expect(accounting.chargedCost).toBe(0);
    const canonical = await snapshotAiUsagePrice(
      "openai",
      model.id,
      accounting,
    );
    // The isolate can reuse a catalog captured by an earlier service call.
    expect(canonical.amount).toBeGreaterThan(0);
    await runServicesFor(
      env,
      { waitUntil: () => {} },
      owned.id,
    ).recordAgentUsage({
      ...accounting,
      eventId: "synthetic-response",
      provider: "openai",
      model: model.id,
      feature: "purchase_import_agent",
      operation: "agent.generation",
      attempt: 1,
      durationMs: 1,
      status: "succeeded",
      transport: "chatgpt",
    });
    const [recorded] = await getDb(ctx.db)
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.runId, owned.id));
    expect(recorded).toMatchObject({
      standardCost: canonical.amount ?? accounting.standardCost,
      chargedCost: 0,
      costEvidence: {
        standard: {
          source: "estimate",
          pricingSource: canonical.amount === null ? "pi_sdk" : "models.dev",
          pricingSnapshot: {
            provider: canonical.evidence?.pricingSnapshot.provider,
            model: canonical.evidence?.pricingSnapshot.model,
            rates: canonical.evidence?.pricingSnapshot.rates,
          },
        },
        charged: accounting.costEvidence?.charged,
        billingReason: "plan",
      },
    });
  }, 60_000);

  it("records coordinator progress for a Mail import agent Run", async () => {
    const { party, env } = await services();
    const owned = await startAgentRunFixture(ctx.db, {
      ledgerPartyId: party.id,
    });
    const host = runServicesFor(env, { waitUntil: () => {} }, owned.id);
    const eventId = crypto.randomUUID();
    expect(
      await host.updateAgentProgress({
        eventId,
        generation: owned.dispatchEventId!,
        sequence: 1,
        phase: "preparing",
        detail: "Coordinator started Mail import.",
      }),
    ).toEqual({ recorded: true });
    const [row] = await getDb(ctx.db)
      .select({ history: run.progressHistory })
      .from(run)
      .where(eq(run.id, owned.id));
    expect(row?.history).toMatchObject([
      {
        eventId,
        generation: owned.dispatchEventId!,
        sequence: 1,
        phase: "preparing",
        detail: "Coordinator started Mail import.",
      },
    ]);
  }, 60_000);
});
