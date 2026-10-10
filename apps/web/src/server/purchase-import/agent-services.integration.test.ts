import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { run, runProgress } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { runServicesFor } from "./agent-services";
import { startAgentRunFixture } from "./import-run.fixtures";

// A Run without an agent must not acquire agent MCP/legacy mutation authority
// through the host adapter, even if a caller bypasses the tool registry.
describe("non-agent host service authority", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));
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
        phase: "preparing",
        detail: "Coordinator started Mail import.",
      }),
    ).toEqual({ recorded: true });
    const rows = await getDb(ctx.db)
      .select()
      .from(runProgress)
      .where(eq(runProgress.runId, owned.id));
    expect(rows).toMatchObject([
      {
        eventId,
        phase: "preparing",
        detail: "Coordinator started Mail import.",
      },
    ]);
  }, 60_000);
});
