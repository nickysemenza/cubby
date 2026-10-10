import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Coordinator retirement: a settled agent Run's transcript is destroyed, and
 * `Run.retiredAt` is stamped only once a cold coordinator reports empty
 * storage — an isolate interruption is not a deletion receipt. A retired
 * coordinator never executes again, and a late in-flight result never
 * repopulates the erased content.
 */
import { type LedgerPartyId, runEntityId } from "@cubby/schemas/identifiers";
import {
  type AgentImportRunPurpose,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";
import {
  captureE2ERunIdentity,
  writeE2ERunBundle,
  type E2ERunIdentity,
} from "tooling/e2e-run-bundle";
import { sanitizeWorkerdLogs } from "tooling/e2e-workerd-logs";
import { withTestDb } from "tooling/test-setup";
import {
  HOLD_WORKERD_HARNESS_TIMEOUT_MS,
  holdWorkerdHarness,
} from "tooling/workerd-harness";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import { run, runOperation } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  executeAtomicOperation,
  executeLeasedOperation,
} from "~/server/runs/operation";

import { startAgentRunFixture } from "./import-run.fixtures";
import {
  startScenarioHarness,
  type ScenarioHarness,
} from "./purchase-agent-workerd.fixtures";
import {
  assertRetirableRun,
  coordinatorRetired,
  retireSettledCoordinators,
} from "./run-retirement";

const ctx = withTestDb();

// One member party per actor; each test's database starts without it.
let member: { id: LedgerPartyId } | undefined;
beforeEach(() => {
  member = undefined;
});
async function agentRun() {
  member ??= await insertWithShortcode(ctx.db, "ledgerParty", {
    name: "Synthetic coordinator owner",
    kind: "member",
    userId: ctx.actor.userId,
  });
  const started = await startAgentRunFixture(ctx.db, {
    ledgerPartyId: member.id,
  });
  return runEntityId.parse(started.id);
}

const settle = (runId: string, updatedAt = new Date(Date.now() - 60_000)) =>
  getDb(ctx.db)
    .update(run)
    .set({ status: "completed", updatedAt })
    .where(eq(run.id, runEntityId.parse(runId)));

const retire = (runId: string) =>
  getDb(ctx.db)
    .update(run)
    .set({ retiredAt: new Date(), retirementReason: "settled" })
    .where(eq(run.id, runEntityId.parse(runId)));

// A Run of a retired purpose keeps its original coordinator identity.
const retirePurpose = (runId: string) =>
  getDb(ctx.db)
    .update(run)
    .set({ purpose: "product_enrichment" })
    .where(eq(run.id, runEntityId.parse(runId)));

const readRun = async (runId: string) => {
  const [row] = await getDb(ctx.db)
    .select()
    .from(run)
    .where(eq(run.id, runEntityId.parse(runId)));
  return row;
};

