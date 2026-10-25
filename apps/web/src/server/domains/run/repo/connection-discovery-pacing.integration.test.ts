import { connectionDiscoveryRunInput } from "@cubby/schemas/run-fields";
import { and, eq, inArray } from "drizzle-orm";
import { createRepoIdentity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  activateAiRefresh,
  readAiRefreshActivation,
} from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation, job, run, task } from "~/server/db/schema";
import { claimDerivedDiscovery } from "~/server/domains/run/repo/derived-discovery";
import { connectionDiscoveryJobHandler } from "~/server/domains/run/service/derived-discovery";
import { claimJob } from "~/server/generic/jobs/repo/jobs";

import { SUPERSEDED_RUN_FAILURE } from "./ai-refresh-state";
import {
  CONNECTION_DISCOVERY_PENDING_CAP,
  pendingConnectionEvaluations,
  prepareConnectionDiscoveryRoster,
} from "./connection-refresh";
import { ensureRun, systemActor } from "./ensure-run";

async function createDiscoveryRun(db: Database) {
  const activation = await readAiRefreshActivation(db);
  if (!activation) throw new Error("Synthetic AI refresh is not active");
  return ensureRun(db, systemActor(), {
    purpose: "connection_discovery",
    trigger: "scheduled",
    status: "running",
    execution: false,
    input: connectionDiscoveryRunInput.parse({
      kind: "connection_discovery",
      activation,
    }),
  });
}

async function connectionEvaluations(db: Database, recordId: string) {
  const rows = await getDb(db)
    .select({
      id: aiEvaluation.id,
      state: aiEvaluation.state,
      target: aiEvaluation.target,
    })
    .from(aiEvaluation)
    .where(eq(aiEvaluation.feature, "entity-connections"));
  return rows.filter(
    (row) =>
      typeof row.target === "object" &&
      row.target !== null &&
      "recordId" in row.target &&
      row.target.recordId === recordId,
  );
}

