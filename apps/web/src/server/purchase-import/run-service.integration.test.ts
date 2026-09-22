import type {
  BrowserBridgeRequest,
  BrowserBridgeResult,
} from "@cubby/schemas/purchase-import";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  dispatchImportRunEvent,
  recordImportRunDispatchAttempt,
} from "./dispatch";
import {
  controlImportRun,
  expireStaleImportRuns,
  finishImportRun,
  issueBrowserCommand,
  loadImportRunByPublicId,
  readBrowserCommandResult,
  reconcileSettledImportRun,
  resumeAuthorizedImportRuns,
  runImportOperation,
  startOrResumeImportRun,
  startTargetedImportRun,
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

  it("atomically admits one active run per vendor account", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);

    const [first, second] = await Promise.all([
      startOrResumeImportRun(ctx.db, {
        ledgerPartyId: party.id,
        vendorAccountId: account.id,
        trigger: "manual",
      }),
      startOrResumeImportRun(ctx.db, {
        ledgerPartyId: party.id,
        vendorAccountId: account.id,
        trigger: "foreground",
      }),
    ]);

    expect(first.id).toBe(second.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
  });

  it("returns the unpriced usage count as a runtime number", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const { aiUsage } = await import("~/server/db/schema");
    const { getDb } = await import("~/server/repo/database-helpers");

    const empty = await loadImportRunByPublicId(
      ctx.db,
      ctx.actor,
      run.publicId,
    );
    expect(empty.usage.unpricedCount).toBe(0);

    await getDb(ctx.db).insert(aiUsage).values({
      feature: "purchase_import",
      provider: "test",
      model: "test-model",
      operation: "extract",
      jobKind: "purchase_import_run",
      jobId: run.id,
      status: "succeeded",
      estimatedCost: null,
      durationMs: 1,
    });
    const withUsage = await loadImportRunByPublicId(
      ctx.db,
      ctx.actor,
      run.publicId,
    );
    expect(withUsage.usage.unpricedCount).toBe(1);
  });

  it("resumes authorization with a persisted dispatch generation", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const { importRun } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    await getDb(ctx.db)
      .update(importRun)
      .set({ status: "paused_auth", coordinatorStartedAt: new Date() })
      .where(eq(importRun.id, run.id));

    const [resumed] = await resumeAuthorizedImportRuns(
      ctx.db,
      ctx.actor.userId,
    );
    expect(resumed?.eventId).toEqual(expect.any(String));
    expect(resumed?.eventId).not.toBe(run.dispatchEventId);
    const [stored] = await getDb(ctx.db)
      .select({
        eventId: importRun.dispatchEventId,
        coordinatorStartedAt: importRun.coordinatorStartedAt,
      })
      .from(importRun)
      .where(eq(importRun.id, run.id));
    expect(stored).toEqual({
      eventId: resumed?.eventId,
      coordinatorStartedAt: null,
    });

    await recordImportRunDispatchAttempt(ctx.db, {
      runId: run.id,
      eventId: resumed!.eventId!,
      error: "queue unavailable",
    });
    const [failed] = await getDb(ctx.db)
      .select({ status: importRun.status, error: importRun.dispatchError })
      .from(importRun)
      .where(eq(importRun.id, run.id));
    expect(failed).toEqual({
      status: "dispatch_failed",
      error: "queue unavailable",
    });
  });

  it("republishes an interrupted authorization dispatch with its stable event id", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const { importRun } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    const now = new Date("2026-09-20T20:00:00.000Z");
    await getDb(ctx.db)
      .update(importRun)
      .set({ updatedAt: new Date(now.getTime() - 61_000) })
      .where(eq(importRun.id, run.id));

    const repaired = await resumeAuthorizedImportRuns(
      ctx.db,
      ctx.actor.userId,
      now,
    );

    expect(repaired).toContainEqual(
      expect.objectContaining({ id: run.id, eventId: run.dispatchEventId }),
    );
  });

  it("accepts a producer receipt after the consumer advances the run", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const { importRun } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    if (!run.dispatchEventId)
      throw new Error("Run did not have a dispatch event");

    for (const status of ["paused_auth", "completed"] as const) {
      await getDb(ctx.db)
        .update(importRun)
        .set({ status })
        .where(eq(importRun.id, run.id));
      await expect(
        recordImportRunDispatchAttempt(ctx.db, {
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
    const started = await startTargetedImportRun(ctx.db, {
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
    const { importRun, importRunTarget } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    await getDb(ctx.db)
      .update(importRun)
      .set({ status: "needs_review", endedAt: new Date() })
      .where(eq(importRun.id, started.run.id));

    const result = await controlImportRun(ctx.db, ctx.actor, {
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
        purchaseId: importRunTarget.purchaseId,
        state: importRunTarget.state,
      })
      .from(importRunTarget)
      .where(eq(importRunTarget.runId, result.successorRunId!));
    expect(successorTarget).toEqual({
      purchaseId: target.id,
      state: "needs_evidence",
    });
  });

  it("returns the recorded tool result without replaying its effect", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeImportRun(ctx.db, {
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
    const first = await runImportOperation(ctx.db, input, async () => {
      calls += 1;
      return { value: 7 };
    });
    const replay = await runImportOperation(ctx.db, input, async () => {
      calls += 1;
      return { value: 9 };
    });

    expect(first).toEqual({ value: 7 });
    expect(replay).toEqual(first);
    expect(calls).toBe(1);
    await expect(
      runImportOperation(
        ctx.db,
        { ...input, payload: { value: 8 } },
        async () => ({ value: 8 }),
      ),
    ).rejects.toThrow("different input");
  });

  it("reclaims a stale started operation after a worker crash", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeImportRun(ctx.db, {
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
      runImportOperation(ctx.db, input, async () => {
        throw new Error("injected crash");
      }),
    ).rejects.toThrow("injected crash");
    const [{ eq }, { getDb }, { importRunOperation }] = await Promise.all([
      import("drizzle-orm"),
      import("~/server/repo/database-helpers"),
      import("~/server/db/schema"),
    ]);
    await getDb(ctx.db)
      .update(importRunOperation)
      .set({ state: "started", updatedAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(importRunOperation.operationId, input.operationId));

    await expect(
      runImportOperation(ctx.db, input, async () => ({ recovered: true })),
    ).resolves.toEqual({ recovered: true });
  });

  it("replays the exact persisted browser command for one operation id", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeImportRun(ctx.db, {
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
      hasPendingCommands: async () => false,
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
    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const broker = {
      enqueue: async () => undefined,
      result: async () => null,
      cancel: async () => undefined,
      connected: async () => true,
      hasPendingCommands: async () => false,
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
    const run = await startOrResumeImportRun(ctx.db, {
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
      hasPendingCommands: async () => false,
      notifyRunCompleted: async ({ runID }: { runID: string }) => {
        notifications.push(runID);
      },
      requestAuthentication: async () => undefined,
    };
    const namespace = { getByName: () => broker };
    const input = { runId: run.id, operationId: "finish:replay" };

    const first = await finishImportRun(ctx.db, namespace, input);
    const replay = await finishImportRun(ctx.db, namespace, input);

    expect(replay).toEqual(first);
    expect(notifications).toEqual([run.id, run.id]);
  });
  it("counts the initial dispatch as an attempt, not only retries", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const { importRun } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    const sent: string[] = [];

    await dispatchImportRunEvent(
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
      .select({ attempts: importRun.dispatchAttempts })
      .from(importRun)
      .where(eq(importRun.id, run.id));
    expect(sent).toEqual(["start_or_resume"]);
    expect(stored?.attempts).toBe(1);
  });

  it("moves a run whose coordinator settled without finishing to review, unless a browser command is in flight", async () => {
    const party = await createMember();
    const account = await createVendorAccount(party.id);
    const run = await startOrResumeImportRun(ctx.db, {
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
      hasPendingCommands: async () => pending,
      notifyRunCompleted: async () => undefined,
      requestAuthentication: async () => undefined,
    };
    const namespace = { getByName: () => broker };

    await expect(
      reconcileSettledImportRun(ctx.db, namespace, {
        runId: run.id,
        operationId: "settled:1",
      }),
    ).resolves.toEqual({ reconciled: false, status: "running" });

    pending = false;
    await expect(
      reconcileSettledImportRun(ctx.db, namespace, {
        runId: run.id,
        operationId: "settled:2",
      }),
    ).resolves.toEqual({ reconciled: true, status: "needs_review" });
    const { importFinding, importRun } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    const [stored] = await getDb(ctx.db)
      .select({ status: importRun.status })
      .from(importRun)
      .where(eq(importRun.id, run.id));
    expect(stored?.status).toBe("needs_review");
    const findings = await getDb(ctx.db)
      .select({ kind: importFinding.kind, summary: importFinding.summary })
      .from(importFinding)
      .where(eq(importFinding.importRunId, run.id));
    expect(findings).toEqual([
      expect.objectContaining({
        kind: "other",
        summary: "Coordinator ended without finishing the run",
      }),
    ]);
  });

  it("expires only runs with no coordinator activity for two hours", async () => {
    const party = await createMember();
    const staleAccount = await createVendorAccount(party.id);
    const liveAccount = await createVendorAccount(party.id);
    const stale = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: staleAccount.id,
      trigger: "manual",
    });
    const live = await startOrResumeImportRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: liveAccount.id,
      trigger: "manual",
    });
    const { importRun } = await import("~/server/db/schema");
    const { inArray } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    const now = new Date("2026-09-21T12:00:00.000Z");
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60_000);
    await getDb(ctx.db)
      .update(importRun)
      .set({ updatedAt: threeHoursAgo })
      .where(inArray(importRun.id, [stale.id, live.id]));
    // A progress report inside the window is activity even when the run row
    // itself was not touched.
    await runImportOperation(
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
      hasPendingCommands: async () => false,
      notifyRunCompleted: async () => undefined,
      requestAuthentication: async () => undefined,
    };

    const outcome = await expireStaleImportRuns(
      ctx.db,
      { getByName: () => broker },
      now,
    );

    expect(outcome).toEqual({ expired: 1 });
    const rows = await getDb(ctx.db)
      .select({ id: importRun.id, status: importRun.status })
      .from(importRun)
      .where(inArray(importRun.id, [stale.id, live.id]));
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
    const run = await startOrResumeImportRun(ctx.db, {
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
      hasPendingCommands: async () => false,
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
    const { importRunOperation } = await import("~/server/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/repo/database-helpers");
    const [operation] = await getDb(ctx.db)
      .select({
        state: importRunOperation.state,
        error: importRunOperation.error,
      })
      .from(importRunOperation)
      .where(
        and(
          eq(importRunOperation.runId, run.id),
          eq(importRunOperation.operationId, "browser:bad-link"),
        ),
      );
    expect(operation).toEqual({
      state: "failed",
      error: "disallowed_url: Navigation left the vendor allowlist",
    });
  });
});