describe("settled coordinator retirement", () => {
  it("retires only settled agent Runs, stamping retiredAt only after the coordinator acknowledges disposal", async () => {
    const live = await agentRun();
    const settled = await agentRun();
    await settle(settled);
    const fresh = await agentRun();
    await settle(fresh, new Date());
    const calls: string[] = [];
    let disposed = false;
    const coordinator = (agentId: string) => ({
      retire: async () => {
        calls.push(agentId);
        return { disposed };
      },
    });
    const before = new Date(Date.now() - 1_000);

    // The first call destroys the transcript and one follow-up asks for the
    // empty-inventory proof; without it nothing is stamped yet.
    expect(
      await retireSettledCoordinators(ctx.db, coordinator, before),
    ).toEqual({ considered: 1, retired: 0 });
    const settledAgent = importRunAgentIdentity(settled, "mail_import");
    expect(calls).toEqual([settledAgent, settledAgent]);
    expect(await coordinatorRetired(ctx.db, settled)).toBe(false);

    disposed = true;
    expect(
      await retireSettledCoordinators(ctx.db, coordinator, before),
    ).toEqual({ considered: 1, retired: 1 });
    expect(await readRun(settled)).toMatchObject({
      retirementReason: "settled",
      retiredAt: expect.any(Date),
    });
    expect(await coordinatorRetired(ctx.db, settled)).toBe(true);
    // A retired Run is never offered to its coordinator again.
    expect(
      await retireSettledCoordinators(ctx.db, coordinator, before),
    ).toEqual({ considered: 0, retired: 0 });
    for (const untouched of [live, fresh]) {
      expect(await coordinatorRetired(ctx.db, untouched)).toBe(false);
    }
  });

  it("offers a settled Run of a retired purpose by its stored coordinator identity", async () => {
    const historical = await agentRun();
    await retirePurpose(historical);
    await settle(historical);
    const calls: string[] = [];
    const coordinator = (agentId: string) => ({
      retire: async () => {
        calls.push(agentId);
        return { disposed: true };
      },
    });
    expect(
      await retireSettledCoordinators(
        ctx.db,
        coordinator,
        new Date(Date.now() - 1_000),
      ),
    ).toEqual({ considered: 1, retired: 1 });
    expect(calls).toEqual([importRunAgentIdentity(historical, "mail_import")]);
    expect(await coordinatorRetired(ctx.db, historical)).toBe(true);
  });

  // Regression: 25 unordered Runs per daily pass, each needing a second pass
  // for its acknowledgement, left a production backlog of months.
  it("retires a backlog oldest first in one pass, confirming each disposal immediately", async () => {
    const runs = [];
    for (let index = 0; index < 30; index += 1) runs.push(await agentRun());
    // Settled newest first, so storage order differs from age order.
    for (const [index, runId] of runs.entries())
      await settle(runId, new Date(Date.now() - 60_000 * (index + 1)));
    const oldestFirst = [...runs].reverse();
    // Real semantics: the destroying call reports disposed=false; a fresh
    // call then sees only the fence and acknowledges.
    const destroyed = new Set<string>();
    const calls: string[] = [];
    const coordinator = (agentId: string) => ({
      retire: async () => {
        calls.push(agentId);
        if (destroyed.has(agentId)) return { disposed: true };
        destroyed.add(agentId);
        return { disposed: false };
      },
    });
    const before = new Date(Date.now() - 1_000);

    expect(
      await retireSettledCoordinators(ctx.db, coordinator, before, 2),
    ).toEqual({ considered: 2, retired: 2 });
    expect([...new Set(calls)]).toEqual(
      oldestFirst
        .slice(0, 2)
        .map((runId) => importRunAgentIdentity(runId, "mail_import")),
    );

    expect(
      await retireSettledCoordinators(ctx.db, coordinator, before),
    ).toEqual({ considered: 28, retired: 28 });
    for (const runId of runs)
      expect(await coordinatorRetired(ctx.db, runId)).toBe(true);
  });

  // Oldest-first ordering would let one failing coordinator stall every pass.
  it("keeps retiring after one coordinator fails, then reports the failure", async () => {
    const failing = await agentRun();
    const healthy = await agentRun();
    await settle(failing, new Date(Date.now() - 120_000));
    await settle(healthy);
    const failingAgent = importRunAgentIdentity(failing, "mail_import");
    const coordinator = (agentId: string) => ({
      retire: async () => {
        if (agentId === failingAgent)
          throw new Error("Synthetic coordinator failure");
        return { disposed: true };
      },
    });
    await expect(
      retireSettledCoordinators(
        ctx.db,
        coordinator,
        new Date(Date.now() - 1_000),
      ),
    ).rejects.toThrow("Synthetic coordinator failure");
    expect(await coordinatorRetired(ctx.db, healthy)).toBe(true);
    expect(await coordinatorRetired(ctx.db, failing)).toBe(false);
  });

  it("authorizes coordinator disposal only for a settled Run", async () => {
    const live = await agentRun();
    await expect(assertRetirableRun(ctx.db, live)).rejects.toThrow(
      "Only a settled Run's coordinator can be retired.",
    );
    await expect(
      assertRetirableRun(ctx.db, crypto.randomUUID()),
    ).rejects.toThrow("Only a settled Run's coordinator can be retired.");
    await settle(live);
    await expect(assertRetirableRun(ctx.db, live)).resolves.toEqual({
      current: true,
    });
    // A missing Run reads as retired, so no coordinator executes for it.
    expect(await coordinatorRetired(ctx.db, crypto.randomUUID())).toBe(true);
  });
});

