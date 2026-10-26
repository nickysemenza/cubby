import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
} from "@cubby/schemas/ai-evaluation";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { dependencyStamps } from "~/server/ai/policy/refresh-manifest";
import { enqueueAiEvaluations } from "~/server/ai/repo/ai-evaluation-requests";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

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
    });
    expect(stream("ai.evaluation", "entity-connections")).toMatchObject({
      due: 1,
    });
  });
});
