import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Coordinator retirement: a settled agent Run's transcript is destroyed, and
 * `Run.retiredAt` is stamped only once a cold coordinator reports empty
 * storage — an isolate interruption is not a deletion receipt. A retired
 * coordinator never executes again, and a late in-flight result never
 * repopulates the erased content.
 */
import { backgroundTaskSchema } from "@cubby/schemas/background-tasks";
import { type LedgerPartyId, runEntityId } from "@cubby/schemas/identifiers";
import {
  type AgentImportRunPurpose,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import {
  captureE2ERunIdentity,
  writeE2ERunBundle,
  type E2ERunIdentity,
} from "tooling/e2e-run-bundle";
import { sanitizeWorkerdLogs } from "tooling/e2e-workerd-logs";
import { withTestDb } from "tooling/test-setup";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { handleBackgroundTask } from "~/server/background-tasks/handle";
import { setCfEnv } from "~/server/cf-env";
import { run, runOperation, runFinding } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { findOpenRunFindings } from "~/server/repo/problems/detectors-import";
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
  assertRetirableLegacySession,
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

// Legacy account_sync Runs stored a bare session UUID, not their Run id, as
// the coordinator name.
const legacySession = (runId: string, agentSessionId = crypto.randomUUID()) =>
  getDb(ctx.db)
    .update(run)
    .set({ purpose: "account_sync", agentSessionId })
    .where(eq(run.id, runEntityId.parse(runId)))
    .then(() => agentSessionId);

const readRun = async (runId: string) => {
  const [row] = await getDb(ctx.db)
    .select()
    .from(run)
    .where(eq(run.id, runEntityId.parse(runId)));
  return row;
};

describe("settled coordinator retirement", () => {
  // Obsolete execution alerts must close for both new and historical retirements;
  // source review and live coordinator alerts must retain their evidence and status.
  it("dismisses only obsolete execution alerts on new and existing retired Runs", async () => {
    const historical = await agentRun();
    await settle(historical);
    await retire(historical);
    const newlySettled = await agentRun();
    await settle(newlySettled);
    const live = await agentRun();
    const owner = (await readRun(historical))!.ledgerPartyId!;
    const findings = [];
    for (const runId of [historical, newlySettled, live]) {
      for (const [index, summary] of [
        "No coordinator activity for two hours",
        "Coordinator ended without finishing the run",
        "Synthetic source still needs review",
      ].entries()) {
        findings.push({
          runId,
          entityId: runId,
          entityKind: "run" as const,
          ledgerPartyId: owner,
          kind: "other",
          summary,
          evidenceFingerprint: `synthetic-${runId}-${index}`,
        });
      }
    }
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic retained review product",
      manufacturer: "Synthetic maker",
    });
    await getDb(ctx.db)
      .insert(runFinding)
      .values([
        ...findings,
        {
          runId: historical,
          entityId: product.id,
          entityKind: "product",
          ledgerPartyId: owner,
          kind: "other",
          summary: "No coordinator activity for two hours",
          evidenceFingerprint: "synthetic-product-review",
        },
        {
          runId: historical,
          entityId: newlySettled,
          entityKind: "run",
          ledgerPartyId: owner,
          kind: "other",
          summary: "Coordinator ended without finishing the run",
          evidenceFingerprint: "synthetic-other-run-review",
        },
      ]);
    const before = await getDb(ctx.db).select().from(runFinding);
    const visible = await findOpenRunFindings(ctx.db);
    expect(visible.map((row) => row.id).sort()).toEqual(
      before
        .filter(
          (row) =>
            !(
              row.runId === historical &&
              row.entityKind === "run" &&
              row.entityId === row.runId &&
              row.summary !== "Synthetic source still needs review"
            ),
        )
        .map((row) => row.id)
        .sort(),
    );
    await retireSettledCoordinators(
      ctx.db,
      () => ({ retire: async () => ({ disposed: true }) }),
      new Date(),
    );
    const after = await getDb(ctx.db).select().from(runFinding);
    expect(after).toHaveLength(before.length);
    const obsolete = (original: (typeof before)[number]) =>
      original.runId !== live &&
      original.entityKind === "run" &&
      original.entityId === original.runId &&
      original.summary !== "Synthetic source still needs review";
    for (const original of before.filter(obsolete))
      expect(after.find((row) => row.id === original.id)).toEqual({
        ...original,
        status: "dismissed",
        resolvedAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
    for (const original of before.filter((row) => !obsolete(row)))
      expect(after.find((row) => row.id === original.id)).toEqual(original);
    expect((await readRun(live))!.retiredAt).toBeNull();
  });

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

  it("authorizes a legacy coordinator name only for the one settled Run storing it", async () => {
    const legacy = await agentRun();
    const agentId = await legacySession(legacy);
    const refused =
      "Only one settled Run storing this coordinator name can retire it.";
    // Live mapping.
    await expect(assertRetirableLegacySession(ctx.db, agentId)).rejects.toThrow(
      refused,
    );
    await settle(legacy);
    await expect(
      assertRetirableLegacySession(ctx.db, agentId),
    ).resolves.toBeUndefined();
    // Missing mapping, and the Run id itself is not the stored name.
    for (const name of [crypto.randomUUID(), legacy])
      await expect(assertRetirableLegacySession(ctx.db, name)).rejects.toThrow(
        refused,
      );
    // Ambiguous mapping.
    const twin = await agentRun();
    await legacySession(twin, agentId);
    await settle(twin);
    await expect(assertRetirableLegacySession(ctx.db, agentId)).rejects.toThrow(
      refused,
    );
    // A current purpose is always addressed by its import Run identity.
    const current = await agentRun();
    await settle(current);
    const currentName = crypto.randomUUID();
    await getDb(ctx.db)
      .update(run)
      .set({ agentSessionId: currentName })
      .where(eq(run.id, current));
    await expect(
      assertRetirableLegacySession(ctx.db, currentName),
    ).rejects.toThrow(refused);
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
  // Each case addresses only its own Run's coordinator, so one Worker serves
  // them all; the restart case's reload leaves it usable for later cases.
  let shared: ScenarioHarness | undefined;
  const sharedRuntime = async () =>
    (shared ??= await startScenarioHarness(ctx.databaseUrl, { steps: [] }));

  it("reads committed transcript on a cold coordinator without opening or recovering pending work", async () => {
    const runtime = await sharedRuntime();
    const runId = await agentRun();
    const name = importRunAgentIdentity(runId, "mail_import");
    let storage = await runtime.harness
      .getWorker()
      .getDurableObjectStorage("PurchaseImportRunAgent", { name });
    // These are the installed pi SQLite adapter's persisted read surfaces.
    // An execution harness cannot initialize this deliberately read-only seed.
    await storage.exec(
      "CREATE TABLE pi_durable_schema (singleton INTEGER, version INTEGER)",
    );
    await storage.exec("INSERT INTO pi_durable_schema VALUES (1, 1)");
    await storage.exec(
      "CREATE TABLE pi_conversations (id INTEGER, record TEXT)",
    );
    await storage.exec("INSERT INTO pi_conversations VALUES (1, '{}')");
    await storage.exec(
      "CREATE TABLE pi_entries (id INTEGER, conversation_id INTEGER, record TEXT)",
    );
    const entry = JSON.stringify({
      id: 2,
      conversationId: 1,
      kind: "pi.user",
      model: [
        {
          role: "user",
          content: "Synthetic retained instruction",
          timestamp: 1,
        },
      ],
    });
    await storage.exec("INSERT INTO pi_entries VALUES (2, 1, ?)", entry);
    await storage.exec(
      "CREATE TABLE pi_tasks (id INTEGER, conversation_id INTEGER, status TEXT, record TEXT)",
    );
    await storage.exec(
      "INSERT INTO pi_tasks VALUES (3, 1, 'pending', '{\"syntheticPendingTool\":true}')",
    );
    const inventory = async () => ({
      tables: await storage.exec(
        "SELECT name, sql FROM sqlite_master ORDER BY name",
      ),
      entries: await storage.exec("SELECT * FROM pi_entries"),
      tasks: await storage.exec("SELECT * FROM pi_tasks"),
    });
    const before = await inventory();
    await runtime.harness.update((options) => options);
    storage = await runtime.harness
      .getWorker()
      .getDurableObjectStorage("PurchaseImportRunAgent", { name });
    const response = await runtime.harness
      .getWorker("cubby-queue-producer")
      .fetch("https://queue.test/coordinator-transcript", {
        method: "POST",
        body: JSON.stringify({ agentId: name }),
      });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "running",
      messages: [
        { parts: [{ type: "text", text: "Synthetic retained instruction" }] },
      ],
      settlements: [],
    });
    expect(await inventory()).toEqual(before);
    expect(await runtime.emitted()).toEqual([]);
    status = "passed";
  }, 90_000);
  afterAll(() => shared?.close());
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
    shared?.harness.clearLogs();
  });
  afterEach(() => {
    setCfEnv(undefined);
    const inventory = sanitizeWorkerdLogs(
      shared?.harness
        .getLogs()
        .filter((entry) => entry.message.includes("storage-inventory")) ?? [],
    );
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
    const runtime = await sharedRuntime();
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
    setCfEnv(
      fromPartial<Env>({
        PURCHASE_IMPORT_RUN: { getByName: coordinator },
      }),
    );
    const requestedAt = new Date().toISOString();
    await handleBackgroundTask(
      ctx.db,
      backgroundTaskSchema.parse({
        kind: "maintenance.recover",
        requestedAt,
      }),
    );
    expect((await readRun(runId))?.retiredAt).toBeNull();
    await handleBackgroundTask(
      ctx.db,
      backgroundTaskSchema.parse({
        kind: "maintenance.recover",
        requestedAt,
        coordinatorRetireBefore: requestedAt,
      }),
    );
    const disposed = (await readRun(runId))?.retiredAt !== null;
    observations.push({
      boundary: "single-pass disposal",
      expected: true,
      actual: disposed,
    });
    expect(disposed).toBe(true);
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
    const storage = await runtime.harness
      .getWorker()
      .getDurableObjectStorage("PurchaseImportRunAgent", { name: agentId });
    const beforeRead = await storage.exec(
      "SELECT name, sql FROM sqlite_master ORDER BY name",
    );
    const beforeRun = await readRun(runId);
    const transcript = await request("/coordinator-transcript", { agentId });
    expect(transcript.status).toBe(200);
    expect(await transcript.json()).toEqual({
      status: "absent",
      messages: [],
      settlements: [],
    });
    expect(
      await storage.exec("SELECT name, sql FROM sqlite_master ORDER BY name"),
    ).toEqual(beforeRead);
    expect(await readRun(runId)).toEqual(beforeRun);
    const reconnect = await request("/coordinator-dispatch", {
      agentId,
      purpose: "mail_import",
      event: {
        version: 1,
        type: "start_or_resume",
        runId,
        eventId: "synthetic-retired-reconnect",
        generation: "synthetic-retired-reconnect",
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
    const runtime = await sharedRuntime();
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
    const runtime = await sharedRuntime();
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

  // Legacy SDK storage, seeded where a pre-identity coordinator left it.
  const seedLegacyStorage = async (runtime: ScenarioHarness, name: string) => {
    const storage = await runtime.harness
      .getWorker()
      .getDurableObjectStorage("PurchaseImportRunAgent", { name });
    await storage.exec(
      "CREATE TABLE cf_agents_state (id TEXT PRIMARY KEY, state TEXT)",
    );
    await storage.exec(
      "INSERT INTO cf_agents_state VALUES ('synthetic', 'Synthetic legacy transcript')",
    );
    // A deleted table counts as no rows.
    return async () => {
      const [table] = z
        .array(z.object({ rows: z.number() }))
        .parse(
          await storage.exec(
            "SELECT count(*) AS rows FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_state'",
          ),
        );
      if (!table?.rows) return 0;
      const [row] = z
        .array(z.object({ count: z.number() }))
        .parse(
          await storage.exec("SELECT count(*) AS count FROM cf_agents_state"),
        );
      return row?.count ?? 0;
    };
  };
  const legacyCoordinator = (runtime: ScenarioHarness, agentId: string) => {
    const request = (pathname: string) =>
      runtime.harness
        .getWorker("cubby-queue-producer")
        .fetch(new URL(pathname, "https://queue.test"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId }),
        });
    return {
      request,
      retire: async () => {
        const response = await request("/coordinator-retire");
        if (!response.ok) throw new Error(await response.text());
        return disposal.parse(await response.json());
      },
    };
  };

  // Regression: legacy account_sync Runs persisted a bare session UUID as the
  // coordinator name, which the import-Run identity parser refuses, so their
  // settled transcripts could never be retired.
  it("erases a settled legacy bare-session coordinator and acknowledges it cold", async () => {
    const runId = await agentRun();
    const agentId = await legacySession(runId);
    await settle(runId);
    const runtime = await sharedRuntime();
    const stored = await seedLegacyStorage(runtime, agentId);
    expect(await stored()).toBe(1);
    const coordinator = legacyCoordinator(runtime, agentId);
    const result = await retireSettledCoordinators(
      ctx.db,
      () => coordinator,
      new Date(),
    );
    observations.push({
      boundary: "legacy bare-session single-pass disposal",
      expected: 1,
      actual: result.retired,
    });
    expect(result).toEqual({ considered: 1, retired: 1 });
    expect(await stored()).toBe(0);
    expect(await readRun(runId)).toMatchObject({
      agentSessionId: agentId,
      retirementReason: "settled",
      retiredAt: expect.any(Date),
    });
    expect((await coordinator.request("/coordinator-fetch")).status).toBe(410);
    status = "passed";
  }, 90_000);

  it("keeps a legacy coordinator's storage unless exactly one settled Run stores its name", async () => {
    const runtime = await sharedRuntime();
    const refusedRetire = async (agentId: string) => {
      const stored = await seedLegacyStorage(runtime, agentId);
      const outcome = await legacyCoordinator(runtime, agentId)
        .retire()
        .then(() => "disposed", String);
      observations.push({
        boundary: "legacy refusal keeps storage",
        expected: 1,
        actual: await stored(),
      });
      expect(outcome).toMatch(
        /Only one settled Run storing this coordinator name/,
      );
      expect(await stored()).toBe(1);
    };
    const live = await agentRun();
    await refusedRetire(await legacySession(live));
    await refusedRetire(crypto.randomUUID());
    const shared = crypto.randomUUID();
    for (const twin of [await agentRun(), await agentRun()]) {
      await legacySession(twin, shared);
      await settle(twin);
    }
    await refusedRetire(shared);
    expect((await readRun(live))?.retiredAt).toBeNull();
    status = "passed";
  }, 90_000);
});
