import { productResearchRunInput } from "@cubby/schemas/run-fields";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv, type getTestAiGateway } from "~/server/cf-env";
import { run, runProgress, runTarget } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { runServicesFor } from "./agent-services";

// A research Run must not acquire photo-only MCP/legacy mutation authority
// through the host adapter, even if a caller bypasses the tool registry.
describe("research host service authority", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));
  async function services(
    gateway?: NonNullable<ReturnType<typeof getTestAiGateway>>,
  ) {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic research member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const owned = await insertWithShortcode(ctx.db, "run", {
      agentSessionId: "synthetic-research-agent",
      purpose: "product_enrichment",
      trigger: "manual",
      status: "running",
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: party.name,
      actorEmail: "research@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: party.kind,
    });
    const env = fromPartial<Env & { CUBBY_TEST_AI_GATEWAY?: typeof gateway }>({
      HYPERDRIVE: fromPartial({ connectionString: ctx.databaseUrl }),
      CUBBY_TEST_AI_GATEWAY: gateway,
    });
    return {
      owned,
      host: runServicesFor(env, { waitUntil: () => {} }, owned.id),
    };
  }
  it("routes mounted research to explicitly enabled fixture sources without an AI search binding", async () => {
    const requests: string[] = [];
    const { owned, host } = await services({
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        const path = new URL(request.url).pathname;
        requests.push(path);
        if (path === "/research-fixture-config")
          return Response.json({ enabled: true });
        if (path === "/research-search")
          return Response.json({
            items: [
              {
                url: "https://maker.example.test/small-device",
                title: "Small device",
              },
            ],
          });
        return new Response("Unexpected fixture request", { status: 404 });
      },
    });
    const item = await insertWithShortcode(ctx.db, "product", {
      name: "Small device",
      manufacturer: "Example maker",
    });
    const [target] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: owned.id,
        entityKind: "product",
        entityId: item.id,
        workKey: item.id,
        targetFingerprint: "a".repeat(64),
      })
      .returning();
    if (!target) throw new Error("Synthetic target missing");
    await getDb(ctx.db)
      .update(run)
      .set({
        input: productResearchRunInput.parse({
          kind: "product_research",
          instructionRevision: 1,
          products: [
            { productId: item.id, contextFingerprint: "a".repeat(64) },
          ],
        }),
      })
      .where(eq(run.id, owned.id));
    expect(
      await host.researchWebSearch(
        { workRef: target.id, query: "Small device exact model" },
        crypto.randomUUID(),
      ),
    ).toMatchObject({
      results: [
        {
          url: "https://maker.example.test/small-device",
          title: "Small device",
        },
      ],
    });
    expect(requests).toEqual(["/research-fixture-config", "/research-search"]);
  }, 60_000);
  it("rejects broad MCP on a research Run before delegation or endpoint dispatch", async () => {
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
  it("rejects legacy photo review on a research Run without stopping its work", async () => {
    const { owned, host } = await services();
    await expect(
      host.stopForReview({
        operationId: "synthetic-review",
        reason: "other",
        detail: "A legacy caller cannot stop research.",
      }),
    ).rejects.toThrow(/photo.inventory/i);
    const [current] = await getDb(ctx.db)
      .select({ status: run.status, endedAt: run.endedAt })
      .from(run)
      .where(eq(run.id, owned.id));
    expect(current).toEqual({ status: "running", endedAt: null });
  }, 60_000);
  it("records coordinator progress for research without granting legacy model tools", async () => {
    const { owned, host } = await services();
    const eventId = crypto.randomUUID();
    expect(
      await host.updateAgentProgress({
        eventId,
        phase: "preparing",
        detail: "Coordinator started research.",
      }),
    ).toEqual({ recorded: true });
    const rows = await getDb(ctx.db)
      .select()
      .from(runProgress)
      .where(eq(runProgress.runId, owned.id));
    expect(rows).toMatchObject([
      { eventId, phase: "preparing", detail: "Coordinator started research." },
    ]);
  }, 60_000);
});
