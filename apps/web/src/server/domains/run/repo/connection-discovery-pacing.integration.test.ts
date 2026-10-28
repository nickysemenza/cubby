import type { RunId } from "@cubby/schemas/identifiers";
import { connectionDiscoveryRunInput } from "@cubby/schemas/run-fields";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, inArray } from "drizzle-orm";
import { createRepoIdentity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateAiRefresh,
  readAiRefreshActivation,
} from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation, run, task } from "~/server/db/schema";
import { claimDerivedDiscovery } from "~/server/domains/run/repo/derived-discovery";
import { connectionDiscoveryJobHandler } from "~/server/domains/run/service/derived-discovery";
import { claimExternal } from "~/server/generic/jobs/repo/external-claim";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { claimContext } from "~/server/generic/jobs/service/jobs";

import { SUPERSEDED_RUN_FAILURE } from "./ai-refresh-state";
import * as discoveryRepo from "./connection-refresh";
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
  afterEach(() => vi.restoreAllMocks());

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

  it("updates a changed record's queued evaluation without cancelling its Job", async () => {
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
    expect(states).toEqual(["queued"]);
    const cancelledJobs = await readJobs(ctx.db, {
      kind: "ai.evaluation",
      states: ["cancelled"],
    }).then((rows) => rows.map(({ state }) => ({ state })));
    expect(cancelledJobs).toHaveLength(0);
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

  it("stops at roster admission when the owning Run was member-cancelled", async () => {
    await tasks(["Synthetic keyed continuation task"]);
    // Production opens the pass Run with a key per Job claim; reopening with
    // the same key returns the stopped Run, which must not receive work.
    const keyed = async (db: Database, replacing: RunId | null) => {
      const activation = await readAiRefreshActivation(db);
      if (!activation) throw new Error("Synthetic AI refresh is not active");
      return ensureRun(db, systemActor(), {
        purpose: "connection_discovery",
        trigger: "scheduled",
        status: "running",
        execution: false,
        clientKey: `connection-discovery:synthetic-claim:1${replacing ? `:after:${replacing}` : ""}`,
        input: connectionDiscoveryRunInput.parse({
          kind: "connection_discovery",
          activation,
        }),
      });
    };
    const stopped = await keyed(ctx.db, null);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "user_cancelled" })
      .where(eq(run.id, stopped));
    const page = await prepareConnectionDiscoveryRoster(ctx.db, {
      runId: stopped,
      after: null,
      limit: 25,
      entityKinds: ["task"],
      newestFirst: true,
      createRun: keyed,
    });
    expect(page).toMatchObject({
      outcome: "member-stopped",
      runId: null,
      inserted: 0,
    });
    const inStopped = await getDb(ctx.db)
      .select({ id: aiEvaluation.id })
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, stopped));
    expect(inStopped).toEqual([]);
  });

  it("keeps the stopped Run's identity across a page that admits nothing", async () => {
    await tasks(["Synthetic late continuation task"]);
    const keyed = async (db: Database, replacing: RunId | null) => {
      const activation = await readAiRefreshActivation(db);
      if (!activation) throw new Error("Synthetic AI refresh is not active");
      return ensureRun(db, systemActor(), {
        purpose: "connection_discovery",
        trigger: "scheduled",
        status: "running",
        execution: false,
        clientKey: `connection-discovery:synthetic-claim:2${replacing ? `:after:${replacing}` : ""}`,
        input: connectionDiscoveryRunInput.parse({
          kind: "connection_discovery",
          activation,
        }),
      });
    };
    const stopped = await keyed(ctx.db, null);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: SUPERSEDED_RUN_FAILURE })
      .where(eq(run.id, stopped));
    // A page with nothing admissible right after the stop.
    const empty = await prepareConnectionDiscoveryRoster(ctx.db, {
      runId: stopped,
      after: null,
      limit: 25,
      entityKinds: ["plant"],
      newestFirst: true,
      createRun: keyed,
    });
    expect(empty).toMatchObject({ runId: null, replacing: stopped });
    const later = await prepareConnectionDiscoveryRoster(ctx.db, {
      runId: empty.runId,
      replacing: empty.replacing,
      after: null,
      limit: 25,
      entityKinds: ["task"],
      newestFirst: true,
      createRun: keyed,
    });
    expect(later.runId).not.toBeNull();
    expect(later.runId).not.toBe(stopped);
    expect(later.inserted).toBe(1);
    expect(later.replacing).toBeNull();
  });

  it("continues after a Run its open returns stopped when the cursor never saved it", async () => {
    await tasks(["Synthetic unpublished continuation task"]);
    const keyed = async (db: Database, replacing: RunId | null) => {
      const activation = await readAiRefreshActivation(db);
      if (!activation) throw new Error("Synthetic AI refresh is not active");
      return ensureRun(db, systemActor(), {
        purpose: "connection_discovery",
        trigger: "scheduled",
        status: "running",
        execution: false,
        clientKey: `connection-discovery:synthetic-claim:3${replacing ? `:after:${replacing}` : ""}`,
        input: connectionDiscoveryRunInput.parse({
          kind: "connection_discovery",
          activation,
        }),
      });
    };
    // Preparation committed this Run, then publication failed before the
    // cursor saved it; the member cancelled it before the replay.
    const stopped = await keyed(ctx.db, null);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: SUPERSEDED_RUN_FAILURE })
      .where(eq(run.id, stopped));
    const replay = await prepareConnectionDiscoveryRoster(ctx.db, {
      runId: null,
      replacing: null,
      after: null,
      limit: 25,
      entityKinds: ["task"],
      newestFirst: true,
      createRun: keyed,
    });
    expect(replay.runId).not.toBeNull();
    expect(replay.runId).not.toBe(stopped);
    expect(replay.inserted).toBe(1);
    expect(replay.replacing).toBeNull();
  });

  it("updates the queued slot when input reverts before execution", async () => {
    const [created] = await tasks(["Synthetic reverting task"]);
    const [row] = await getDb(ctx.db)
      .select({ id: task.id })
      .from(task)
      .where(eq(task.shortcode, created!.output.id));
    const page = () =>
      prepareConnectionDiscoveryRoster(ctx.db, {
        runId: null,
        after: null,
        limit: 25,
        entityKinds: ["task"],
        newestFirst: true,
        createRun: createDiscoveryRun,
      });
    const rename = (name: string) =>
      getDb(ctx.db).update(task).set({ name }).where(eq(task.id, row!.id));
    await page(); // fingerprint A queued
    await rename("Synthetic reverting task, edited");
    await page(); // queued slot now captures B
    await rename("Synthetic reverting task");
    await page(); // the same queued slot captures A again
    const states = (await connectionEvaluations(ctx.db, row!.id)).map(
      (item) => item.state,
    );
    expect(states.filter((state) => state === "queued")).toHaveLength(1);
    expect(states).toEqual(["queued"]);
  });

  // Even an unfinished queued slot remains stopped after its owner is cancelled.
  it("never updates a queued slot whose Run the member cancelled", async () => {
    const [created] = await tasks(["Synthetic cancelled reverting task"]);
    const [row] = await getDb(ctx.db)
      .select({ id: task.id })
      .from(task)
      .where(eq(task.shortcode, created!.output.id));
    const page = () =>
      prepareConnectionDiscoveryRoster(ctx.db, {
        runId: null,
        after: null,
        limit: 25,
        entityKinds: ["task"],
        newestFirst: true,
        createRun: createDiscoveryRun,
      });
    const rename = (name: string) =>
      getDb(ctx.db).update(task).set({ name }).where(eq(task.id, row!.id));
    const first = await page(); // fingerprint A queued
    if (!first.runId) throw new Error("Synthetic discovery admitted nothing");
    await rename("Synthetic cancelled reverting task, edited");
    await page(); // queued slot now captures B
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "user_cancelled" })
      .where(eq(run.id, first.runId));
    await rename("Synthetic cancelled reverting task");
    const reverted = await page();
    expect(reverted.inserted).toBe(0);
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
            target: {
              kind: "connection" as const,
              entity: "task" as const,
              recordId: crypto.randomUUID(),
              field: null,
              assessmentIds: [],
            },
            provenance: {
              dependencies: [],
              inputFingerprint: `synthetic-backlog-${index}`,
              optionFingerprint: "synthetic",
              model: null,
            },
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
    const claim = await claimExternal(ctx.db, saved.id);
    if (!claim) throw new Error("Synthetic discovery Job was not claimable");
    const prepared = await connectionDiscoveryJobHandler.prepare(
      ctx.db,
      {
        ...claim,
        cursor: { after: "synthetic-cursor", runId: null },
      },
      fromPartial({ signal: new AbortController().signal }),
    );
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
  it("stops the pass for a day when a member cancels its Run", async () => {
    await tasks(["Synthetic member-stopped task"]);
    const cancelled = await createDiscoveryRun(ctx.db);
    // The member cancels after the handler began, before roster admission.
    // An earlier out-of-transaction stop check cannot observe this cancellation.
    const pending = discoveryRepo.pendingConnectionEvaluations;
    vi.spyOn(
      discoveryRepo,
      "pendingConnectionEvaluations",
    ).mockImplementationOnce(async (db) => {
      await getDb(db)
        .update(run)
        .set({ status: "failed", failureCode: "user_cancelled" })
        .where(eq(run.id, cancelled));
      return pending(db);
    });
    const saved = await claimDerivedDiscovery(ctx.db);
    const claim = await claimExternal(ctx.db, saved.id);
    if (!claim) throw new Error("Synthetic discovery Job was not claimable");
    const before = Date.now();
    const prepared = await connectionDiscoveryJobHandler.prepare(
      ctx.db,
      {
        ...claim,
        cursor: { after: null, runId: cancelled },
      },
      claimContext(ctx.db, claim),
    );
    expect(prepared.page).toMatchObject({
      done: false,
      cursor: { after: null, runId: null, replacing: null },
    });
    const page = prepared.page as { waitUntil?: Date };
    expect(page.waitUntil?.getTime()).toBeGreaterThanOrEqual(
      before + 23 * 60 * 60_000,
    );
    const opened = await getDb(ctx.db)
      .select({ id: run.id })
      .from(run)
      .where(eq(run.purpose, "connection_discovery"));
    expect(opened.map((row) => row.id)).toEqual([cancelled]);
  });
});
