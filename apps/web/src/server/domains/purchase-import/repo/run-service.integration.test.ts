import { runEntityId, vendorShortcode } from "@cubby/schemas/identifiers";
import { coordinatorModelFor } from "@cubby/schemas/import-run-agent";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import { runFindingProblemSchema } from "@cubby/schemas/problems";
import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import { getDb, withTransaction } from "~/server/db/helpers";
import { run as runTable } from "~/server/db/schema";
import { deliverPurchaseDispatch } from "~/server/domains/purchase-agent/service/dispatch";
import type {
  RunServices,
  PurchaseImportRunAgentRpc,
} from "~/server/domains/purchase-agent/service/environment";
import {
  expireStaleRuns,
  reconcileSettledRun,
} from "~/server/domains/purchase-import/operations/run-review";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { executeLeasedOperation } from "~/server/domains/run/repo/operation";
import { insertOperation } from "~/server/domains/run/repo/run-operation";
import { importReportBlocks } from "~/server/generic/entity-report/repo/run";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { findOpenRunFindings } from "~/server/generic/problems/repo/detectors-import";
import {
  runFinding,
  seedRunFindings,
} from "~/server/testing/run-finding.fixtures";

import { startControlledMailImport } from "../operations/gmail/controlled-import";
import { waitForActiveMailboxImports } from "./controlled-mail-import";
import { resolveRunFinding } from "./findings";
import { admitMailImport } from "./mail-import-run";
import {
  readMailImportSettings,
  resumeControlledMailImport,
  setMailImport,
} from "./mail-import-settings";
import { coordinatorRetired } from "./run-retirement";
import {
  controlRun,
  canDispatchRunCoordinator,
  acknowledgeRunCoordinator,
  loadRunDetail,
  loadRunScope,
  resumeAuthorizedRuns,
  updateAgentProgress,
} from "./run-service";

