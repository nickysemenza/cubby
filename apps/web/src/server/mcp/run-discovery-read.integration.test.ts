import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import { runEntityId } from "@cubby/schemas/identifiers";
import {
  mailboxCoverage,
  mailboxDiscoveryInput,
  mailboxDiscoveryProgress,
} from "@cubby/schemas/mailbox-research";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import { aiUsage, mailboxCursor, run, runOperation } from "~/server/db/schema";
import { callMcpTool } from "~/server/mcp/mcp-test-utils";
import { McpOperationContext } from "~/server/mcp/operation-context";
import { createMcpServer } from "~/server/mcp/server";
import { startMailDiscovery } from "~/server/purchase-import/gmail/discovery";
import { checkpointMailboxCoverage } from "~/server/purchase-import/gmail/persistence";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import {
  issueExecutionAuthorization,
  reserveExecutionAuthorization,
} from "~/server/runs/execution-authorization";
import { createTestRequestContext } from "~/server/testing/request-context";

// Failure modes: an owned Workflow Run incorrectly needs a coordinator session;
// frozen scope disappears; approval expiry or reservation is mistaken for spend;
// foreign members read mailbox evidence; a readiness read wakes or changes work.
// Missing historical query/policy fields must not prevent status reads or imply
// a known full-mailbox, classification-only execution scope.
describe("member discovery readiness through MCP", () => {
  const ctx = withTestDb("mcp");
  afterEach(() => vi.useRealTimers());

  it.each([
    { mailboxId: "synthetic-legacy-mailbox" },
    { mailboxId: "synthetic-legacy-mailbox", scopedQueries: [] },
    { mailboxId: "synthetic-legacy-mailbox", executionPolicy: "import" },
  ])(
    "reads legacy discovery status without reconstructing missing frozen scope: %j",
    async (input) => {
      const party = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic legacy discovery owner",
        kind: "member",
        userId: ctx.actor.userId,
      });
      const discovery = await insertWithShortcode(ctx.db, "run", {
        purpose: "mail_discovery",
        trigger: "scheduled",
        status: "completed",
        actorUserId: ctx.actor.userId,
        actorName: "Synthetic legacy discovery owner",
        actorEmail: "legacy-discovery@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: party.kind,
        ledgerPartyId: party.id,
        startedAt: new Date(),
        endedAt: new Date(),
        input: mailboxDiscoveryInput.parse({
          mailboxId: input.mailboxId,
          scopedQueries: [],
        }),
      });
      // Historical JSON predates the current typed launch contract.
      await getDb(ctx.db).execute(sql`UPDATE "Run"
      SET input = ${JSON.stringify(input)}::jsonb WHERE id = ${discovery.id}`);
      const before = await getDb(ctx.db).select().from(run);
      const operationContext = new McpOperationContext(
        requireActor(
          createTestRequestContext(ctx.db, {
            auth: { userId: ctx.actor.userId },
          }),
        ),
      );
      const result = await callMcpTool(
        createMcpServer(),
        "imports_read",
        { action: "run_status", runId: discovery.shortcode },
        {},
        { operationContext },
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        runId: discovery.shortcode,
        status: "completed",
        mailDiscovery: null,
      });
      expect(await getDb(ctx.db).select().from(run)).toEqual(before);
      expect(await getDb(ctx.db).select().from(runOperation)).toEqual([]);
      expect(await getDb(ctx.db).select().from(mailboxCursor)).toEqual([]);
    },
  );

  it("reads frozen scope, checkpoints and expired receipts without execution and refuses foreign members", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic discovery owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const mailboxId = "synthetic-readiness-mailbox";
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const authorization = await issueExecutionAuthorization(
      ctx.db,
      ctx.actor,
      executionAuthorizationInput.parse({
        kind: "execution_authorization",
        version: 1,
        owner: { userId: ctx.actor.userId, ledgerPartyId: party.id },
        scope: { kind: "backfill", mailboxId, discovery: "all_history" },
        meteredBudget: { period: "lifetime", limitMicroUSD: 1_000_000 },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    expect(
      await reserveExecutionAuthorization(ctx.db, {
        ref: authorization,
        owner: { userId: ctx.actor.userId, ledgerPartyId: party.id },
        requestedScope: { mailboxId, discovery: "all_history" },
        physicalAttemptId: crypto.randomUUID(),
        reservationMicroUSD: 125,
      }),
    ).toEqual({ status: "reserved" });
    const launched: string[] = [];
    await startMailDiscovery(ctx.db, {
      launcher: {
        create: async (_purpose, _id, params) => {
          launched.push(params.runId);
        },
        terminate: async () => {
          throw new Error("read must not terminate Workflow");
        },
        status: async () => {
          throw new Error("read must not load Workflow");
        },
      },
    });
    const id = runEntityId.parse(launched[0]);
    const [discovery] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, id));
    if (!discovery) throw new Error("Synthetic discovery missing");
    const coverage = mailboxCoverage.parse({
      version: 1,
      baselineHistoryId: "100",
      broad: { pageToken: "synthetic-next-page", completed: false },
      scoped: [],
      history: { historyId: "110", pageToken: null, targetHistoryId: null },
      nextLane: "scan",
    });
    await checkpointMailboxCoverage(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId,
      from: null,
      to: coverage,
    });
    await getDb(ctx.db)
      .update(run)
      .set({
        progress: mailboxDiscoveryProgress.parse({
          attempt: 2,
          phase: "listing",
          pagesDone: 3,
          saved: 7,
        }),
      })
      .where(eq(run.id, id));
    await getDb(ctx.db)
      .insert(aiUsage)
      .values([
        {
          runId: id,
          feature: "mail-relevance",
          provider: "test",
          model: "synthetic",
          operation: "classify",
          durationMs: 10,
          attempt: 1,
          estimatedCost: 0.25,
        },
        {
          runId: id,
          feature: "mail-relevance",
          provider: "test",
          model: "synthetic",
          operation: "classify",
          durationMs: 20,
          attempt: 2,
          estimatedCost: null,
        },
      ]);
    // Expiry does not erase retained authorization evidence or block its read.
    const beforeRuns = await getDb(ctx.db).select().from(run);
    const beforeReceipts = await getDb(ctx.db).select().from(runOperation);
    const beforeCursor = await getDb(ctx.db).select().from(mailboxCursor);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 120_000));
    const operationContext = new McpOperationContext(
      requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
    );
    const read = (
      action: "run_status" | "run_transcript",
      runId = discovery.shortcode,
    ) =>
      callMcpTool(
        createMcpServer(),
        "imports_read",
        { action, runId },
        {},
        { operationContext },
      );
    const status = await read("run_status");
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      mailDiscovery: {
        scope: {
          mailboxId,
          scopedQueries: [],
          executionPolicy: "classification_only",
        },
        checkpoint: { attempt: 2, phase: "listing", pagesDone: 3, saved: 7 },
        mailbox: { historyId: "110", coverage },
        authorization: {
          approvalFingerprint: authorization.approvalFingerprint,
          scope: { kind: "backfill", mailboxId, discovery: "all_history" },
          expired: true,
          reservations: [{ periodKey: "lifetime", reservedMicroUSD: 125 }],
        },
        usage: {
          callCount: 2,
          retryCount: 1,
          pricedSubtotal: 0.25,
          unpricedCount: 1,
        },
      },
    });
    expect(await read("run_transcript")).toMatchObject({
      structuredContent: {
        status: "absent",
        messages: [],
        settlements: [],
        nextCursor: null,
      },
    });
    const foreignParty = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic other discovery member",
      kind: "member",
    });
    await getDb(ctx.db)
      .update(run)
      .set({ ledgerPartyId: foreignParty.id })
      .where(eq(run.id, id));
    expect((await read("run_status")).isError).toBe(true);
    expect((await read("run_transcript")).isError).toBe(true);
    await getDb(ctx.db)
      .update(run)
      .set({ ledgerPartyId: party.id })
      .where(eq(run.id, id));
    expect(launched).toHaveLength(1);
    // The ownership probe changes only its fixture's ownership and update time.
    expect(
      (await getDb(ctx.db).select().from(run)).map(
        ({ updatedAt: _updatedAt, ...row }) => row,
      ),
    ).toEqual(beforeRuns.map(({ updatedAt: _updatedAt, ...row }) => row));
    expect(await getDb(ctx.db).select().from(runOperation)).toEqual(
      beforeReceipts,
    );
    expect(await getDb(ctx.db).select().from(mailboxCursor)).toEqual(
      beforeCursor,
    );
  });
});