// Retirement can commit while a tool call is in flight. Its late completion or
// failure must not repopulate disposable source content.
describe("retired coordinator operation fence", () => {
  it("rejects a late leased result instead of caching erased source content", async () => {
    const runId = await agentRun();
    await expect(
      executeLeasedOperation(
        ctx.db,
        {
          runId,
          operationId: "synthetic-in-flight-read",
          kind: "mail_read",
          payload: {},
        },
        async () => {
          await retire(runId);
          return { text: "Synthetic private source" };
        },
      ),
    ).rejects.toThrow(/retired/i);
    const rows = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.runId, runId));
    expect(rows.every((row) => row.result === null)).toBe(true);
  });

  it("refuses a new tool call and does not record a failed attempt after retirement", async () => {
    const runId = await agentRun();
    await expect(
      executeAtomicOperation(
        ctx.db,
        {
          runId,
          operationId: "synthetic-in-flight-write",
          kind: "purchase_commit",
          payload: { detail: "Synthetic private source" },
          subject: "Commit",
          recordFailure: true,
          retainAttempt: true,
        },
        async () => {
          await retire(runId);
          throw new Error("Synthetic write interrupted");
        },
      ),
    ).rejects.toThrow("Synthetic write interrupted");
    await expect(
      executeLeasedOperation(
        ctx.db,
        {
          runId,
          operationId: "synthetic-late-call",
          kind: "mail_read",
          payload: {},
        },
        async () => ({ text: "Synthetic private source" }),
      ),
    ).rejects.toThrow(/retired/i);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, runId)),
    ).toEqual([]);
  });
});

const disposal = z.object({ disposed: z.boolean() });
type CoordinatorRequest = {
  agentId: string;
  purpose?: AgentImportRunPurpose;
  event?: PurchaseAgentEvent;
};

