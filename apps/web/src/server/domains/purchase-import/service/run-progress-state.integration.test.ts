import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { reconcileSettledRun } from "~/server/domains/purchase-import/operations/run-review";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { resumeAuthorizedRuns, updateAgentProgress } from "../repo/run-service";
import { startAgentRunFixture } from "./import-run.fixtures";

// Persisted delivery failures: a resumed generation can receive old messages;
// a current generation can arrive out of order; history truncation must never
// forget event IDs or let duplicate reports refresh heartbeat/approval state.
describe("Run-owned progress delivery fences", () => {
  const ctx = withTestDb();
  async function start() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic progress owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const owned = await startAgentRunFixture(ctx.db, {
      ledgerPartyId: party.id,
    });
    if (!owned.dispatchEventId) throw new Error("Missing dispatch generation");
    return { ...owned, generation: owned.dispatchEventId };
  }
  async function stored(id: typeof run.$inferSelect.id) {
    const [row] = await getDb(ctx.db).select().from(run).where(eq(run.id, id));
    if (!row) throw new Error("Missing synthetic Run");
    return row;
  }
  it("rejects old dispatch deliveries and older sequence without regressing resumed approval or heartbeat", async () => {
    const owned = await start();
    await updateAgentProgress(ctx.db, {
      runId: owned.id,
      eventId: "synthetic:old",
      phase: "preparing",
      generation: owned.generation,
      sequence: 1,
    });
    await getDb(ctx.db)
      .update(run)
      .set({ status: "paused_auth" })
      .where(eq(run.id, owned.id));
    const [resumed] = await resumeAuthorizedRuns(ctx.db, ctx.actor.userId);
    if (!resumed?.eventId) throw new Error("Missing resumed generation");
    expect(
      await updateAgentProgress(ctx.db, {
        runId: owned.id,
        eventId: "synthetic:current",
        phase: "awaiting_approval",
        awaitingApproval: true,
        generation: resumed.eventId,
        sequence: 2,
      }),
    ).toEqual({ recorded: true });
    const before = await stored(owned.id);
    expect(before.liveProgress).toMatchObject({
      phase: "awaiting_approval",
      awaitingApproval: true,
    });
    expect(
      await updateAgentProgress(ctx.db, {
        runId: owned.id,
        eventId: "synthetic:late-old",
        phase: "preparing",
        generation: owned.generation,
        sequence: 50,
      }),
    ).toEqual({ recorded: false });
    expect(
      await updateAgentProgress(ctx.db, {
        runId: owned.id,
        eventId: "synthetic:out-of-order",
        phase: "investigating",
        generation: resumed.eventId,
        sequence: 1,
      }),
    ).toEqual({ recorded: false });
    const after = await stored(owned.id);
    expect(after.liveProgress).toEqual(before.liveProgress);
    expect(after.heartbeatAt).toEqual(before.heartbeatAt);
  });
  it("does not fail a resumed Run when an old submission settles late", async () => {
    const owned = await start();
    await getDb(ctx.db)
      .update(run)
      .set({ status: "paused_auth" })
      .where(eq(run.id, owned.id));
    const [resumed] = await resumeAuthorizedRuns(ctx.db, ctx.actor.userId);
    if (!resumed?.eventId) throw new Error("Missing resumed generation");
    expect(
      await reconcileSettledRun(ctx.db, {
        runId: owned.id,
        operationId: "synthetic:old-settlement",
        generation: owned.generation,
        sequence: 10,
        receivedEventIds: new Set([owned.generation, resumed.eventId]),
        failure: {
          failureCode: "agent_failed",
          detail: "Synthetic stale failure",
        },
      }),
    ).toEqual({ reconciled: false, status: "running" });
    expect((await stored(owned.id)).status).toBe("running");
  });
  it("bounds display history while retaining every event ID for replay deduplication", async () => {
    const owned = await start();
    for (let sequence = 1; sequence <= 102; sequence++) {
      expect(
        await updateAgentProgress(ctx.db, {
          runId: owned.id,
          eventId: `synthetic:event:${sequence}`,
          phase: "investigating",
          generation: owned.generation,
          sequence,
        }),
      ).toEqual({ recorded: true });
    }
    const before = await stored(owned.id);
    expect(before.progressHistory).toHaveLength(100);
    expect(before.progressEventIds).toHaveLength(102);
    expect(before.progressEventIds).toContain("synthetic:event:1");
    expect(
      await updateAgentProgress(ctx.db, {
        runId: owned.id,
        eventId: "synthetic:event:1",
        phase: "preparing",
        generation: owned.generation,
        sequence: 103,
      }),
    ).toEqual({ recorded: false });
    const after = await stored(owned.id);
    expect(after.liveProgress).toEqual(before.liveProgress);
    expect(after.heartbeatAt).toEqual(before.heartbeatAt);
  });
});