describe("purchase import run admission", () => {
  const ctx = withTestDb();

  const createMember = async () => {
    const { insertWithShortcode } =
      await import("~/server/generic/shortcode/repo/shortcode-utils");
    return insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Import test member",
      kind: "member",
      userId: ctx.actor.userId,
    });
  };

  const startAgentRun = async (
    party: Awaited<ReturnType<typeof createMember>>,
    messageIds?: string[],
  ) => {
    const sources =
      messageIds ??
      (await retainMail(party, ["Coordinator lifecycle receipt"])).map(
        (source) => source.id,
      );
    const [admission] = await admitMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: sources,
    });
    if (!admission?.created || !admission.row.dispatchEventId)
      throw new Error("Expected Mail import with a dispatch generation");
    return {
      ...admission.row,
      publicId: admission.row.shortcode,
      dispatchEventId: admission.row.dispatchEventId,
    };
  };

  const retainMail = async (
    party: Awaited<ReturnType<typeof createMember>>,
    subjects: string[],
  ) => {
    const { retainedMailFixture } =
      await import("../operations/order-import.fixtures");
    const { sha256Hex } = await import("@cubby/shared/sha256");
    return Promise.all(
      subjects.map(async (subject) =>
        retainedMailFixture(ctx.db, {
          ledgerPartyId: party.id,
          mailboxId: "synthetic-restart-mailbox",
          messageId: `${subject.toLowerCase()}-${crypto.randomUUID()}`,
          sender: "orders@shop.example.test",
          subject,
          receivedAt: new Date("2026-09-01T18:00:00Z"),
          checksum: await sha256Hex(`${subject}-${crypto.randomUUID()}`),
          content: { snippet: null, bodyText: subject, bodyHtml: null },
        }),
      ),
    );
  };

  it("retries the same operation after a lost submission and never resubmits a started coordinator", async () => {
    const subject = await startAgentRun(await createMember());
    const [intent] = await readJobs(ctx.db, { runId: subject.id });
    if (!intent) throw new Error("Expected transactional dispatch intent");
    const event = purchaseAgentEvent.parse(intent.input);
    const dispatch = vi
      .fn<PurchaseImportRunAgentRpc["dispatch"]>()
      .mockRejectedValueOnce(new Error("Synthetic lost RPC reply"))
      .mockResolvedValue({ accepted: true });
    const services = fromPartial<RunServices>({
      coordinatorRetired: () => coordinatorRetired(ctx.db, subject.id),
      canDispatchCoordinator: (eventId: string) =>
        canDispatchRunCoordinator(ctx.db, { runId: subject.id, eventId }),
      acknowledgeCoordinator: (eventId: string) =>
        acknowledgeRunCoordinator(ctx.db, { runId: subject.id, eventId }),
      loadScope: async () => {
        const { public: scope } = await loadRunScope(ctx.db, subject.id);
        return {
          purpose: agentImportRunPurpose.parse(scope.purpose),
          agentId: scope.agentId,
          generation: scope.dispatchEventId,
        };
      },
      updateAgentProgress: (
        progress: Parameters<RunServices["updateAgentProgress"]>[0],
      ) => updateAgentProgress(ctx.db, { ...progress, runId: subject.id }),
    });
    const env = {
      run: () => services,
      coordinator: () => fromPartial<PurchaseImportRunAgentRpc>({ dispatch }),
    };
    await expect(deliverPurchaseDispatch(event, env)).rejects.toThrow(
      "Synthetic lost RPC reply",
    );
    expect(await deliverPurchaseDispatch(event, env)).toBe("dispatched");
    expect(await deliverPurchaseDispatch(event, env)).toBe("fenced");
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0].operationId).toBe(
      dispatch.mock.calls[1]?.[0].operationId,
    );
    expect(
      await canDispatchRunCoordinator(ctx.db, {
        runId: subject.id,
        eventId: event.eventId,
      }),
    ).toBe(false);
  });
  it("retains queued automatic imports while a controlled Vendor waits for active work, until manual resume", async () => {
    const party = await createMember();
    const queued = await startAgentRun(party);
    const active = await startAgentRun(
      party,
      (await retainMail(party, ["Synthetic active receipt"])).map(
        (source) => source.id,
      ),
    );
    await getDb(ctx.db)
      .update(runTable)
      .set({ coordinatorStartedAt: new Date() })
      .where(eq(runTable.id, active.id));
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: "synthetic-restart-mailbox",
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const { insertWithShortcode } =
      await import("~/server/generic/shortcode/repo/shortcode-utils");
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Controlled Vendor",
      orderEmailSenders: ["orders@controlled.example.test"],
    });
    const request = await startControlledMailImport(ctx.db, ctx.actor, {
      mailboxId: "synthetic-restart-mailbox",
      vendorId: vendorShortcode.parse(seller.shortcode),
    });
    const [control] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.shortcode, request.run));
    if (!control) throw new Error("Controlled import was not persisted");
    const wait = () =>
      waitForActiveMailboxImports(ctx.db, {
        mailboxId: "synthetic-restart-mailbox",
        memberId: party.id,
        controlRunId: control.id,
      });
    await expect(wait()).rejects.toThrow("active Mail import to finish");
    await expect(
      canDispatchRunCoordinator(ctx.db, {
        runId: queued.id,
        eventId: queued.dispatchEventId,
      }),
    ).rejects.toThrow("Automatic Mail import is paused");
    expect(
      await canDispatchRunCoordinator(ctx.db, {
        runId: active.id,
        eventId: active.dispatchEventId,
      }),
    ).toBe(false);
    // Finishing active work does not dispose the queued Run or its source ownership.
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "completed" })
      .where(eq(runTable.id, active.id));
    await expect(wait()).resolves.toBeUndefined();
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "completed" })
      .where(eq(runTable.id, control.id));
    await expect(
      canDispatchRunCoordinator(ctx.db, {
        runId: queued.id,
        eventId: queued.dispatchEventId,
      }),
    ).rejects.toThrow("Automatic Mail import is paused");
    await resumeControlledMailImport(ctx.db, "synthetic-restart-mailbox");
    expect(await readMailImportSettings(ctx.db)).toEqual({
      enabledMailboxes: [],
      controlledPauses: [],
    });
    expect(
      await canDispatchRunCoordinator(ctx.db, {
        runId: queued.id,
        eventId: queued.dispatchEventId,
      }),
    ).toBe(true);
    // A later ordinary switch-off only stops new admission; the completed
    // control no longer creates an implicit permanent queued-work pause.
    await setMailImport(ctx.db, {
      mailboxId: "synthetic-restart-mailbox",
      enabled: false,
    });
    expect(
      await canDispatchRunCoordinator(ctx.db, {
        runId: queued.id,
        eventId: queued.dispatchEventId,
      }),
    ).toBe(true);
    await setMailImport(ctx.db, {
      mailboxId: "synthetic-restart-mailbox",
      enabled: true,
    });
    await setMailImport(
      ctx.db,
      { mailboxId: "synthetic-restart-mailbox", enabled: false },
      { kind: "controlled_pause" },
    );
    await setMailImport(ctx.db, {
      mailboxId: "synthetic-restart-mailbox",
      enabled: false,
    });
    await resumeControlledMailImport(ctx.db, "synthetic-restart-mailbox");
    expect(
      (await readMailImportSettings(ctx.db)).enabledMailboxes,
    ).not.toContain("synthetic-restart-mailbox");
  });

  // A manual pause must remain cancellable and resumable; legacy recovery must
  // continue after one dispatch fails and must not resume a manual pause.
  it("keeps manually paused imports cancellable and resumable", async () => {
    const party = await createMember();
    const run = await startAgentRun(party);
    await controlRun(ctx.db, ctx.actor, {
      runPublicId: run.publicId,
      action: "pause",
    });
    expect(
      await controlRun(ctx.db, ctx.actor, {
        runPublicId: run.publicId,
        action: "resume",
      }),
    ).toMatchObject({ status: "running" });
    await controlRun(ctx.db, ctx.actor, {
      runPublicId: run.publicId,
      action: "pause",
    });
    expect(
      await controlRun(ctx.db, ctx.actor, {
        runPublicId: run.publicId,
        action: "cancel",
      }),
    ).toMatchObject({ status: "failed" });
  });

  const startFileRun = async () => {
    await createMember();
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "file_import",
      trigger: "manual",
      status: "running",
    });
    const [row] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, id));
    if (!row) throw new Error("Synthetic file Run missing");
    return row;
  };

  it("lets the owning member cancel a file import without an agent session", async () => {
    const subject = await startFileRun();
    expect(subject.agentSessionId).toBeNull();
    await expect(loadRunScope(ctx.db, subject.id)).rejects.toThrow(
      "Import run ownership is unavailable",
    );
    expect(
      await controlRun(ctx.db, ctx.actor, {
        runPublicId: subject.shortcode,
        action: "cancel",
      }),
    ).toMatchObject({ status: "failed" });
    const [stored] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, subject.id));
    expect(stored).toMatchObject({
      status: "failed",
      failureCode: "user_cancelled",
    });
  });

  it("expires abandoned file imports and preserves sleeping Workflow Runs", async () => {
    const subject = await startFileRun();
    const workflowId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_refresh",
      trigger: "manual",
      status: "running",
    });
    const now = new Date(Date.now() + 3 * 60 * 60_000);
    expect(await expireStaleRuns(ctx.db, now)).toEqual({
      expired: 1,
      failures: [],
    });
    const [stored] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, subject.id));
    expect(stored).toMatchObject({
      status: "failed",
      failureCode: "agent_failed",
    });
    const [workflow] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, workflowId));
    expect(workflow?.status).toBe("running");
  });

  it.each(["status", "generation", "row", "heartbeat", "operation"] as const)(
    "rechecks %s activity after stale selection while waiting for the Run lock",
    async (changed) => {
      const subject = await startFileRun();
      const now = new Date();
      await getDb(ctx.db)
        .update(runTable)
        .set({ updatedAt: new Date(now.getTime() - 3 * 60 * 60_000) })
        .where(eq(runTable.id, subject.id));
      let pending: ReturnType<typeof expireStaleRuns> | undefined;
      await withTransaction(ctx.db, async (tx) => {
        await tx
          .select({ id: runTable.id })
          .from(runTable)
          .where(eq(runTable.id, subject.id))
          .for("no key update");
        pending = expireStaleRuns(ctx.db, now);
        pending.catch(() => undefined);
        await expect
          .poll(
            async () => {
              const waiting = await getDb(ctx.db).execute<{
                count: number;
              }>(sql`
                SELECT count(*)::int AS count FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'`);
              return waiting.rows[0]?.count;
            },
            { timeout: 10_000 },
          )
          .toBe(1);
        if (changed === "operation") {
          await insertOperation(tx, {
            runId: subject.id,
            operationId: "synthetic-live-operation",
            kind: "prepare_purchase_import",
            inputFingerprint: "a".repeat(64),
          });
        } else {
          await tx
            .update(runTable)
            .set(
              changed === "status"
                ? { status: "failed", failureCode: "user_cancelled" }
                : changed === "generation"
                  ? { dispatchEventId: crypto.randomUUID() }
                  : changed === "row"
                    ? { updatedAt: now }
                    : { heartbeatAt: now },
            )
            .where(eq(runTable.id, subject.id));
        }
      });
      await expect(pending).resolves.toEqual({ expired: 0, failures: [] });
      const [stored] = await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.id, subject.id));
      expect(stored?.status).toBe(changed === "status" ? "failed" : "running");
      expect(stored?.failureCode).toBe(
        changed === "status" ? "user_cancelled" : null,
      );
    },
  );

  it("discloses retained mail restart scope without exposing private source identities", async () => {
    const party = await createMember();
    const sources = await retainMail(party, ["Confirmation", "Shipment"]);
    const [admission] = await admitMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: sources.map((source) => source.id),
    });
    if (!admission?.created)
      throw new Error("Expected retained mail admission");
    const detail = await loadRunDetail(ctx.db, admission.row.shortcode);
    expect(detail.restartInputs?.input).toEqual({
      kind: "mail_research",
      sourceCount: 2,
    });
    expect(detail.restartInputs?.targets).toHaveLength(2);
    for (const target of detail.restartInputs!.targets) {
      expect(target.sourceExternalKey).toBeNull();
      expect(target.targetFingerprint).toBeNull();
    }
    expect(detail.targets).toHaveLength(2);
    for (const target of detail.targets) {
      expect(target.sourceId).toBeNull();
      expect(target.fingerprint).toBeNull();
    }
    const disclosure = JSON.stringify({
      restartInputs: detail.restartInputs,
      targets: detail.targets,
    });
    for (const source of sources) {
      expect(disclosure).not.toContain(source.id);
      expect(disclosure).not.toContain(source.rawChecksum);
      expect(disclosure).not.toContain(source.mailboxId);
    }
  });

  it("retries a historical run on the current coordinator model", async () => {
    const party = await createMember();
    const sources = await retainMail(party, ["Confirmation"]);
    const [admission] = await admitMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: sources.map((source) => source.id),
    });
    if (!admission?.created) throw new Error("Expected Mail import admission");
    const run = { id: admission.row.id, publicId: admission.row.shortcode };
    const { run: runTable } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/db/helpers");
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
    if (!("successorRunId" in successor))
      throw new Error("Expected a research successor");
    const [storedSuccessor] = await getDb(ctx.db)
      .select({ coordinatorModel: runTable.coordinatorModel })
      .from(runTable)
      .where(eq(runTable.id, runEntityId.parse(successor.successorRunId)));
    expect(storedSuccessor?.coordinatorModel).toBe(
      coordinatorModelFor("mail_import"),
    );
  });

  it("resumes authorization with a persisted dispatch generation", async () => {
    const party = await createMember();
    const run = await startAgentRun(party);
    const unrelatedRunId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_refresh",
      trigger: "manual",
      status: "running",
    });
    const { run: runTable } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/db/helpers");
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "paused_auth", coordinatorStartedAt: new Date() })
      .where(eq(runTable.id, run.id));
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "paused_auth" })
      .where(eq(runTable.id, unrelatedRunId));

    const resumedRuns = await resumeAuthorizedRuns(ctx.db, ctx.actor.userId);
    expect(resumedRuns).toHaveLength(1);
    const [resumed] = resumedRuns;
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
    const [unrelated] = await getDb(ctx.db)
      .select({ status: runTable.status })
      .from(runTable)
      .where(eq(runTable.id, unrelatedRunId));
    expect(unrelated?.status).toBe("paused_auth");
  });

  it("dispatches a manually resumed authorization pause instead of leaving it idle", async () => {
    const party = await createMember();
    const run = await startAgentRun(party);
    const { run: runTable } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/db/helpers");
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
      dispatchPurpose: "mail_import",
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
    const run = await startAgentRun(party);
    const { run: runTable } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("~/server/db/helpers");
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

  it("returns the recorded tool result without replaying its effect", async () => {
    const party = await createMember();
    const run = await startAgentRun(party);
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
    const run = await startAgentRun(party);
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
      import("~/server/db/helpers"),
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

  it("moves a run whose coordinator settled without finishing to review", async () => {
    const party = await createMember();
    const run = await startAgentRun(party);

    await expect(
      reconcileSettledRun(ctx.db, {
        runId: run.id,
        operationId: "settled:1",
        generation: run.dispatchEventId!,
        sequence: 1,
        receivedEventIds: new Set([run.dispatchEventId]),
      }),
    ).resolves.toEqual({ reconciled: true, status: "needs_review" });
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

  it("waits for the dispatch generation but ignores retired approval wakes", async () => {
    const party = await createMember();
    const run = await startAgentRun(party);
    const { runApproval } = await import("~/server/db/schema");
    const { getDb } = await import("~/server/db/helpers");
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
    const settle = (
      receivedEventIds: string[],
      failure?: { failureCode: "agent_failed" },
    ) =>
      reconcileSettledRun(ctx.db, {
        runId: run.id,
        operationId: `submission-settled:${receivedEventIds.length}`,
        generation: run.dispatchEventId!,
        sequence: receivedEventIds.length + 1,
        receivedEventIds: new Set(receivedEventIds),
        failure,
      });
    const kept = { reconciled: false, status: "running" };
    const dispatch = run.dispatchEventId!;
    const wake = `approval:${approval!.id}:rejected`;

    // The current dispatch generation is still queued for the agent.
    await expect(settle([wake])).resolves.toEqual(kept);
    // An unanswered submission passes the same fence before failing the run.
    await expect(
      settle([wake], { failureCode: "agent_failed" }),
    ).resolves.toEqual(kept);
    // An old approval record no longer requires an event that may never arrive.
    await expect(settle([dispatch])).resolves.toEqual({
      reconciled: true,
      status: "needs_review",
    });
  });

  it("keeps a Run's findings readable beyond the global Problems sample", async () => {
    const party = await createMember();
    const earlier = await startAgentRun(party);
    await seedRunFindings(
      ctx.db,
      Array.from({ length: 13 }, (_, index) => ({
        runId: earlier.id,
        ledgerPartyId: party.id,
        entityKind: "run",
        entityId: earlier.id,
        kind: "synthetic_review",
        summary: "Synthetic earlier finding",
        proposedFix: null,
        evidenceFingerprint: `earlier-${index}`,
      })),
    );
    const current = await startAgentRun(party);
    const [finding] = await seedRunFindings(ctx.db, [
      {
        runId: current.id,
        ledgerPartyId: party.id,
        entityKind: "run",
        entityId: current.id,
        kind: "synthetic_review",
        summary: "Synthetic current finding",
        proposedFix: null,
        evidenceFingerprint: "current",
      },
    ]);
    if (!finding) throw new Error("Synthetic current finding missing");
    const detail = await loadRunDetail(ctx.db, current.publicId);
    expect(detail.findings.map(({ id }) => id)).toEqual([finding.id]);
  });

  // Production still holds findings whose fix kinds ADR 0010 retired until
  // the contract migration dismisses them; they must read as non-executable.
  it("reads findings carrying retired fix kinds as having no executable fix", async () => {
    const party = await createMember();
    const run = await startAgentRun(party);
    const retiredFixes = [
      { kind: "vendor_capture_profile", vendorId: crypto.randomUUID() },
      { kind: "research_field_correction", productId: crypto.randomUUID() },
      { kind: "validation_corrections", corrections: [] },
    ];
    const rows = await seedRunFindings(
      ctx.db,
      retiredFixes.flatMap((proposedFix) =>
        (["open", "dismissed"] as const).map((status) => ({
          runId: run.id,
          ledgerPartyId: party.id,
          entityKind: "run" as const,
          entityId: run.id,
          kind: `retired_${proposedFix.kind}`,
          summary: "A finding filed before its fix kind was retired.",
          proposedFix,
          evidenceFingerprint: `${proposedFix.kind}:${status}`,
          status,
        })),
      ),
    );

    const detail = await loadRunDetail(ctx.db, run.publicId);
    expect(detail.findings).toHaveLength(6);
    expect(detail.findings.map((finding) => finding.proposedFix)).toEqual(
      Array(6).fill(null),
    );
    const commands = importReportBlocks("run.import-findings", detail).flatMap(
      (block) =>
        block.kind === "records"
          ? block.rows.flatMap((row) => row.commands ?? [])
          : [],
    );
    expect(commands).toHaveLength(3);
    for (const command of commands) {
      expect(command.request).toMatchObject({
        kind: "operation",
        operation: "problems.resolveRunFinding",
        body: { action: "dismiss" },
      });
    }
    const problems = runFindingProblemSchema
      .array()
      .parse(await findOpenRunFindings(ctx.db));
    expect(problems.map((problem) => problem.proposedFix)).toEqual(
      Array(3).fill(null),
    );
    const open = rows.find((row) => row.status === "open");
    if (!open) throw new Error("test setup: no open finding");
    await expect(
      resolveRunFinding(ctx.db, { id: open.id, action: "apply" }, ctx.actor),
    ).rejects.toThrow("no applicable fix");
  });

  it("completes a stale Mail import whose frozen Emails are settled using its observed dispatch generation", async () => {
    const party = await createMember();
    const [source] = await retainMail(party, ["Settled confirmation"]);
    if (!source) throw new Error("Synthetic retained source missing");
    const [{ run: runTable, email: emailTable }, { eq }] = await Promise.all([
      import("~/server/db/schema"),
      import("drizzle-orm"),
    ]);
    const subject = await startAgentRun(party, [source.id]);
    const now = new Date("2026-09-21T12:00:00.000Z");
    await getDb(ctx.db)
      .update(runTable)
      .set({
        updatedAt: new Date(now.getTime() - 3 * 60 * 60_000),
      })
      .where(eq(runTable.id, subject.id));
    await getDb(ctx.db)
      .update(emailTable)
      .set({ runId: subject.id, status: "completed" })
      .where(eq(emailTable.orderMailId, source.id));
    expect(await expireStaleRuns(ctx.db, now)).toEqual({
      expired: 1,
      failures: [],
    });
    const [stored] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, subject.id));
    expect(stored).toMatchObject({
      status: "completed",
      dispatchEventId: subject.dispatchEventId,
    });
  });

  it("refuses a stale recovery generation after a Mail import resumes without changing its status or findings", async () => {
    const party = await createMember();
    const subject = await startAgentRun(party);
    const [{ run: runTable }, { eq }] = await Promise.all([
      import("~/server/db/schema"),
      import("drizzle-orm"),
    ]);
    const resumedGeneration = crypto.randomUUID();
    await getDb(ctx.db)
      .update(runTable)
      .set({ dispatchEventId: resumedGeneration })
      .where(eq(runTable.id, subject.id));
    expect(
      await reconcileSettledRun(ctx.db, {
        runId: subject.id,
        operationId: "stale-recovery-generation",
        generation: subject.dispatchEventId,
      }),
    ).toEqual({ reconciled: false, status: "running" });
    const [stored] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, subject.id));
    expect(stored).toMatchObject({
      status: "running",
      dispatchEventId: resumedGeneration,
    });
    expect(
      await getDb(ctx.db)
        .select()
        .from(runFinding)
        .where(eq(runFinding.runId, subject.id)),
    ).toEqual([]);
  });

  it("expires only runs with no coordinator activity for two hours", async () => {
    const party = await createMember();
    const stale = await startAgentRun(party);
    const live = await startAgentRun(party);
    const { run: runTable } = await import("~/server/db/schema");
    const { inArray } = await import("drizzle-orm");
    const { getDb } = await import("~/server/db/helpers");
    const now = new Date("2026-09-21T12:00:00.000Z");
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60_000);
    await getDb(ctx.db)
      .update(runTable)
      .set({ updatedAt: threeHoursAgo })
      .where(inArray(runTable.id, [stale.id, live.id]));
    await updateAgentProgress(ctx.db, {
      runId: live.id,
      eventId: "live:progress",
      phase: "investigating",
      generation: live.dispatchEventId,
      sequence: 1,
    });
    // The Run-owned progress heartbeat keeps the coordinator alive even
    // when the general row timestamp remains outside the activity window.
    await getDb(ctx.db)
      .update(runTable)
      .set({ updatedAt: threeHoursAgo })
      .where(inArray(runTable.id, [live.id]));
    const outcome = await expireStaleRuns(ctx.db, now);

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

  // Production finding: a funding-paused import with pending targets was
  // stopped for review, then resume answered 500 and the funding window
  // never continued it.
  it("keeps a funding-paused import waiting for AI funding, resumable, and refuses with 4xx", async () => {
    const subject = await startAgentRun(await createMember());
    const status = async () =>
      (
        await getDb(ctx.db)
          .select({
            status: runTable.status,
            failureCode: runTable.failureCode,
          })
          .from(runTable)
          .where(eq(runTable.id, subject.id))
      )[0];
    const set = (values: Partial<typeof runTable.$inferInsert>) =>
      getDb(ctx.db)
        .update(runTable)
        .set(values)
        .where(eq(runTable.id, subject.id));
    await set({ status: "paused_auth", failureCode: "execution_limit" });
    const { stopRunForReview } =
      await import("~/server/domains/purchase-import/operations/run-review");
    await stopRunForReview(ctx.db, {
      runId: subject.id,
      operationId: "synthetic-funding-stop",
      kind: "unresolved_targets",
      summary: "Synthetic unresolved targets",
    });
    expect(await status()).toEqual({
      status: "paused_auth",
      failureCode: "execution_limit",
    });

    // A Run an older coordinator already fenced resumes directly.
    await set({ status: "needs_review", failureCode: "execution_limit" });
    expect(
      await controlRun(ctx.db, ctx.actor, {
        runPublicId: subject.publicId,
        action: "resume",
      }),
    ).toMatchObject({ status: "running" });

    // ...and the funding window continues it without a member.
    await set({
      status: "needs_review",
      failureCode: "execution_limit",
      updatedAt: new Date(Date.now() - 60_000),
    });
    const { redispatchBudgetPausedImports } = await import("./run-service");
    expect(await redispatchBudgetPausedImports(ctx.db)).toBe(1);
    expect((await status())?.status).toBe("running");

    // A refused control is a conflict, never a server error.
    await set({ status: "completed", failureCode: null });
    await expect(
      controlRun(ctx.db, ctx.actor, {
        runPublicId: subject.publicId,
        action: "resume",
      }),
    ).rejects.toMatchObject({
      reason: "RUN_CONTROL_REFUSED",
      code: "CONFLICT",
    });
  });

  // Review finding: retrying a funding-stopped Run left the predecessor in
  // needs_review/execution_limit, so the funding window and direct resume
  // redispatched it beside its successor over the same targets.
  it("resumes only the retry successor of a funding-stopped Run", async () => {
    const predecessor = await startAgentRun(await createMember());
    const fundingStop = (id: string) =>
      getDb(ctx.db)
        .update(runTable)
        .set({
          status: "needs_review",
          failureCode: "execution_limit",
          updatedAt: new Date(Date.now() - 60_000),
        })
        .where(eq(runTable.id, runEntityId.parse(id)));
    const statusOf = async (id: string) =>
      (
        await getDb(ctx.db)
          .select({ status: runTable.status })
          .from(runTable)
          .where(eq(runTable.id, runEntityId.parse(id)))
      )[0]?.status;
    await fundingStop(predecessor.id);
    const retried = await controlRun(ctx.db, ctx.actor, {
      runPublicId: predecessor.publicId,
      action: "retry",
    });
    if (!("successorRunId" in retried) || !retried.successorRunId)
      throw new Error("Expected a retry successor");
    // The successor itself later stops for funding too.
    await fundingStop(retried.successorRunId);

    const { redispatchBudgetPausedImports } = await import("./run-service");
    expect(await redispatchBudgetPausedImports(ctx.db)).toBe(1);
    expect(await statusOf(retried.successorRunId)).toBe("running");
    expect(await statusOf(predecessor.id)).toBe("needs_review");

    await expect(
      controlRun(ctx.db, ctx.actor, {
        runPublicId: predecessor.publicId,
        action: "resume",
      }),
    ).rejects.toMatchObject({ reason: "RUN_CONTROL_REFUSED" });
    expect(await statusOf(predecessor.id)).toBe("needs_review");
  });
});