describe("coordinator host retirement", () => {
  let releaseHarness:
    | Awaited<ReturnType<typeof holdWorkerdHarness>>
    | undefined;
  beforeAll(async () => {
    releaseHarness = await holdWorkerdHarness();
  }, HOLD_WORKERD_HARNESS_TIMEOUT_MS);
  afterAll(() => releaseHarness?.());
  let runtime: ScenarioHarness | undefined;
  let started: E2ERunIdentity;
  let status = "failed";
  const scenario = "synthetic-settled-coordinator-disposal";
  let observations: Array<{
    boundary: string;
    expected: number | boolean;
    actual: number | boolean;
  }> = [];
  const repoRoot = path.resolve(process.cwd(), "../..");
  beforeEach(() => {
    started = captureE2ERunIdentity(repoRoot);
    status = "failed";
    observations = [];
  });
  afterEach(async () => {
    const inventory = sanitizeWorkerdLogs(
      runtime?.harness
        .getLogs()
        .filter((entry) => entry.message.includes("storage-inventory")) ?? [],
    );
    await runtime?.close();
    runtime = undefined;
    const outputDir = `/tmp/cubby-run-retirement-host-${Date.now()}`;
    mkdirSync(outputDir, { recursive: true });
    const evidence = path.join(outputDir, "boundary-results.json");
    writeFileSync(
      evidence,
      JSON.stringify(
        {
          status,
          boundary:
            "Settled coordinator disposal acknowledged cold, then execution fenced",
          source:
            "Synthetic fixtures only; no model requests or production data",
          observations,
          inventory,
        },
        null,
        2,
      ),
    );
    writeE2ERunBundle({
      repoRoot,
      outputDir,
      evidence: [evidence],
      kind: "browser",
      status,
      command: [
        "pnpm",
        "--dir",
        "apps/web",
        "test:postgres",
        "src/server/purchase-import/run-retirement.integration.test.ts",
        "--project",
        "integration-workerd",
      ],
      profile: "purchase-agent",
      scenario,
      started,
      cases: [{ name: scenario, status }],
    });
  });

  it("stamps retiredAt in one pass only after a cold empty retry, then fences fetch and dispatch", async () => {
    const runId = await agentRun();
    runtime = await startScenarioHarness(ctx.databaseUrl, { steps: [] });
    const peer = runtime.harness.getWorker("cubby-queue-producer");
    const agentId = importRunAgentIdentity(runId, "mail_import");
    const request = (pathname: string, body: CoordinatorRequest) =>
      peer.fetch(new URL(pathname, "https://queue.test"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    // Serving an absent conversation creates real SDK SQLite state without a model turn.
    expect((await request("/coordinator-fetch", { agentId })).status).toBe(200);
    // A live Run's coordinator refuses disposal.
    const liveRetire = await request("/coordinator-retire", { agentId }).then(
      (response) => response.status,
      () => 500,
    );
    expect(liveRetire).not.toBe(200);
    await settle(runId);
    const coordinator = () => ({
      retire: async () => {
        const response = await request("/coordinator-retire", { agentId });
        if (!response.ok) throw new Error(await response.text());
        return disposal.parse(await response.json());
      },
    });
    // SDK destroy aborts the destroying isolate (and may abort that RPC); the
    // immediate follow-up reaches a fresh instance whose empty inventory
    // acknowledges disposal, so one pass stamps retiredAt.
    const first = await retireSettledCoordinators(
      ctx.db,
      coordinator,
      new Date(),
    );
    observations.push({
      boundary: "single-pass disposal",
      expected: 1,
      actual: first.retired,
    });
    expect(first).toEqual({ considered: 1, retired: 1 });
    expect(await readRun(runId)).toMatchObject({
      retirementReason: "settled",
      retiredAt: expect.any(Date),
    });
    const retiredFetch = await request("/coordinator-fetch", { agentId });
    observations.push({
      boundary: "retired fetch",
      expected: 410,
      actual: retiredFetch.status,
    });
    expect(retiredFetch.status).toBe(410);
    const reconnect = await request("/coordinator-dispatch", {
      agentId,
      purpose: "mail_import",
      event: {
        version: 1,
        type: "start_or_resume",
        runId,
        eventId: "synthetic-retired-reconnect",
      },
    });
    const admission = z
      .object({ accepted: z.boolean() })
      .parse(await reconnect.json());
    observations.push({
      boundary: "retired dispatch",
      expected: false,
      actual: admission.accepted,
    });
    expect(admission).toEqual({ accepted: false });
    expect(await runtime.emitted()).toEqual([]);
    status = "passed";
  }, 90_000);

  it("destroys a retired purpose's coordinator storage and acknowledges it cold", async () => {
    const runId = await agentRun();
    await retirePurpose(runId);
    runtime = await startScenarioHarness(ctx.databaseUrl, { steps: [] });
    const peer = runtime.harness.getWorker("cubby-queue-producer");
    const agentId = importRunAgentIdentity(runId, "mail_import");
    const request = (pathname: string) =>
      peer.fetch(new URL(pathname, "https://queue.test"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
    // Historical SDK storage, as a pre-retirement coordinator left it.
    expect((await request("/coordinator-fetch")).status).toBe(200);
    await settle(runId);
    const coordinator = () => ({
      retire: async () => {
        const response = await request("/coordinator-retire");
        if (!response.ok) throw new Error(await response.text());
        return disposal.parse(await response.json());
      },
    });
    const first = await retireSettledCoordinators(
      ctx.db,
      coordinator,
      new Date(),
    );
    observations.push({
      boundary: "historical single-pass disposal",
      expected: 1,
      actual: first.retired,
    });
    expect(first).toEqual({ considered: 1, retired: 1 });
    expect((await request("/coordinator-fetch")).status).toBe(410);
    status = "passed";
  }, 90_000);

  // Regression: the empty-storage acknowledgement precedes the retiredAt
  // stamp, so an entry point in that gap — even on an instance restarted
  // after the acknowledgement — once passed the fence and recreated SDK
  // storage that the stamped Run then never disposed.
  it("refuses entry points once retirement begins, across a restart before retiredAt is stamped", async () => {
    const runId = await agentRun();
    await retirePurpose(runId);
    runtime = await startScenarioHarness(ctx.databaseUrl, { steps: [] });
    const { harness } = runtime;
    const agentId = importRunAgentIdentity(runId, "mail_import");
    const request = (pathname: string) =>
      harness
        .getWorker("cubby-queue-producer")
        .fetch(new URL(pathname, "https://queue.test"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId }),
        });
    const retireCall = async () => {
      const response = await request("/coordinator-retire");
      if (!response.ok) throw new Error(await response.text());
      return disposal.parse(await response.json());
    };
    expect((await request("/coordinator-fetch")).status).toBe(200);
    await settle(runId);
    expect(await retireCall()).toEqual({ disposed: false });
    expect(await retireCall()).toEqual({ disposed: true });
    // The caller has the acknowledgement but has not stamped retiredAt yet.
    expect(await coordinatorRetired(ctx.db, runId)).toBe(false);
    // A deploy reloads every Worker, so the coordinator restarts cold.
    await harness.update((options) => options);
    const gapFetch = (await request("/coordinator-fetch")).status;
    observations.push({
      boundary: "fetch between acknowledgement and retiredAt",
      expected: 410,
      actual: gapFetch,
    });
    expect(gapFetch).toBe(410);
    const repeat = await retireCall();
    observations.push({
      boundary: "repeat acknowledgement after gap fetch",
      expected: true,
      actual: repeat.disposed,
    });
    expect(repeat).toEqual({ disposed: true });
    status = "passed";
  }, 90_000);
});
