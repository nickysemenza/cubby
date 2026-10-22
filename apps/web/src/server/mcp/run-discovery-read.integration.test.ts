import {
  mailboxCoverage,
  mailboxDiscoveryInput,
  mailboxDiscoveryProgress,
} from "@cubby/schemas/mailbox-research";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import {
  aiUsage,
  job,
  mailboxCursor,
  run,
  runOperation,
} from "~/server/db/schema";
import { startMailDiscovery } from "~/server/domains/purchase-import/operations/gmail/discovery";
import { checkpointMailboxCoverage } from "~/server/domains/purchase-import/repo/gmail/persistence";
import { setMailImport } from "~/server/domains/purchase-import/repo/mail-import-settings";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { requireActor } from "~/server/http/request-context";
import { McpOperationContext } from "~/server/mcp/operation-context";
import { createMcpServer } from "~/server/mcp/server";
import { callMcpTool } from "~/server/testing/mcp-test-utils";
import { createTestRequestContext } from "~/server/testing/request-context";

// Failure modes: an owned Workflow Run incorrectly needs a coordinator session;
// frozen scope disappears; foreign members read mailbox evidence; a readiness
// read wakes or changes work.
// Missing historical query/policy fields must not prevent status reads or imply
// a known full-mailbox, classification-only execution scope.
describe("member discovery readiness through MCP", () => {
  const ctx = withTestDb("mcp");

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
        mailDiscovery: {
          scope: {
            mailboxId: input.mailboxId,
            scopedQueries:
              "scopedQueries" in input ? { total: 0, sample: [] } : null,
            executionPolicy: "executionPolicy" in input ? "import" : null,
          },
          emails: { coverage: "incomplete", items: [] },
        },
      });
      expect(await getDb(ctx.db).select().from(run)).toEqual(before);
      expect(await getDb(ctx.db).select().from(runOperation)).toEqual([]);
      expect(await getDb(ctx.db).select().from(mailboxCursor)).toEqual([]);
    },
  );

  it("reads frozen scope and checkpoints without execution and refuses foreign members", async () => {
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
    await setMailImport(ctx.db, { mailboxId, enabled: true });
    await startMailDiscovery(ctx.db);
    const [discovery] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "mail_discovery"));
    if (!discovery) throw new Error("Synthetic discovery missing");
    const id = discovery.id;
    expect(
      await getDb(ctx.db)
        .select({ kind: job.kind, state: job.state, input: job.input })
        .from(job)
        .where(eq(job.key, `run:${id}`)),
    ).toEqual([
      {
        kind: "run.execute",
        state: "queued",
        input: { runId: id, purpose: "mail_discovery" },
      },
    ]);
    const coverage = mailboxCoverage.parse({
      version: 1,
      baselineHistoryId: "100",
      broad: { pageToken: "synthetic-next-page", completed: false },
      // More queries than a status read returns, the first two finished.
      scoped: Array.from({ length: 12 }, (_, index) => ({
        key: `merchant:synthetic shop ${index}`,
        query: `"synthetic shop ${index}"`,
        pageToken: null,
        completed: index < 2,
      })),
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
          page: {
            messageIds: ["synthetic-message-1", "synthetic-message-2"],
            events: [],
            startCoverage: coverage,
            nextCoverage: coverage,
          },
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
          chargedCost: 0.25,
        },
        {
          runId: id,
          feature: "mail-relevance",
          provider: "test",
          model: "synthetic",
          operation: "classify",
          durationMs: 20,
          attempt: 2,
          chargedCost: null,
        },
      ]);
    const beforeRuns = await getDb(ctx.db).select().from(run);
    const beforeJobs = await getDb(ctx.db).select().from(job);
    const beforeReceipts = await getDb(ctx.db).select().from(runOperation);
    const beforeCursor = await getDb(ctx.db).select().from(mailboxCursor);
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
      workProgress: {
        current: {
          phase: "listing",
          unit: "pages",
          processed: 3,
          total: null,
          failures: 0,
          etaSeconds: null,
        },
      },
      mailDiscovery: {
        scope: {
          mailboxId,
          scopedQueries: { total: 0, sample: [] },
          executionPolicy: "import",
        },
        checkpoint: {
          attempt: 2,
          phase: "listing",
          pagesDone: 3,
          saved: 7,
          page: { messageCount: 2, eventCount: 0 },
        },
        mailbox: {
          historyId: "110",
          coverage: {
            baselineHistoryId: "100",
            nextLane: "scan",
            scoped: {
              total: 12,
              completed: 2,
              pending: 10,
              nextPending: coverage.scoped.slice(2),
            },
          },
        },
        usage: {
          callCount: 2,
          retryCount: 1,
          chargedCost: 0.25,
          chargedUnpricedCount: 1,
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
    expect(await getDb(ctx.db).select().from(job)).toEqual(beforeJobs);
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
