import {
  BROWSER_BRIDGE_PROTOCOL,
  commitProductEnrichmentInput,
  commitPurchaseImportInput,
  validatePurchaseImportInput,
  type BrowserBridgeRequest,
  type BrowserBridgeResult,
} from "@cubby/schemas/purchase-import";
import { sha256Hex, sha256Uuid } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  product,
  run as runTable,
  runApproval,
  runOperation,
  runTarget,
} from "~/server/db/schema";
import { McpOperationContext } from "~/server/mcp/operation-context";
import {
  executePurchaseAgentMutation,
  purchaseAgentTargetFingerprint,
} from "~/server/mcp/purchase-agent-protocol";
import type { ToolExtra } from "~/server/mcp/tools/tool-registration";
import { observation } from "~/server/purchase-import/browser.fixtures";
import {
  commitProductEnrichment,
  commitPurchaseImport,
  preparePurchaseImport,
  validatePurchaseImport,
} from "~/server/purchase-import/import-orders";
import {
  controlRun,
  issueBrowserCommand,
  readBrowserCommandResult,
  startOrResumeRun,
  startTargetedRun,
} from "~/server/purchase-import/run-service";
import { applyValidationCorrections } from "~/server/purchase-import/validation-corrections";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
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
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Synthetic ledger vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test/orders",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Synthetic ledger account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
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

  it("re-enqueues the recorded browser command under its derived id", async () => {
    const { run } = await startRun();
    const operationId = "browser-command:orders";
    const operation = {
      type: "navigate" as const,
      url: "https://shop.example.test/orders",
      allowedHosts: ["shop.example.test"],
    };
    const commandId = await sha256Uuid(`${run.id}:${operationId}`);
    // The row as `issueBrowserCommand` inserted it before the Worker died,
    // with a deadline no fresh command would carry.
    const command = {
      protocolVersion: BROWSER_BRIDGE_PROTOCOL,
      id: commandId,
      operationId,
      runID: run.id,
      deadline: "2030-01-01T00:00:00.000Z",
      operation,
    };
    await seed({
      runId: run.id,
      operationId,
      kind: "browser_command",
      inputFingerprint: await sha256Hex(
        JSON.stringify({
          protocolVersion: BROWSER_BRIDGE_PROTOCOL,
          id: commandId,
          operationId,
          runID: run.id,
          operation,
        }),
      ),
      result: { command, commandId },
    });
    const enqueued: BrowserBridgeRequest[] = [];
    const broker = {
      enqueue: async (request: BrowserBridgeRequest) => {
        enqueued.push(request);
      },
      result: async () => null,
      cancel: async () => undefined,
      connected: async () => true,
      pendingCommands: async () => [],
      notifyRunCompleted: async () => undefined,
      requestAuthentication: async () => undefined,
    };

    await expect(
      issueBrowserCommand(
        ctx.db,
        { getByName: () => broker },
        { runId: run.id, operationId, operation },
      ),
    ).resolves.toEqual({ commandId, state: "dispatched" });
    expect(enqueued).toEqual([command]);
    expect(await stored(run.id, operationId)).toMatchObject({
      kind: "browser_command",
      state: "completed",
      result: { command, commandId },
    });

    // Cancelling the Run reports that command to the broker and fails only
    // the rows still in flight.
    await seed({
      runId: run.id,
      operationId: "agent-progress:open",
      kind: "update_agent_progress",
      inputFingerprint: "0".repeat(64),
    });
    const cancelled = await controlRun(ctx.db, ctx.actor, {
      runPublicId: run.publicId,
      action: "cancel",
    });
    expect(cancelled).toMatchObject({
      status: "failed",
      cancelledBrowserCommandIds: [commandId],
    });
    expect(await stored(run.id, "agent-progress:open")).toMatchObject({
      state: "failed",
      error: "Run cancelled by its owner",
    });
    expect(await stored(run.id, operationId)).toMatchObject({
      state: "completed",
    });
  });

  /** A paused `mcp:<tool>` proposal as earlier code stored it, approved by a member. */
  const seedApprovedMcpMutation = async () => {
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
      action: "approve",
      operationId,
    });
    expect(approved).toMatchObject({ decision: "approved" });
    expect(await stored(run.id, operationId)).toMatchObject({
      state: "paused_approval",
      result: { approvalProposal, approvalId: approved.approvalId },
    });

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
    const { run, operationId, execute, executions } =
      await seedApprovedMcpMutation();
    await expect(execute()).resolves.toEqual({ accepted: true });
    await expect(execute()).resolves.toEqual({ accepted: true });
    expect(executions()).toBe(1);
    expect(await stored(run.id, operationId)).toMatchObject({
      state: "completed",
      result: { accepted: true },
    });
  });

  it("locks the Run before the operation when executing an approved mutation", async () => {
    const { run, operationId, execute, executions } =
      await seedApprovedMcpMutation();
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

  it("keeps a failed browser command's diagnostic when the command is replayed", async () => {
    const { run } = await startRun();
    const operationId = "browser-command:bad-link";
    let issued: BrowserBridgeRequest | undefined;
    const broker = {
      enqueue: async (request: BrowserBridgeRequest) => {
        issued = request;
      },
      result: async (): Promise<BrowserBridgeResult> => ({
        protocolVersion: BROWSER_BRIDGE_PROTOCOL,
        commandID: issued!.id,
        operationID: issued!.operationId,
        runID: run.id,
        completedAt: new Date().toISOString(),
        outcome: {
          status: "failed",
          code: "disallowed_url",
          message: "Navigation left the vendor allowlist",
          retryable: false,
          screenshotGap: null,
          observation: observation(),
        },
      }),
      cancel: async () => undefined,
      connected: async () => true,
      pendingCommands: async () => [],
      notifyRunCompleted: async () => undefined,
      requestAuthentication: async () => undefined,
    };
    const namespace = { getByName: () => broker };
    const input = {
      runId: run.id,
      operationId,
      operation: {
        type: "navigate" as const,
        url: "https://shop.example.test/orders",
        allowedHosts: ["shop.example.test"],
      },
    };
    await issueBrowserCommand(ctx.db, namespace, input);
    await readBrowserCommandResult(ctx.db, namespace, {
      runId: run.id,
      operationId,
    });
    await issueBrowserCommand(ctx.db, namespace, input);

    expect(await stored(run.id, operationId)).toMatchObject({
      state: "completed",
      error: expect.stringMatching(
        /^disallowed_url: Navigation left the vendor allowlist \[/u,
      ),
    });
  });

  it("replays a product enrichment commit by its parsed-input fingerprint", async () => {
    const { party } = await startRun();
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Synthetic enrichment vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const target = await createProductFixture(
      ctx.db,
      makeProductInput({ name: `Synthetic enrichment ${crypto.randomUUID()}` }),
      ctx.actor,
    );
    const [productRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, target.entityId));
    const started = await startTargetedRun(ctx.db, {
      ledgerPartyId: party.id,
      purpose: "product_enrichment",
      vendorId: vendor.id,
      trigger: "manual",
      targets: [
        {
          kind: "product",
          productId: target.entityId,
          targetFingerprint: "c".repeat(64),
        },
      ],
    });
    if (!started.created) throw new Error("Expected enrichment admission");
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "running" })
      .where(eq(runTable.id, started.run.id));
    const input = commitProductEnrichmentInput.parse({
      _runExecution: { runId: started.run.id, operationId: "enrich:1" },
      productId: productRow!.shortcode,
      targetFingerprint: "c".repeat(64),
      changes: { manufacturer: "Synthetic Works" },
    });
    const recorded = {
      runId: started.run.publicId,
      operationId: "enrich:1",
      productId: productRow!.shortcode,
      status: "running",
      changedFields: ["manufacturer"],
      skippedIdentifiers: [],
    };
    await seed({
      runId: started.run.id,
      operationId: "enrich:1",
      kind: "commit_product_enrichment",
      inputFingerprint: await sha256Hex(JSON.stringify(input)),
      state: "completed",
      result: recorded,
      completedAt: new Date(),
    });

    await expect(
      commitProductEnrichment(ctx.db, input, ctx.actor),
    ).resolves.toEqual(recorded);
    // Replay performed no write: the Product keeps its blank manufacturer.
    const [after] = await getDb(ctx.db)
      .select({ manufacturer: product.manufacturer })
      .from(product)
      .where(eq(product.id, target.entityId));
    expect(after?.manufacturer ?? "").not.toBe("Synthetic Works");
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
          kind: "browser_order" as const,
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

  it("replays validation and correction rows by their own fingerprints without writing", async () => {
    const { party } = await startRun();
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Synthetic validation vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const target = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "ORDER-LEDGER-1",
      date: "2026-09-20",
      statedTotal: 10,
    });
    const started = await startTargetedRun(ctx.db, {
      ledgerPartyId: party.id,
      purpose: "purchase_validation",
      vendorId: vendor.id,
      vendorAccountId: null,
      trigger: "manual",
      targets: [
        {
          kind: "purchase",
          purchaseId: target.id,
          sourceKind: "browser_order",
          sourceExternalKey: "validation:ORDER-LEDGER-1",
          targetFingerprint: "c".repeat(64),
          evidenceFingerprint: "a".repeat(64),
        },
      ],
    });
    if (!started.created) throw new Error("Expected validation admission");
    const setStatus = (status: "running" | "needs_review") =>
      getDb(ctx.db)
        .update(runTable)
        .set({ status })
        .where(eq(runTable.id, started.run.id));
    const targetRow = () =>
      getDb(ctx.db)
        .select({
          state: runTarget.state,
          outcome: runTarget.outcome,
          diff: runTarget.diff,
        })
        .from(runTarget)
        .where(eq(runTarget.runId, started.run.id));
    const targetBefore = await targetRow();

    // Validation fingerprints its whole parsed input, envelope first.
    await setStatus("running");
    const validationResult = {
      runId: started.run.publicId,
      operationId: "validate:1",
      status: "completed",
      targets: [{ stableOrderId: "order-1", outcome: "replayed", diff: null }],
    };
    await seed({
      runId: started.run.id,
      operationId: "validate:1",
      kind: "validate_purchase_import",
      inputFingerprint: await sha256Hex(
        JSON.stringify({
          _runExecution: { runId: started.run.id, operationId: "validate:1" },
          prepareOperationId: "prepare:1",
          resolutions: [],
        }),
      ),
      state: "completed",
      result: validationResult,
      completedAt: new Date(),
    });
    const validate = (prepareOperationId: string) =>
      validatePurchaseImport(
        ctx.db,
        validatePurchaseImportInput.parse({
          _runExecution: { runId: started.run.id, operationId: "validate:1" },
          prepareOperationId,
          resolutions: [],
        }),
        ctx.actor,
      );
    await expect(validate("prepare:1")).resolves.toEqual(validationResult);
    await expect(validate("prepare:2")).rejects.toThrow(
      "Operation id was replayed with different input",
    );

    // Corrections fingerprint the input with its selection deduplicated and
    // sorted in place, so a reordered selection is the same operation.
    await setStatus("needs_review");
    const correctionResult = {
      status: "applied",
      runId: started.run.publicId,
      purchaseId: target.shortcode,
      operationId: "apply:1",
      applied: ["expense:add:a", "purchase:statedTotal"],
      outcome: "replayed",
      remainingCorrections: 0,
    };
    await seed({
      runId: started.run.id,
      operationId: "apply:1",
      kind: "apply_validation_corrections",
      inputFingerprint: await sha256Hex(
        JSON.stringify({
          runId: started.run.publicId,
          purchaseId: target.shortcode,
          operationId: "apply:1",
          correctionIds: ["expense:add:a", "purchase:statedTotal"],
        }),
      ),
      state: "completed",
      result: correctionResult,
      completedAt: new Date(),
    });
    const apply = (correctionIds: string[]) =>
      applyValidationCorrections(
        ctx.db,
        {
          runId: started.run.publicId,
          purchaseId: target.shortcode,
          operationId: "apply:1",
          correctionIds,
        },
        ctx.actor,
      );
    await expect(
      apply(["purchase:statedTotal", "expense:add:a", "purchase:statedTotal"]),
    ).resolves.toEqual({
      result: correctionResult,
      priceAffectedProductIds: [],
    });
    await expect(apply(["purchase:statedTotal"])).rejects.toThrow(
      "Operation id was replayed with different input",
    );

    // Neither replay touched the target or added a ledger row.
    expect(await targetRow()).toEqual(targetBefore);
    const rows = await getDb(ctx.db)
      .select({ operationId: runOperation.operationId })
      .from(runOperation)
      .where(eq(runOperation.runId, started.run.id));
    expect(rows.map((row) => row.operationId).sort()).toEqual([
      "apply:1",
      "validate:1",
    ]);
  });
});
