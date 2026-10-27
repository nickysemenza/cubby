import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
} from "@cubby/schemas/ai-evaluation";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { dependencyStamps } from "~/server/ai/policy/refresh-manifest";
import { requestedAiEvaluations } from "~/server/ai/repo/ai-evaluation-requests";
import { enqueueAiEvaluations } from "~/server/ai/repo/ai-evaluation-requests";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  aiEvaluationRequest,
  job,
  run,
} from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { readRunEvaluations } from "~/server/generic/run-detail/repo/run-evaluations";

import { enqueueJob } from "./jobs";
import { readWorkActivity } from "./work-activity";

// Failure mode: Activity showed lanes ("Cloud AI · Due 268") rather than the
// work they hold, so a moving queue and a stuck one looked the same.
describe("work activity", () => {
  const ctx = withTestDb();

  it("reports live and recent work per kind, AI evaluations per feature", async () => {
    const now = new Date();
    for (const index of [0, 1, 2])
      await enqueueJob(ctx.db, {
        key: `synthetic-activity-refresh:${index}`,
        kind: "embedding.refresh",
        input: {},
      });
    await enqueueJob(ctx.db, {
      key: "synthetic-activity-watchdog",
      kind: "queue.watchdog",
      input: {},
    });
    const minutesAgo = (minutes: number) =>
      new Date(now.getTime() - minutes * 60_000);
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "completed",
        lastClaimedAt: minutesAgo(2),
        updatedAt: minutesAgo(2),
      })
      .where(eq(job.key, "synthetic-activity-refresh:0"));
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "retry_wait",
        availableAt: new Date(now.getTime() + 60_000),
        lastClaimedAt: minutesAgo(1),
      })
      .where(eq(job.key, "synthetic-activity-refresh:1"));

    const activation = await activateAiRefresh(
      ctx.db,
      "synthetic-activity-release",
      { enabled: true },
    );
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_refresh",
      trigger: "scheduled",
      status: "running",
      input: aiRefreshRunInput.parse({ kind: "ai_refresh", activation }),
    });
    const evaluations = await enqueueAiEvaluations(
      ctx.db,
      ["product-identity", "product-identity", "entity-connections"].map(
        (feature, sequence) => ({
          input: {
            runId,
            executionKind: "ai_refresh" as const,
            shareKey: null,
            feature,
            target: aiEvaluationTarget.parse({
              kind: "product",
              entity: "product",
              recordId: crypto.randomUUID(),
              field: null,
              assessmentIds: [],
            }),
            provenance: aiProvenance.parse({
              dependencies: dependencyStamps(activation.manifest, [
                "product-identity",
              ]),
              inputFingerprint: `synthetic-activity-${sequence}`,
              optionFingerprint: "synthetic-options",
              model: null,
            }),
            snapshot: {},
          },
          sequence,
        }),
      ),
    );
    expect(evaluations).toHaveLength(3);
    const [owner] = await getDb(ctx.db)
      .select({ shortcode: run.shortcode })
      .from(run)
      .where(eq(run.id, runId));

    // Enqueue stamps availability after `now`; read just after it.
    const activity = await readWorkActivity(
      ctx.db,
      new Date(now.getTime() + 5_000),
    );
    const stream = (kind: string, feature: string | null = null) =>
      activity.streams.find(
        (entry) => entry.kind === kind && entry.feature === feature,
      );
    expect(stream("queue.watchdog")).toBeUndefined();
    expect(stream("embedding.refresh")).toMatchObject({
      due: 1,
      backingOff: 1,
      completed: 1,
      completedPerMinute: 1 / activity.windows.paceMinutes,
    });
    expect(stream("ai.evaluation", "product-identity")).toMatchObject({
      due: 2,
      runIds: [owner!.shortcode],
    });
    expect(stream("ai.evaluation", "entity-connections")).toMatchObject({
      due: 1,
    });
  });
  it("resolves shared demand through requests and preserves cancelled request receipts", async () => {
    const activation = await activateAiRefresh(
      ctx.db,
      "synthetic-shared-activity",
      { enabled: true },
    );
    const owners = [];
    for (let index = 0; index < 3; index++)
      owners.push(
        await ensureRun(ctx.db, ctx.actor, {
          clientKey: `synthetic-shared-activity:${index}`,
          purpose: "ai_refresh",
          trigger: "manual",
          status: "running",
          input: aiRefreshRunInput.parse({ kind: "ai_refresh", activation }),
        }),
      );
    const target = aiEvaluationTarget.parse({
      kind: "product",
      entity: "product",
      recordId: crypto.randomUUID(),
      field: null,
      assessmentIds: [],
    });
    let evaluationId = "";
    for (const runId of owners) {
      const [entry] = await enqueueAiEvaluations(ctx.db, [
        {
          input: {
            runId,
            shareKey: "synthetic-shared-activity",
            executionKind: "ai_refresh",
            feature: "product-identity",
            target,
            provenance: aiProvenance.parse({
              dependencies: [],
              inputFingerprint: "synthetic-shared",
              optionFingerprint: "synthetic",
              model: null,
            }),
            snapshot: {},
          },
        },
      ]);
      evaluationId = entry!.id;
    }
    const [owner, joined, cancelled] = owners;
    if (!owner || !joined || !cancelled)
      throw new Error("Synthetic Runs missing");
    await getDb(ctx.db)
      .update(aiEvaluationRequest)
      .set({
        cancelledAt: new Date(),
        receipt: { reason: "Synthetic retained cancellation" },
      })
      .where(eq(aiEvaluationRequest.runId, cancelled));
    const activity = await readWorkActivity(
      ctx.db,
      new Date(Date.now() + 1000),
    );
    const codes = await getDb(ctx.db)
      .select({ id: run.id, shortcode: run.shortcode })
      .from(run);
    expect(
      activity.streams.find((entry) => entry.feature === "product-identity"),
    ).toMatchObject({
      due: 1,
      runIds: expect.arrayContaining(
        codes
          .filter((entry) => entry.id === owner || entry.id === joined)
          .map((entry) => entry.shortcode),
      ),
    });
    expect(
      activity.streams.find((entry) => entry.feature === "product-identity")
        ?.runIds,
    ).not.toContain(codes.find((entry) => entry.id === cancelled)!.shortcode);
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "completed", receipt: { candidates: 7 } })
      .where(eq(aiEvaluation.id, evaluationId));
    expect(
      (
        await readRunEvaluations(ctx.db, {
          runId: joined,
          purpose: "ai_refresh",
        })
      ).recent,
    ).toMatchObject([{ candidates: 7 }]);
    expect(
      (
        await readRunEvaluations(ctx.db, {
          runId: cancelled,
          purpose: "ai_refresh",
        })
      ).byKind,
    ).toMatchObject([{ cancelled: 1, completed: 0 }]);
    expect((await requestedAiEvaluations(ctx.db, cancelled))[0]).toMatchObject({
      state: "cancelled",
      receipt: { reason: "Synthetic retained cancellation" },
    });
    // A withdrawn request with no receipt must not inherit later shared work.
    await getDb(ctx.db)
      .update(aiEvaluationRequest)
      .set({ receipt: null })
      .where(eq(aiEvaluationRequest.runId, cancelled));
    expect(
      (
        await readRunEvaluations(ctx.db, {
          runId: cancelled,
          purpose: "ai_refresh",
        })
      ).recent,
    ).toEqual([]);
  });
  it("counts a running Job with an expired lease as waiting work", async () => {
    const now = new Date();
    await enqueueJob(ctx.db, {
      key: "synthetic-activity-expired",
      kind: "embedding.cleanup",
      input: {},
    });
    const expiredAt = new Date(now.getTime() - 5 * 60_000);
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "running",
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: expiredAt,
        lastClaimedAt: new Date(now.getTime() - 120 * 60_000),
      })
      .where(eq(job.key, "synthetic-activity-expired"));
    const activity = await readWorkActivity(ctx.db, now);
    const stream = activity.streams.find(
      (entry) => entry.kind === "embedding.cleanup",
    );
    expect(stream).toMatchObject({ running: 0, due: 1 });
    expect(stream?.oldestDueAt).toBe(expiredAt.toISOString());
  });
});
