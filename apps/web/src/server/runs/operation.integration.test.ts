import { commitPurchaseImportInput } from "@cubby/schemas/purchase-import";
import { sha256Hex, sha256Uuid } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { run as runTable, runApproval, runOperation } from "~/server/db/schema";
import { McpOperationContext } from "~/server/mcp/operation-context";
import {
  executePurchaseAgentMutation,
  purchaseAgentTargetFingerprint,
} from "~/server/mcp/purchase-agent-protocol";
import type { ToolExtra } from "~/server/mcp/tools/tool-registration";
import {
  commitPurchaseImport,
  preparePurchaseImport,
} from "~/server/purchase-import/import-orders";
import { startAgentRunFixture } from "~/server/purchase-import/import-run.fixtures";
import { controlRun } from "~/server/purchase-import/run-service";
import { getDb } from "~/server/repo/database-helpers";
import { insertDebugEventOperations } from "~/server/repo/run-operation";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { executeLeasedOperation } from "./operation";

/**
 * RunOperation rows outlive deploys: a Run paused today resumes on tomorrow's
 * code. Each row here is written the way the previous code wrote it — its
 * fingerprint spelled out from the frozen per-site formula, never computed by
 * the code under test — and must replay identically. A changed fingerprint
 * formula, command id derivation, `mcp:<tool>` kind, or stored result shape
 * fails here instead of in a household Run.
 */
