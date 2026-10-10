import { runEntityId } from "@cubby/schemas/identifiers";
import { coordinatorModelFor } from "@cubby/schemas/import-run-agent";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { executeLeasedOperation } from "~/server/runs/operation";

import { dispatchRunEvent, recordRunDispatchAttempt } from "./dispatch";
import { startAgentRunFixture } from "./import-run.fixtures";
import { admitMailImport } from "./mail-import-run";
import {
  controlRun,
  expireStaleRuns,
  loadRunDetail,
  reconcileSettledRun,
  resumeAuthorizedRuns,
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

  const startAgentRun = async (
    party: Awaited<ReturnType<typeof createMember>>,
  ) => startAgentRunFixture(ctx.db, { ledgerPartyId: party.id });

  const retainMail = async (
    party: Awaited<ReturnType<typeof createMember>>,
    subjects: string[],
  ) => {
    const { orderMail } = await import("~/server/db/schema");
    const { getDb } = await import("~/server/repo/database-helpers");
    const { sha256Hex } = await import("@cubby/shared/sha256");
    return getDb(ctx.db)
      .insert(orderMail)
      .values(
        await Promise.all(
          subjects.map(async (subject) => ({
            ledgerPartyId: party.id,
            mailboxId: "synthetic-restart-mailbox",
            messageId: `${subject.toLowerCase()}-${crypto.randomUUID()}`,
            sender: "orders@shop.example.test",
            subject,
            receivedAt: new Date("2026-09-01T18:00:00Z"),
            rawChecksum: await sha256Hex(`${subject}-${crypto.randomUUID()}`),
            content: { snippet: null, bodyText: subject, bodyHtml: null },
          })),
        ),
      )
      .returning();
  };

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
    const disclosure = JSON.stringify(detail.restartInputs);
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

  it("dispatches a manually resumed authorization pause instead of leaving it idle", async () => {
    const party = await createMember();
    const run = await startAgentRun(party);
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
    const run = await startAgentRun(party);
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

  it("counts the initial dispatch as an attempt, not only retries", async () => {
    const party = await createMember();
    const run = await startAgentRun(party);
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

  it("moves a run whose coordinator settled without finishing to review", async () => {
    const party = await createMember();
    const run = await startAgentRun(party);

    await expect(
      reconcileSettledRun(ctx.db, {
        runId: run.id,
        operationId: "settled:1",
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
    const run = await startAgentRun(party);
    const { runApproval } = await import("~/server/db/schema");
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
    const settle = (
      receivedEventIds: string[],
      failure?: { failureCode: "agent_failed" },
    ) =>
      reconcileSettledRun(ctx.db, {
        runId: run.id,
        operationId: `submission-settled:${receivedEventIds.length}`,
        receivedEventIds: new Set(receivedEventIds),
        failure,
      });
    const kept = { reconciled: false, status: "running" };
    const dispatch = run.dispatchEventId!;
    const wake = `approval:${approval!.id}:rejected`;

    // The current dispatch generation is still queued for the agent.
    await expect(settle([wake])).resolves.toEqual(kept);
    // A member's decision woke the agent, but the wake has not arrived.
    await expect(settle([dispatch])).resolves.toEqual(kept);
    // An unanswered submission passes the same fence before failing the run.
    await expect(
      settle([wake], { failureCode: "agent_failed" }),
    ).resolves.toEqual(kept);
    await expect(settle([dispatch, wake])).resolves.toEqual({
      reconciled: true,
      status: "needs_review",
    });
  });

  it("expires only runs with no coordinator activity for two hours", async () => {
    const party = await createMember();
    const stale = await startAgentRun(party);
    const live = await startAgentRun(party);
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
});