describe("connection discovery pacing", () => {
  const ctx = withTestDb();

  async function tasks(names: string[]) {
    await activateAiRefresh(ctx.db, "synthetic-discovery-pacing", {
      enabled: true,
    });
    const created = [];
    for (const name of names)
      created.push(
        await createRepoIdentity(ctx, "task", { name, trade: "other" }),
      );
    return created;
  }

  it("walks the newest records first and covers each exactly once", async () => {
    const created = await tasks(["Older task", "Middle task", "Newest task"]);
    let after: string | null = null;
    let pages = 0;
    do {
      const result: Awaited<
        ReturnType<typeof prepareConnectionDiscoveryRoster>
      > = await prepareConnectionDiscoveryRoster(ctx.db, {
        runId: null,
        after,
        limit: 2,
        entityKinds: ["task"],
        newestFirst: true,
        createRun: createDiscoveryRun,
      });
      after = result.next;
      pages += 1;
    } while (after && pages < 5);
    const evaluated = await getDb(ctx.db)
      .select({ target: aiEvaluation.target })
      .from(aiEvaluation)
      .where(eq(aiEvaluation.feature, "entity-connections"))
      .orderBy(aiEvaluation.createdAt);
    const recordIds = await Promise.all(
      created.map(async (item) => {
        const [row] = await getDb(ctx.db)
          .select({ id: task.id })
          .from(task)
          .where(eq(task.shortcode, item.output.id));
        return row!.id;
      }),
    );
    expect(
      evaluated.map((row) => (row.target as { recordId: string }).recordId),
    ).toEqual([...recordIds].reverse());
  });

  it("replaces a changed record's older queued evaluation", async () => {
    const [created] = await tasks(["Synthetic replaceable task"]);
    const page = () =>
      prepareConnectionDiscoveryRoster(ctx.db, {
        runId: null,
        after: null,
        limit: 25,
        entityKinds: ["task"],
        newestFirst: true,
        createRun: createDiscoveryRun,
      });
    await page();
    const [row] = await getDb(ctx.db)
      .select({ id: task.id })
      .from(task)
      .where(eq(task.shortcode, created!.output.id));
    await getDb(ctx.db)
      .update(task)
      .set({ name: "Synthetic replaceable task, renamed" })
      .where(eq(task.id, row!.id));
    await page();
    const states = (await connectionEvaluations(ctx.db, row!.id)).map(
      (item) => item.state,
    );
    expect(states.sort()).toEqual(["cancelled", "queued"]);
    const cancelledJobs = await getDb(ctx.db)
      .select({ state: job.state })
      .from(job)
      .where(and(eq(job.kind, "ai.evaluation"), eq(job.state, "cancelled")));
    expect(cancelledJobs).toHaveLength(1);
  });

  it.each([
    { failureCode: SUPERSEDED_RUN_FAILURE, readmitted: true },
    { failureCode: "user_cancelled", readmitted: false },
  ])(
    "re-admits cancelled work only when its Run was superseded ($failureCode)",
    async ({ failureCode, readmitted }) => {
      const [created] = await tasks(["Synthetic superseded task"]);
      const input = {
        runId: null,
        after: null,
        limit: 25,
        entityKinds: ["task"],
        newestFirst: true,
        createRun: createDiscoveryRun,
      };
      const first = await prepareConnectionDiscoveryRoster(ctx.db, input);
      if (!first.runId) throw new Error("Synthetic discovery admitted nothing");
      await getDb(ctx.db)
        .update(run)
        .set({ status: "failed", failureCode })
        .where(eq(run.id, first.runId));
      await getDb(ctx.db)
        .update(aiEvaluation)
        .set({ state: "cancelled" })
        .where(eq(aiEvaluation.runId, first.runId));
      const second = await prepareConnectionDiscoveryRoster(ctx.db, input);
      expect(second.inserted).toBe(readmitted ? 1 : 0);
      const [row] = await getDb(ctx.db)
        .select({ id: task.id })
        .from(task)
        .where(eq(task.shortcode, created!.output.id));
      const live = (await connectionEvaluations(ctx.db, row!.id)).filter(
        (item) => item.state === "queued",
      );
      expect(live).toHaveLength(readmitted ? 1 : 0);
    },
  );

  it("never appends into a stopped Run carried in the cursor", async () => {
    await tasks(["Synthetic stopped-run task"]);
    const stopped = await createDiscoveryRun(ctx.db);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: SUPERSEDED_RUN_FAILURE })
      .where(eq(run.id, stopped));
    const page = await prepareConnectionDiscoveryRoster(ctx.db, {
      runId: stopped,
      after: null,
      limit: 25,
      entityKinds: ["task"],
      newestFirst: true,
      createRun: createDiscoveryRun,
    });
    expect(page.runId).not.toBe(stopped);
    const inStopped = await getDb(ctx.db)
      .select({ id: aiEvaluation.id })
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, stopped));
    expect(inStopped).toEqual([]);
  });

  it("holds its cursor while the evaluation backlog is at the cap", async () => {
    await tasks(["Synthetic backpressure task"]);
    const owner = await createDiscoveryRun(ctx.db);
    await getDb(ctx.db)
      .insert(aiEvaluation)
      .values(
        Array.from(
          { length: CONNECTION_DISCOVERY_PENDING_CAP },
          (_, index) => ({
            runId: owner,
            workKey: `synthetic-backlog-${index}`,
            feature: "entity-connections",
            target: {},
            provenance: {},
            snapshot: {},
            state: "queued" as const,
            executionKind: "ai_refresh" as const,
          }),
        ),
      );
    expect(await pendingConnectionEvaluations(ctx.db)).toBe(
      CONNECTION_DISCOVERY_PENDING_CAP,
    );
    const saved = await claimDerivedDiscovery(ctx.db);
    const claim = await claimJob(ctx.db, saved.id);
    if (!claim) throw new Error("Synthetic discovery Job was not claimable");
    const prepared = await connectionDiscoveryJobHandler.prepare(ctx.db, {
      ...claim,
      cursor: { after: "synthetic-cursor", runId: null },
    });
    expect(prepared.page).toMatchObject({
      done: false,
      cursor: { after: "synthetic-cursor", runId: null },
      waitReason: "rate_limit",
    });
    const admitted = await getDb(ctx.db)
      .select({ id: aiEvaluation.id })
      .from(aiEvaluation)
      .where(
        and(
          eq(aiEvaluation.feature, "entity-connections"),
          inArray(aiEvaluation.state, ["queued"]),
        ),
      );
    expect(admitted).toHaveLength(CONNECTION_DISCOVERY_PENDING_CAP);
  });
});
