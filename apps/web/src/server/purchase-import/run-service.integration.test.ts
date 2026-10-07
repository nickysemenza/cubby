import { runEntityId } from "@cubby/schemas/identifiers";
import type {
  BrowserBridgeRequest,
  BrowserBridgeResult,
} from "@cubby/schemas/purchase-import";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { executeLeasedOperation } from "~/server/runs/operation";

import { dispatchRunEvent, recordRunDispatchAttempt } from "./dispatch";
import {
  AccountOccupiedError,
  controlRun,
  expireStaleRuns,
  finishRun,
  issueBrowserCommand,
  claimNextImportWork,
  readBrowserCommandResult,
  reconcileSettledRun,
  resumeAuthorizedRuns,
  startOrResumeRun,
  startTargetedRun,
} from "./run-service";

describe("purchase import run admission", () => {
  const ctx = withTestDb();

  const createMember = async () => {
    const { insertWithShortcode } =
      await import("~/server/repo/shortcode-utils");
    return insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Import test member",
      kind: "member",
      userId: ctx.actor.userId,
    });
  };

  const createVendorAccount = async (
    ledgerPartyId: Awaited<ReturnType<typeof createMember>>["id"],
  ) => {
    const { insertWithShortcode } =
      await import("~/server/repo/shortcode-utils");
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Import vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test/orders",
      browserDomains: ["shop.example.test"],
    });
    return insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Import test account",
      vendorId: vendor.id,
      ledgerPartyId,
    });
  };

  // "Sync now" or a charge hunt on an account an enrichment or validation run
  // holds must not resume that run as if it were the sync, nor poke its agent.
  it("refuses an account sync while another kind of run holds the account", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const { insertWithShortcode } =
      await import("~/server/repo/shortcode-utils");
    const target = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: account.vendorId,
      vendorAccountId: account.id,
      orderId: "OCCUPIED-1",
      date: "2026-09-01",
    });
    const validation = await startTargetedRun(ctx.db, {
      ledgerPartyId: party.id,
      purpose: "purchase_validation",
      vendorId: account.vendorId,
      vendorAccountId: account.id,
      trigger: "manual",
      targets: [
        {
          kind: "purchase",
          purchaseId: target.id,
          targetFingerprint: "a".repeat(64),
        },
      ],
    });
    if (!validation.created) throw new Error("Expected a validation run");
    const sync = startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    await expect(sync).rejects.toBeInstanceOf(AccountOccupiedError);
    await expect(sync).rejects.toThrow(validation.run.publicId);
  });

  it("atomically admits one active run per vendor account", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);

    const [first, second] = await Promise.all([
      startOrResumeRun(ctx.db, {
        ledgerPartyId: party.id,
        vendorAccountId: account.id,
        trigger: "manual",
      }),
      startOrResumeRun(ctx.db, {
        ledgerPartyId: party.id,
        vendorAccountId: account.id,
        trigger: "foreground",
      }),
    ]);

    expect(first.id).toBe(second.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    const { run: runTable } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    const [stored] = await getDb(ctx.db)
      .select({
        coordinatorModel: runTable.coordinatorModel,
        skillRevision: runTable.skillRevision,
        runtimeRevision: runTable.runtimeRevision,
      })
      .from(runTable)
      .where(eq(runTable.id, first.id));
    // Admission omits both revisions, so the migrated column defaults stamp them.
    expect(stored).toEqual({
      coordinatorModel: "gpt-6-sol",
      skillRevision: "purchase-import@1",
      runtimeRevision: "pi-durable@1",
    });
  });

  it("refuses browser import for a mail-only Vendor account", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const { vendorAccount } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    await getDb(ctx.db)
      .update(vendorAccount)
      .set({ browserSyncEnabled: false, status: "disabled" })
      .where(eq(vendorAccount.id, account.id));

    await expect(
      startOrResumeRun(ctx.db, {
        ledgerPartyId: party.id,
        vendorAccountId: account.id,
        trigger: "manual",
      }),
    ).rejects.toThrow("Browser sync is not enabled");

    // A member who confirms an online login turns the mail-only account on
    // through the ordinary entity update; it used to drop the field.
    const { entityKernelContextSchema, executeEntity } =
      await import("~/server/entity-kernel");
    const { requireActor } = await import("~/server/request-context");
    const { createTestRequestContext } =
      await import("~/server/testing/request-context");
    const updated = await executeEntity(
      entityKernelContextSchema.parse(
        requireActor(
          createTestRequestContext(ctx.db, {
            auth: { userId: ctx.actor.userId },
          }),
        ),
      ),
      {
        action: "update",
        entity: "vendorAccount",
        id: account.shortcode,
        data: { browserSyncEnabled: true, status: "active" },
      },
    );
    if (updated.action !== "update") throw new Error("expected update");
    expect(updated.item).toMatchObject({ browserSyncEnabled: true });
    await expect(
      startOrResumeRun(ctx.db, {
        ledgerPartyId: party.id,
        vendorAccountId: account.id,
        trigger: "manual",
      }),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("retries a historical run on the current coordinator model", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const { run: runTable } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    await getDb(ctx.db)
      .update(runTable)
      .set({
        status: "completed",
        endedAt: new Date(),
        coordinatorModel: "retired-model",
      })
      .where(eq(runTable.id, run.id));

    const successor = await controlRun(ctx.db, ctx.actor, {
      runPublicId: run.publicId,
      action: "retry",
    });
    const [storedSuccessor] = await getDb(ctx.db)
      .select({ coordinatorModel: runTable.coordinatorModel })
      .from(runTable)
      .where(eq(runTable.id, runEntityId.parse(successor.successorRunId)));
    expect(storedSuccessor?.coordinatorModel).toBe("gpt-6-sol");
  });

  it("resumes authorization with a persisted dispatch generation", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const { run: runTable } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "paused_auth", coordinatorStartedAt: new Date() })
      .where(eq(runTable.id, run.id));

    const [resumed] = await resumeAuthorizedRuns(ctx.db, ctx.actor.userId);
    expect(resumed?.eventId).toEqual(expect.any(String));
    expect(resumed?.eventId).not.toBe(run.dispatchEventId);
    const [stored] = await getDb(ctx.db)
      .select({
        eventId: runTable.dispatchEventId,
        coordinatorStartedAt: runTable.coordinatorStartedAt,
      })
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(stored).toEqual({
      eventId: resumed?.eventId,
      coordinatorStartedAt: null,
    });

    await recordRunDispatchAttempt(ctx.db, {
      runId: run.id,
      eventId: resumed!.eventId!,
      error: "queue unavailable",
    });
    const [failed] = await getDb(ctx.db)
      .select({ status: runTable.status, error: runTable.dispatchError })
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(failed).toEqual({
      status: "dispatch_failed",
      error: "queue unavailable",
    });
  });

  it("dispatches a manually resumed retailer sign-in run instead of leaving it idle", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const { run: runTable } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "paused_auth", coordinatorStartedAt: new Date() })
      .where(eq(runTable.id, run.id));

    const resumed = await controlRun(ctx.db, ctx.actor, {
      runPublicId: run.publicId,
      action: "resume",
    });
    expect(resumed).toMatchObject({
      status: "running",
      dispatchRunId: run.id,
      dispatchPurpose: "account_sync",
      dispatchEventId: expect.any(String),
    });
    const [stored] = await getDb(ctx.db)
      .select({
        eventId: runTable.dispatchEventId,
        coordinatorStartedAt: runTable.coordinatorStartedAt,
      })
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(stored?.eventId).not.toBe(run.dispatchEventId);
    expect(stored?.coordinatorStartedAt).toBeNull();
  });

  it("republishes an interrupted authorization dispatch with its stable event id", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const { run: runTable } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    const now = new Date("2026-09-20T20:00:00.000Z");
    await getDb(ctx.db)
      .update(runTable)
      .set({ updatedAt: new Date(now.getTime() - 61_000) })
      .where(eq(runTable.id, run.id));

    const repaired = await resumeAuthorizedRuns(ctx.db, ctx.actor.userId, now);

    expect(repaired).toContainEqual(
      expect.objectContaining({ id: run.id, eventId: run.dispatchEventId }),
    );
  });

  it("accepts a producer receipt after the consumer advances the run", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const { run: runTable } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    if (!run.dispatchEventId)
      throw new Error("Run did not have a dispatch event");

    for (const status of ["paused_auth", "completed"] as const) {
      await getDb(ctx.db)
        .update(runTable)
        .set({ status })
        .where(eq(runTable.id, run.id));
      await expect(
        recordRunDispatchAttempt(ctx.db, {
          runId: run.id,
          eventId: run.dispatchEventId,
        }),
      ).resolves.toMatchObject({ id: run.id, status });
    }
  });

  it("creates an evidence-only validation successor without mutating the Purchase", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const { insertWithShortcode } =
      await import("~/server/repo/shortcode-utils");
    const target = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: account.vendorId,
      vendorAccountId: account.id,
      date: "2026-09-20",
      displayLabel: "Validation target",
    });
    const started = await startTargetedRun(ctx.db, {
      ledgerPartyId: party.id,
      purpose: "purchase_validation",
      vendorId: account.vendorId,
      vendorAccountId: account.id,
      trigger: "manual",
      targets: [
        {
          kind: "purchase",
          purchaseId: target.id,
          vendorAccountId: account.id,
          targetFingerprint: "a".repeat(64),
        },
      ],
    });
    if (!started.created) throw new Error("Expected validation admission");
    const { run: runTable, runTarget } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "needs_review", endedAt: new Date() })
      .where(eq(runTable.id, started.run.id));

    const result = await controlRun(ctx.db, ctx.actor, {
      runPublicId: started.run.publicId,
      action: "upload_evidence",
    });

    expect(result).toMatchObject({
      created: true,
      successorStatus: "dispatch_failed",
      dispatchRunId: null,
      dispatchEventId: expect.any(String),
    });
    const [successorTarget] = await getDb(ctx.db)
      .select({
        purchaseId: runTarget.entityId,
        state: runTarget.state,
      })
      .from(runTarget)
      .where(eq(runTarget.runId, result.successorRunId!));
    expect(successorTarget).toEqual({
      purchaseId: target.id,
      state: "needs_evidence",
    });
  });

  it("returns the recorded tool result without replaying its effect", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    let calls = 0;
    const input = {
      runId: run.id,
      operationId: "test:replay",
      kind: "test",
      payload: { value: 7 },
    };
    const first = await executeLeasedOperation(ctx.db, input, async () => {
      calls += 1;
      return { value: 7 };
    });
    const replay = await executeLeasedOperation(ctx.db, input, async () => {
      calls += 1;
      return { value: 9 };
    });

    expect(first).toEqual({ value: 7 });
    expect(replay).toEqual(first);
    expect(calls).toBe(1);
    await expect(
      executeLeasedOperation(
        ctx.db,
        { ...input, payload: { value: 8 } },
        async () => ({ value: 8 }),
      ),
    ).rejects.toThrow("different input");
  });

  it("reclaims a stale started operation after a worker crash", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const input = {
      runId: run.id,
      operationId: "test:stale-operation",
      kind: "test",
      payload: { value: 1 },
    };
    await expect(
      executeLeasedOperation(ctx.db, input, async () => {
        throw new Error("injected crash");
      }),
    ).rejects.toThrow("injected crash");
    const [{ eq }, { getDb }, { runOperation }] = await Promise.all([
      import("drizzle-orm"),
      import("~/server/repo/database-helpers"),
      import("~/server/db/schema"),
    ]);
    await getDb(ctx.db)
      .update(runOperation)
      .set({ state: "started", updatedAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(runOperation.operationId, input.operationId));

    await expect(
      executeLeasedOperation(ctx.db, input, async () => ({ recovered: true })),
    ).resolves.toEqual({ recovered: true });
  });

  it("replays the exact persisted browser command for one operation id", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const commands: BrowserBridgeRequest[] = [];
    const broker = {
      enqueue: async (command: BrowserBridgeRequest) => {
        commands.push(command);
      },
      result: async () => null,
      cancel: async () => undefined,
      connected: async () => true,
      pendingCommands: async () => [],
      notifyRunCompleted: async () => undefined,
      requestAuthentication: async () => undefined,
    };
    const namespace = { getByName: () => broker };
    const input = {
      runId: run.id,
      operationId: "browser:stable-command",
      operation: {
        type: "navigate" as const,
        url: "https://shop.example.test/orders",
        allowedHosts: ["shop.example.test"],
      },
    };

    const first = await issueBrowserCommand(ctx.db, namespace, input);
    const replay = await issueBrowserCommand(ctx.db, namespace, input);

    expect(replay).toEqual(first);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
  });

  it("rejects a capture recovery URL outside the vendor allowlist", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const broker = {
      enqueue: async () => undefined,
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
        {
          runId: run.id,
          operationId: "browser:disallowed-recovery",
          operation: {
            type: "capture",
            allowedHosts: ["shop.example.test"],
            enhancedEvidence: false,
            recoveryURL: "https://attacker.example/orders",
          },
        },
      ),
    ).rejects.toThrow("outside the vendor allowlist");
  });

  it("replays terminal completion after the run status already committed", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const notifications: string[] = [];
    const broker = {
      enqueue: async () => undefined,
      result: async () => null,
      cancel: async () => undefined,
      connected: async () => true,
      pendingCommands: async () => [],
      notifyRunCompleted: async ({ runID }: { runID: string }) => {
        notifications.push(runID);
      },
      requestAuthentication: async () => undefined,
    };
    const namespace = { getByName: () => broker };
    const input = { runId: run.id, operationId: "finish:replay" };

    const first = await finishRun(ctx.db, namespace, input);
    const replay = await finishRun(ctx.db, namespace, input);

    expect(replay).toEqual(first);
    expect(notifications).toEqual([run.id, run.id]);
  });
  it("counts the initial dispatch as an attempt, not only retries", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const { run: runTable } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    const sent: string[] = [];

    await dispatchRunEvent(
      ctx.db,
      {
        send: async (event) => {
          sent.push(event.type);
        },
      },
      {
        version: 1,
        runId: run.id,
        eventId: run.dispatchEventId!,
        type: "start_or_resume",
      },
    );

    const [stored] = await getDb(ctx.db)
      .select({ attempts: runTable.dispatchAttempts })
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(sent).toEqual(["start_or_resume"]);
    expect(stored?.attempts).toBe(1);
  });

  it("moves a run whose coordinator settled without finishing to review, unless a browser command is in flight", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    let pending = true;
    const broker = {
      enqueue: async () => undefined,
      result: async () => null,
      cancel: async () => undefined,
      connected: async () => true,
      pendingCommands: async () =>
        pending
          ? [{ requestId: crypto.randomUUID(), createdAt: Date.now() }]
          : [],
      notifyRunCompleted: async () => undefined,
      requestAuthentication: async () => undefined,
    };
    const namespace = { getByName: () => broker };

    await expect(
      reconcileSettledRun(ctx.db, namespace, {
        runId: run.id,
        operationId: "settled:1",
      }),
    ).resolves.toEqual({ reconciled: false, status: "running" });

    pending = false;
    await expect(
      reconcileSettledRun(ctx.db, namespace, {
        runId: run.id,
        operationId: "settled:2",
      }),
    ).resolves.toEqual({ reconciled: true, status: "needs_review" });
    const { runFinding, run: runTable } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    const [stored] = await getDb(ctx.db)
      .select({ status: runTable.status })
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(stored?.status).toBe("needs_review");
    const findings = await getDb(ctx.db)
      .select({ kind: runFinding.kind, summary: runFinding.summary })
      .from(runFinding)
      .where(eq(runFinding.runId, run.id));
    expect(findings).toEqual([
      expect.objectContaining({
        kind: "other",
        summary: "Coordinator ended without finishing the run",
      }),
    ]);
  });

  it("keeps a settled run running until the agent has received every wake the server issued", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const commandId = crypto.randomUUID();
    let answered: string | null = null;
    let awaitingMac = false;
    const broker = {
      enqueue: async () => undefined,
      // SAFETY: reconcile only asks whether a result exists, not its shape.
      result: async (id: string) =>
        id === answered ? ({} as BrowserBridgeResult) : null,
      cancel: async () => undefined,
      connected: async () => true,
      pendingCommands: async () =>
        awaitingMac
          ? [{ requestId: crypto.randomUUID(), createdAt: Date.now() }]
          : [],
      notifyRunCompleted: async () => undefined,
      requestAuthentication: async () => undefined,
    };
    const namespace = { getByName: () => broker };
    const { runApproval, runOperation } = await import("~/server/db/schema");
    const { getDb } = await import("~/server/repo/database-helpers");
    const [approval] = await getDb(ctx.db)
      .insert(runApproval)
      .values({
        runId: run.id,
        operationId: "note-rejected",
        operationKind: "mcp:entity",
        args: {},
        argsFingerprint: "args",
        targetFingerprint: "target",
        evidenceFingerprint: "evidence",
        state: "rejected",
        decidedAt: new Date(),
        rejectedAt: new Date(),
      })
      .returning({ id: runApproval.id });
    await getDb(ctx.db).insert(runOperation).values({
      runId: run.id,
      operationId: "browser-1",
      kind: "browser_command",
      inputFingerprint: "browser-1",
      state: "completed",
      result: { commandId },
    });
    answered = commandId;
    const settle = (
      receivedEventIds: string[],
      failure?: { failureCode: "agent_failed" },
    ) =>
      reconcileSettledRun(ctx.db, namespace, {
        runId: run.id,
        operationId: `submission-settled:${receivedEventIds.length}`,
        receivedEventIds: new Set(receivedEventIds),
        failure,
      });
    const kept = { reconciled: false, status: "running" };
    const dispatch = run.dispatchEventId!;
    const wake = `approval:${approval!.id}:rejected`;
    const result = `browser-result:${commandId}`;

    // The current dispatch generation is still queued for the agent.
    await expect(settle([wake, result])).resolves.toEqual(kept);
    // A member's decision woke the agent, but the wake has not arrived.
    await expect(settle([dispatch, result])).resolves.toEqual(kept);
    // The Mac answered, but its result event has not reached the agent.
    await expect(settle([dispatch, wake])).resolves.toEqual(kept);
    // An unanswered submission passes the same fence before failing the run.
    await expect(
      settle([wake, result], { failureCode: "agent_failed" }),
    ).resolves.toEqual(kept);
    // A command still awaiting the Mac will resume the conversation, so not
    // even an unanswered submission fails the run.
    awaitingMac = true;
    await expect(
      settle([dispatch, wake, result], { failureCode: "agent_failed" }),
    ).resolves.toEqual(kept);
    awaitingMac = false;
    await expect(settle([dispatch, wake, result])).resolves.toEqual({
      reconciled: true,
      status: "needs_review",
    });
  });

  it("expires only runs with no coordinator activity for two hours", async () => {
    const party = await createMember();
    const staleAccount = await createVendorAccount(party.id);
    const liveAccount = await createVendorAccount(party.id);
    const stale = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: staleAccount.id,
      trigger: "manual",
    });
    const live = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: liveAccount.id,
      trigger: "manual",
    });
    const { run: runTable } = await import("~/server/db/schema");
    const { inArray } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    const now = new Date("2026-09-21T12:00:00.000Z");
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60_000);
    await getDb(ctx.db)
      .update(runTable)
      .set({ updatedAt: threeHoursAgo })
      .where(inArray(runTable.id, [stale.id, live.id]));
    // A progress report inside the window is activity even when the run row
    // itself was not touched.
    await executeLeasedOperation(
      ctx.db,
      {
        runId: live.id,
        operationId: "live:op",
        kind: "claim_next_work",
        payload: {},
      },
      async () => ({ ok: true }),
    );
    const broker = {
      enqueue: async () => undefined,
      result: async () => null,
      cancel: async () => undefined,
      connected: async () => true,
      pendingCommands: async () => [],
      notifyRunCompleted: async () => undefined,
      requestAuthentication: async () => undefined,
    };

    const outcome = await expireStaleRuns(
      ctx.db,
      { getByName: () => broker },
      now,
    );

    expect(outcome).toEqual({ expired: 1, failures: [] });
    const rows = await getDb(ctx.db)
      .select({ id: runTable.id, status: runTable.status })
      .from(runTable)
      .where(inArray(runTable.id, [stale.id, live.id]));
    expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual(
      {
        [stale.id]: "needs_review",
        [live.id]: "running",
      },
    );
  });
  it("records a terminal browser failure on the operation row instead of only returning it", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    let issued: BrowserBridgeRequest | undefined;
    const broker = {
      enqueue: async (command: BrowserBridgeRequest) => {
        issued = command;
      },
      result: async (): Promise<BrowserBridgeResult> => ({
        protocolVersion: 2,
        commandID: issued!.id,
        operationID: issued!.operationId,
        runID: run.id,
        completedAt: new Date().toISOString(),
        outcome: {
          status: "failed",
          code: "disallowed_url",
          message: "Navigation left the vendor allowlist",
          retryable: false,
        },
      }),
      cancel: async () => undefined,
      connected: async () => true,
      pendingCommands: async () => [],
      notifyRunCompleted: async () => undefined,
      requestAuthentication: async () => undefined,
    };
    const namespace = { getByName: () => broker };
    await issueBrowserCommand(ctx.db, namespace, {
      runId: run.id,
      operationId: "browser:bad-link",
      operation: {
        type: "navigate",
        url: "https://shop.example.test/orders",
        allowedHosts: ["shop.example.test"],
      },
    });

    const read = await readBrowserCommandResult(ctx.db, namespace, {
      runId: run.id,
      operationId: "browser:bad-link",
    });

    expect(read.state).toBe("completed");
    const { runOperation } = await import("~/server/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    const [operation] = await getDb(ctx.db)
      .select({
        state: runOperation.state,
        error: runOperation.error,
      })
      .from(runOperation)
      .where(
        and(
          eq(runOperation.runId, run.id),
          eq(runOperation.operationId, "browser:bad-link"),
        ),
      );
    expect(operation).toEqual({
      state: "failed",
      error: "disallowed_url: Navigation left the vendor allowlist",
    });
  });
  // An outdated Mac once reported every capture as "The evidence file could
  // not be staged", a retryable failure no retry fixed. Its command now fails
  // naming the update, and the run is not parked waiting for a reconnect
  // that could never wake it.
  // An outdated Mac once reported every capture as "The evidence file could
  // not be staged", a retryable failure no retry fixed. The run now stops for
  // review naming the update, from any active status, and a repeated read of
  // the same result answers the same way. A paused run also proves the stop
  // survives an import audit that cannot run (the audit refuses a paused run).
  it.each(["running", "paused_offline"] as const)(
    "stops a %s run for review when the Mac app is too old for the server",
    async (status) => {
      const party = await createMember();
      const account = await createVendorAccount(party.id);
      const run = await startOrResumeRun(ctx.db, {
        ledgerPartyId: party.id,
        vendorAccountId: account.id,
        trigger: "manual",
      });
      let issued: BrowserBridgeRequest | undefined;
      const broker = {
        enqueue: async (command: BrowserBridgeRequest) => {
          issued = command;
        },
        result: async (): Promise<BrowserBridgeResult> => ({
          protocolVersion: 2,
          commandID: issued!.id,
          operationID: issued!.operationId,
          runID: run.id,
          completedAt: new Date().toISOString(),
          outcome: {
            status: "failed",
            code: "client_update_required",
            message: "Update Cubby for Mac, then restart this run.",
            retryable: false,
          },
        }),
        cancel: async () => undefined,
        connected: async () => true,
        pendingCommands: async () => [],
        notifyRunCompleted: async () => undefined,
        requestAuthentication: async () => undefined,
      };
      const namespace = { getByName: () => broker };
      await issueBrowserCommand(ctx.db, namespace, {
        runId: run.id,
        operationId: "browser:outdated",
        operation: {
          type: "navigate",
          url: "https://shop.example.test/orders",
          allowedHosts: ["shop.example.test"],
        },
      });
      const {
        run: runTable,
        runFinding,
        runOperation,
      } = await import("~/server/db/schema");
      const { and, eq } = await import("drizzle-orm");
      const { getDb } = await import("~/server/repo/database-helpers");
      const { vendorAccount } = await import("~/server/db/schema");
      await getDb(ctx.db)
        .update(runTable)
        .set({ status })
        .where(eq(runTable.id, run.id));
      if (status === "paused_offline")
        await getDb(ctx.db)
          .update(vendorAccount)
          .set({ status: "paused_offline" })
          .where(eq(vendorAccount.id, account.id));

      const read = () =>
        readBrowserCommandResult(ctx.db, namespace, {
          runId: run.id,
          operationId: "browser:outdated",
        });
      // "stopped" ends the agent's submission; a second read answers the same.
      expect((await read()).state).toBe("stopped");
      expect((await read()).state).toBe("stopped");

      const [operation] = await getDb(ctx.db)
        .select({ state: runOperation.state, error: runOperation.error })
        .from(runOperation)
        .where(
          and(
            eq(runOperation.runId, run.id),
            eq(runOperation.operationId, "browser:outdated"),
          ),
        );
      expect(operation).toEqual({
        state: "failed",
        error:
          "client_update_required: Update Cubby for Mac, then restart this run.",
      });
      const [row] = await getDb(ctx.db)
        .select({ status: runTable.status, failureCode: runTable.failureCode })
        .from(runTable)
        .where(eq(runTable.id, run.id));
      expect(row).toEqual({
        status: "needs_review",
        failureCode: "client_update_required",
      });
      const [accountRow] = await getDb(ctx.db)
        .select({ status: vendorAccount.status })
        .from(vendorAccount)
        .where(eq(vendorAccount.id, account.id));
      expect(accountRow?.status).toBe("active");
      expect(
        await getDb(ctx.db)
          .select({ summary: runFinding.summary })
          .from(runFinding)
          .where(eq(runFinding.runId, run.id)),
      ).toEqual([{ summary: expect.stringContaining("Update Cubby for Mac") }]);
    },
  );
  // A reconnect claim that read "paused_offline" must not resume a run that
  // was stopped while it waited on the bridge (an outdated Mac's stop).
  it("never resumes a run that stopped while the claim checked the bridge", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const { run: runTable } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "paused_offline" })
      .where(eq(runTable.id, run.id));
    const broker = {
      enqueue: async () => undefined,
      result: async () => null,
      cancel: async () => undefined,
      connected: async () => {
        await getDb(ctx.db)
          .update(runTable)
          .set({
            status: "needs_review",
            failureCode: "client_update_required",
          })
          .where(eq(runTable.id, run.id));
        return true;
      },
      pendingCommands: async () => [],
      notifyRunCompleted: async () => undefined,
      requestAuthentication: async () => undefined,
    };

    await expect(
      claimNextImportWork(ctx.db, { getByName: () => broker }, run.id),
    ).rejects.toThrow(/fenced/u);
    const [row] = await getDb(ctx.db)
      .select({ status: runTable.status, failureCode: runTable.failureCode })
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(row).toEqual({
      status: "needs_review",
      failureCode: "client_update_required",
    });
  });
  it("abandons a browser command nobody answered within the stale window", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const { run: runTable } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    const now = new Date("2026-09-21T12:00:00.000Z");
    await getDb(ctx.db)
      .update(runTable)
      .set({ updatedAt: new Date(now.getTime() - 3 * 60 * 60_000) })
      .where(eq(runTable.id, run.id));
    const cancelled: string[] = [];
    const stale = {
      requestId: crypto.randomUUID(),
      createdAt: now.getTime() - 19 * 60 * 60_000,
    };
    const broker = {
      enqueue: async () => undefined,
      result: async () => null,
      cancel: async (requestId: string) => {
        cancelled.push(requestId);
      },
      connected: async () => true,
      pendingCommands: async () => [stale],
      notifyRunCompleted: async () => undefined,
      requestAuthentication: async () => undefined,
    };

    const outcome = await expireStaleRuns(
      ctx.db,
      { getByName: () => broker },
      now,
    );

    expect(outcome).toEqual({ expired: 1, failures: [] });
    expect(cancelled).toEqual([stale.requestId]);
    const [stored] = await getDb(ctx.db)
      .select({ status: runTable.status })
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(stored?.status).toBe("needs_review");
  });
});