describe("RunOperation rows written by earlier code", () => {
  const ctx = withTestDb();

  const startRun = async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic ledger member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startAgentRunFixture(ctx.db, {
      ledgerPartyId: party.id,
    });
    return { party, run };
  };

  const seed = (values: typeof runOperation.$inferInsert) =>
    getDb(ctx.db).insert(runOperation).values(values);

  const stored = async (runId: string, operationId: string) => {
    const [row] = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(
        and(
          // SAFETY: the run id came from a row this test inserted.
          eq(
            runOperation.runId,
            runId as typeof runOperation.$inferSelect.runId,
          ),
          eq(runOperation.operationId, operationId),
        ),
      );
    return row;
  };

  it("pins the shared digests every replay identity is built from", async () => {
    expect(await sha256Hex(JSON.stringify({ value: 1 }))).toBe(
      "48208f9428d64634bd8e28ff345bf0eab60d53c18fa2fbdb0b9bc1e84df2b5f6",
    );
    expect(await sha256Uuid("run-a:browser-command:1")).toBe(
      "ecc18841-bcc0-5d20-a268-27eaa6d85083",
    );
  });

  it("replays, reclaims, and fences leased rows by their payload fingerprint", async () => {
    const { run } = await startRun();
    const payloadFingerprint = (payload: Record<string, string>) =>
      sha256Hex(JSON.stringify(payload));
    let calls = 0;
    const work = async () => {
      calls += 1;
      return { fresh: true };
    };

    const completed = { runId: run.id, operationId: "claim-work:1" };
    await seed({
      runId: run.id,
      operationId: completed.operationId,
      kind: "claim_next_work",
      inputFingerprint: await payloadFingerprint(completed),
      state: "completed",
      result: { recorded: true },
      completedAt: new Date(),
    });
    await expect(
      executeLeasedOperation(
        ctx.db,
        { ...completed, kind: "claim_next_work", payload: completed },
        work,
      ),
    ).resolves.toEqual({ recorded: true });
    expect(calls).toBe(0);

    // A Worker that died mid-call left `started` behind; five minutes later
    // the next delivery takes the row over.
    const stale = { runId: run.id, operationId: "claim-work:stale" };
    await seed({
      runId: run.id,
      operationId: stale.operationId,
      kind: "claim_next_work",
      inputFingerprint: await payloadFingerprint(stale),
      state: "started",
      updatedAt: new Date(Date.now() - 6 * 60_000),
    });
    await expect(
      executeLeasedOperation(
        ctx.db,
        { ...stale, kind: "claim_next_work", payload: stale },
        work,
      ),
    ).resolves.toEqual({ fresh: true });
    expect(calls).toBe(1);
    expect(await stored(run.id, stale.operationId)).toMatchObject({
      state: "completed",
      result: { fresh: true },
    });

    const live = { runId: run.id, operationId: "claim-work:live" };
    await seed({
      runId: run.id,
      operationId: live.operationId,
      kind: "claim_next_work",
      inputFingerprint: await payloadFingerprint(live),
      state: "started",
    });
    await expect(
      executeLeasedOperation(
        ctx.db,
        { ...live, kind: "claim_next_work", payload: live },
        work,
      ),
    ).rejects.toThrow("already in progress");
    expect(calls).toBe(1);

    // A failed single-transaction write may be retaken with a corrected
    // payload only when the caller opts in.
    const failedPayload = { runId: run.id, groupKey: "g1", name: "Old" };
    await seed({
      runId: run.id,
      operationId: "photo-group:g1",
      kind: "commit_photo_group",
      inputFingerprint: await payloadFingerprint(failedPayload),
      state: "failed",
      error: "Synthetic earlier failure",
    });
    const corrected = { ...failedPayload, name: "New" };
    await expect(
      executeLeasedOperation(
        ctx.db,
        {
          runId: run.id,
          operationId: "photo-group:g1",
          kind: "commit_photo_group",
          payload: corrected,
        },
        work,
      ),
    ).rejects.toThrow("different input");
    await expect(
      executeLeasedOperation(
        ctx.db,
        {
          runId: run.id,
          operationId: "photo-group:g1",
          kind: "commit_photo_group",
          payload: corrected,
          retryFailedWithChangedInput: true,
        },
        work,
      ),
    ).resolves.toEqual({ fresh: true });
    expect(await stored(run.id, "photo-group:g1")).toMatchObject({
      state: "completed",
      error: null,
      inputFingerprint: await payloadFingerprint(corrected),
    });
  });

  /** A paused `mcp:<tool>` proposal as earlier code stored it, approved by a member. */
  const seedMcpMutation = async (
    decision: "approve" | "reject" = "approve",
  ) => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic paused member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await insertWithShortcode(ctx.db, "run", {
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic paused actor",
      actorEmail: "paused@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: party.kind,
      purpose: "mail_import",
      trigger: "manual",
      agentSessionId: "synthetic-paused-session",
      status: "paused_approval",
    });
    const toolName = "statement_rows.update";
    const params = {
      selector: { source: "synthetic", externalIds: ["row-a"] },
      data: { disposition: "open", dispositionNote: null },
    };
    const args = { toolName, params };
    const argsFingerprint = await sha256Hex(JSON.stringify(args));
    const targetFingerprint = await purchaseAgentTargetFingerprint(
      ctx.db,
      args,
    );
    const operationId = "mcp-call:restore";
    const approvalProposal = {
      operationKind: `mcp:${toolName}`,
      args,
      targetFingerprint,
      evidenceFingerprint: argsFingerprint,
    };
    await seed({
      runId: run.id,
      operationId,
      kind: `mcp:${toolName}`,
      inputFingerprint: argsFingerprint,
      state: "paused_approval",
      result: { approvalProposal },
    });
    await getDb(ctx.db)
      .insert(runApproval)
      .values({
        runId: run.id,
        operationId,
        operationKind: `mcp:${toolName}`,
        args,
        argsFingerprint,
        targetFingerprint,
        evidenceFingerprint: argsFingerprint,
        state: "pending",
      });

    const approved = await controlRun(ctx.db, ctx.actor, {
      runPublicId: run.shortcode,
      action: decision,
      operationId,
    });
    expect(approved).toMatchObject({
      decision: decision === "approve" ? "approved" : "rejected",
    });
    if (decision === "approve") {
      if (!("approvalId" in approved))
        throw new Error("Synthetic approval returned another control outcome");
      expect(await stored(run.id, operationId)).toMatchObject({
        state: "paused_approval",
        result: { approvalProposal, approvalId: approved.approvalId },
      });
    }

    let executions = 0;
    const execute = () =>
      executePurchaseAgentMutation({
        db: ctx.db,
        actor: ctx.actor,
        operationContext: new McpOperationContext(
          requireActor(
            createTestRequestContext(ctx.db, {
              auth: { userId: ctx.actor.userId },
            }),
          ),
        ),
        trusted: { runId: run.id, grantId: "synthetic-grant" },
        toolName,
        args: params,
        execution: { runId: run.id, operationId },
        run: async () => {
          executions += 1;
          return { accepted: true };
        },
        baseExtra: fromPartial<ToolExtra>({}),
      });
    return {
      run,
      operationId,
      execute,
      executions: () => executions,
    };
  };

  it("approves and executes a paused MCP mutation proposed by earlier code", async () => {
    const { run, operationId, execute, executions } = await seedMcpMutation();
    await expect(execute()).resolves.toEqual({ accepted: true });
    await expect(execute()).resolves.toEqual({ accepted: true });
    expect(executions()).toBe(1);
    expect(await stored(run.id, operationId)).toMatchObject({
      state: "completed",
      result: { accepted: true },
    });
  });

  it("keeps a rejected persisted mutation refused on every replay without an effect", async () => {
    const { run, operationId, execute, executions } =
      await seedMcpMutation("reject");
    const before = await stored(run.id, operationId);
    expect(before).toMatchObject({
      state: "failed",
      error: expect.stringMatching(/reject/iu),
    });
    await expect(execute()).rejects.toThrow("Mutation outcome is uncertain");
    await expect(execute()).rejects.toThrow("Mutation outcome is uncertain");
    expect(executions()).toBe(0);
    expect(await stored(run.id, operationId)).toEqual(before);
  });

  it("locks the Run before the operation when executing an approved mutation", async () => {
    const { run, operationId, execute, executions } = await seedMcpMutation();
    let pending: Promise<unknown> | undefined;
    // A transaction holding the Run lock stands in for `controlRun`, which
    // locks the Run before the operation. The mutation must queue behind the
    // Run lock without first taking the operation row; otherwise the two wait
    // on each other.
    await getDb(ctx.db).transaction(async (tx) => {
      await tx
        .select({ id: runTable.id })
        .from(runTable)
        .where(eq(runTable.id, run.id))
        .for("update");
      pending = execute();
      pending.catch(() => undefined);
      await expect
        .poll(
          async () => {
            const waiting = await getDb(ctx.db).execute<{ count: number }>(
              sql`SELECT count(*)::int AS count FROM pg_stat_activity
                  WHERE datname = current_database() AND wait_event_type = 'Lock'`,
            );
            return waiting.rows[0]?.count;
          },
          { timeout: 10_000 },
        )
        .toBe(1);
      await expect(
        tx
          .select({ id: runOperation.id })
          .from(runOperation)
          .where(
            and(
              eq(runOperation.runId, run.id),
              eq(runOperation.operationId, operationId),
            ),
          )
          .for("update", { noWait: true }),
      ).resolves.toHaveLength(1);
    });
    await expect(pending).resolves.toEqual({ accepted: true });
    expect(executions()).toBe(1);
  });

  it("ignores a re-sent device debug-event batch instead of duplicating it", async () => {
    const { run } = await startRun();
    const event = {
      id: crypto.randomUUID(),
      occurredAt: "2026-10-05T12:00:00.000Z",
      event: "command.started" as const,
      runId: run.id,
      operationKind: "navigate" as const,
    };
    const second = { ...event, id: crypto.randomUUID() };

    await expect(
      insertDebugEventOperations(getDb(ctx.db), [event]),
    ).resolves.toBe(1);
    // The device retries the whole batch after a lost response.
    await expect(
      insertDebugEventOperations(getDb(ctx.db), [event, second]),
    ).resolves.toBe(1);
    await expect(
      insertDebugEventOperations(getDb(ctx.db), [event, second]),
    ).resolves.toBe(0);

    const rows = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.kind, "__debug_event"));
    expect(rows.filter((row) => row.runId === run.id)).toHaveLength(2);
    expect(await stored(run.id, `__debug_event:${event.id}`)).toMatchObject({
      kind: "__debug_event",
      inputFingerprint: event.id,
      state: "completed",
      result: event,
      executor: null,
      completedAt: expect.any(Date),
    });
  });

  it("keeps prepare fenced and commit replaying by their own fingerprints", async () => {
    const { run } = await startRun();
    const orders = [
      {
        stableOrderId: "order-1",
        itemOperationId: "prepare-item:order-1",
        source: {
          kind: "vendor_export" as const,
          externalKey: "shop:order:1",
          checksum: "a".repeat(64),
        },
        evidenceChecksum: "b".repeat(64),
        extractionRevision: "shop@fixture-1",
        extraction: {
          status: "unreadable" as const,
          detail: "Synthetic unreadable",
        },
        lineIds: [],
        primaryDocumentImageId: null,
        screenshotImageId: null,
      },
    ];
    // Prepare fingerprints only `orders`, so an uncertain attempt stays
    // uncertain rather than becoming a different-input conflict.
    await seed({
      runId: run.id,
      operationId: "prepare:1",
      kind: "prepare_purchase_import",
      inputFingerprint: await sha256Hex(JSON.stringify(orders)),
      state: "failed",
      error: "Synthetic interrupted prepare",
    });
    await expect(
      preparePurchaseImport(
        ctx.db,
        {
          _runExecution: {
            runId: run.id,
            operationId: "prepare:1",
            itemOperationIds: ["prepare-item:order-1"],
          },
          orders,
        },
        ctx.actor,
      ),
    ).rejects.toThrow("Preparation outcome is uncertain");

    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: { runId: run.id, operationId: "commit:1" },
      prepareOperationId: "prepare:1",
      defaultTrade: "other",
      resolutions: [],
    });
    const publicResult = {
      runId: run.publicId,
      operationId: "commit:1",
      status: "needs_review",
      items: [],
    };
    await seed({
      runId: run.id,
      operationId: "commit:1",
      kind: "commit_purchase_import",
      inputFingerprint: await sha256Hex(
        JSON.stringify({
          prepareOperationId: "prepare:1",
          defaultTrade: "other",
          defaultProjectId: undefined,
          resolutions: [],
        }),
      ),
      state: "completed",
      result: { ...publicResult, requiresReview: true },
      completedAt: new Date(),
    });
    await expect(
      commitPurchaseImport(ctx.db, commitInput, ctx.actor),
    ).resolves.toEqual(publicResult);
    // The stored `requiresReview` still finalizes the Run on replay.
    const [after] = await getDb(ctx.db)
      .select({ status: runTable.status })
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(after?.status).toBe("needs_review");
  });
});
