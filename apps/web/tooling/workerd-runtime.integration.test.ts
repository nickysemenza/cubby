import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { retainedResearchObservation } from "@cubby/schemas/research";
import { eq } from "drizzle-orm";
import { pollUntil } from "@cubby/shared/retry";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestHarness } from "wrangler";

import { createE2EDatabase } from "../tests/e2e/e2e-database";
import { createE2EWorkerRuntime } from "../tests/e2e/e2e-worker-runtime";
import { createE2EObjectStorage } from "./local-object-storage";
import { captureE2ERunIdentity, writeE2ERunBundle } from "./e2e-run-bundle";
import { from } from "./purchase-agent-script";
import { scenarioControls } from "./purchase-agent-workerd-harness";
import { prepareTemplate } from "./test-database-lease";
import { withTestDb } from "./test-setup";
import {
  HOLD_WORKERD_HARNESS_TIMEOUT_MS,
  holdWorkerdHarness,
  type WorkerdProfile,
} from "./workerd-harness";
import { openWorkerdRuntime, withWorkerdRuntime } from "./workerd-runtime";
import {
  run as runTable,
  runEvidence,
  runOperation,
  runTarget,
} from "../src/server/db/schema";
import { getDb } from "../src/server/repo/database-helpers";
import { insertWithShortcode } from "../src/server/repo/shortcode-utils";
import {
  createProductFixture,
  makeProductInput,
} from "../src/server/repo/repo.fixtures";
import { browserCommandRecord } from "../src/server/purchase-import/browser-results";
import { completedCapture } from "../src/server/purchase-import/browser.fixtures";
import {
  authorizePurchaseAgent,
  authorizeSyntheticRunInference,
} from "../src/server/purchase-import/purchase-agent-workerd.fixtures";
import { startProductResearch } from "../src/server/purchase-import/product-research-run";
import { startAccountSync } from "../src/server/purchase-import/account-sync";
import { resolveOrThrow } from "../src/server/repo/shortcode-resolver";

// Failure modes pinned at the real workerd boundary:
// - a profile silently stops running a real queue consumer (or starts one it
//   should not), so a lane "passes" without exercising background work;
// - a runtime points the Worker at the wrong database;
// - a start that fails partway leaks workerd, a database lease, or the
//   process environment, and wedges the next start.

const databaseEnvironmentKeys = [
  "E2E_DATABASE_URL",
  "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
  "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED",
] as const;
const environment = () =>
  Object.fromEntries(
    databaseEnvironmentKeys.map((key) => [key, process.env[key]]),
  );

/** workerd processes this test process spawned (the Worker and object storage). */
function workerdChildren(): number[] {
  return execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], {
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter(
      ([, ppid, command]) =>
        Number(ppid) === process.pid && (command ?? "").endsWith("workerd"),
    )
    .map(([pid]) => Number(pid));
}

async function signUp(origin: string) {
  const email = `runtime-${randomUUID()}@example.test`;
  const response = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: origin },
    body: JSON.stringify({
      email,
      password: "synthetic-runtime-password",
      name: "Synthetic Runtime Member",
    }),
  });
  if (!response.ok)
    throw new Error(`Sign-up ${response.status}: ${await response.text()}`);
  return email;
}

async function hasUser(databaseUrl: string, email: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const { rows } = await pool.query('SELECT 1 FROM "user" WHERE email = $1', [
      email,
    ]);
    return rows.length === 1;
  } finally {
    await pool.end();
  }
}

// What each real consumer logs for a body it cannot parse. Peers that drop
// messages log nothing, and an unconsumed queue never delivers.
const queues = {
  "cubby-background": {
    producer: "BACKGROUND_QUEUE",
    consumerLog: "[background-tasks] unreadable message",
  },
  "cubby-telemetry": {
    producer: "TELEMETRY_QUEUE",
    consumerLog: "[telemetry] dropped invalid queue message",
  },
  "cubby-purchase-agent": {
    producer: "PURCHASE_AGENT_QUEUE",
    consumerLog: "[purchase-agent] queue event was not dispatched",
  },
} as const;
/** A queue producer binding, reached from Node through `getEnv()`. */
type QueueSend = {
  send(body: { probe: string } | PurchaseAgentEvent): Promise<void>;
};

/**
 * Send an unreadable probe on every production queue through the Worker's own
 * producers and return the queues whose real consumer handled it.
 */
async function realConsumers(harness: TestHarness, expected: string[]) {
  const env = await harness.getWorker<Record<string, QueueSend>>().getEnv();
  harness.clearLogs();
  for (const { producer } of Object.values(queues))
    await env[producer]?.send({ probe: randomUUID() });
  const consumed = () =>
    Object.entries(queues)
      .filter(([, { consumerLog }]) =>
        harness.getLogs().some((log) => log.message.includes(consumerLog)),
      )
      .map(([queue]) => queue);
  await pollUntil(
    () =>
      expected.every((queue) => consumed().includes(queue)) ? true : undefined,
    { label: `real consumers ${expected.join(", ")}`, timeoutMs: 20_000 },
  );
  // A consumer that should not exist gets the same grace to show up.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  return consumed();
}

const ctx = withTestDb();
let releaseHarness: (() => Promise<void>) | undefined;
beforeAll(async () => {
  releaseHarness = await holdWorkerdHarness();
  await prepareTemplate("browser");
}, HOLD_WORKERD_HARNESS_TIMEOUT_MS);
afterAll(() => releaseHarness?.());

async function start(profile: WorkerdProfile) {
  const { runtime } = await openWorkerdRuntime(
    {
      profile,
      database: { borrowed: ctx.databaseUrl },
      objectStorage: {},
    },
    async () => undefined,
  );
  return runtime;
}

/** Authenticate, write through the Worker, and find the write in this database. */
async function expectWriteLands(started: {
  origin: string;
  databaseUrl: string;
}) {
  const email = await signUp(started.origin);
  expect(await hasUser(started.databaseUrl, email)).toBe(true);
}

describe("workerd test runtime profiles", () => {
  it("offline drops background work and runs no consumer", async () => {
    const started = await start("offline");
    try {
      await expectWriteLands(started);
      expect(await realConsumers(started.harness, [])).toEqual([]);
    } finally {
      await started.close();
    }
  }, 120_000);

  it("gmail runs the real background consumer against the local Google provider", async () => {
    const started = await start("gmail");
    try {
      await expectWriteLands(started);
      const env = await started.harness
        .getWorker<{ E2E_GOOGLE_PROVIDER_URL: string }>()
        .getEnv();
      expect(env.E2E_GOOGLE_PROVIDER_URL).toBe(started.googleProvider?.url);
      expect(
        await realConsumers(started.harness, ["cubby-background"]),
      ).toEqual(["cubby-background"]);
    } finally {
      await started.close();
    }
  }, 120_000);

  it("native-import submits current research events and acknowledges only retained observations", async () => {
    // A queue recorder can acknowledge delivery without executing work or
    // submitting the browser result to pi. Only external capture is simulated.
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const identity = captureE2ERunIdentity(repoRoot);
    const artifactDir = path.join(
      repoRoot,
      "artifacts/native-research-profile",
      new Date().toISOString().replaceAll(":", "-"),
    );
    mkdirSync(artifactDir, { recursive: true });
    const evidenceFile = path.join(artifactDir, "boundary.json");
    let started: Awaited<ReturnType<typeof start>> | undefined;
    let controls: ReturnType<typeof scenarioControls> | undefined;
    let failure: string | null = null;
    let runId: string | undefined;
    let durableObservation = false;
    try {
      started = await start("native-import");
      controls = scenarioControls(started.harness);
      const sourceURL = "https://native-profile.example.test/black-shirt";
      await controls.configure({
        steps: [
          { call: "native-next", tool: "work_next", args: {} },
          {
            call: "native-observe",
            tool: "work_observe",
            args: {
              workRef: from("native-next", "work.workRef"),
              action: { kind: "navigate", url: sourceURL },
            },
          },
          { check: "native-observe", includes: "waiting" },
          { gate: "native-observation-durable" },
        ],
      });
      const party = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic native profile member",
        kind: "member",
        userId: ctx.actor.userId,
      });
      const vendor = await insertWithShortcode(ctx.db, "vendor", {
        name: "Synthetic native profile shop",
        website: "https://native-profile.example.test",
        browserDomains: ["native-profile.example.test"],
      });
      const account = await insertWithShortcode(ctx.db, "vendorAccount", {
        label: "Synthetic native profile browser",
        vendorId: vendor.id,
        ledgerPartyId: party.id,
        browser: "chrome",
        browserSyncEnabled: true,
        status: "active",
      });
      const item = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic black shirt size M" }),
        ctx.actor,
      );
      await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
      await controls.connectBrowser({
        vendorAccountId: account.id,
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        outcomes: {
          [sourceURL]: await completedCapture(sourceURL, {
            title: "Synthetic black shirt",
            text: "Exact color Black · Size M · GTIN 00012345678905",
          }),
        },
      });
      const env = await started.harness
        .getWorker<{ PURCHASE_AGENT_QUEUE: QueueSend }>()
        .getEnv();
      const initialEvents: PurchaseAgentEvent[] = [];
      const admissions = await startProductResearch(
        ctx.db,
        {
          ledgerPartyId: party.id,
          userId: ctx.actor.userId,
          productIds: [item.entityId],
          cause: "member_request",
          preferredBrowserAccountId: account.id,
        },
        { send: async (event) => void initialEvents.push(event) },
      );
      const admitted = admissions[0];
      if (!admitted) throw new Error("Synthetic research admission missing.");
      runId = admitted.runId;
      await authorizeSyntheticRunInference(
        ctx,
        admitted.runId,
        "synthetic-native-product-mailbox",
      );
      for (const event of initialEvents)
        await env.PURCHASE_AGENT_QUEUE.send(event);
      await pollUntil(
        async () =>
          (await controls!.emitted()).includes(
            "gate:native-observation-durable",
          )
            ? true
            : undefined,
        {
          label: "native research queue and durable observation",
          timeoutMs: 20_000,
        },
      );
      const database = getDb(ctx.db);
      const targets = await database
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, admitted.runId));
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        entityKind: "product",
        entityId: item.entityId,
      });
      const operations = await pollUntil(
        async () => {
          const rows = await database
            .select()
            .from(runOperation)
            .where(eq(runOperation.runId, admitted.runId));
          return rows.some((operation) => {
            const parsed = browserCommandRecord.safeParse(operation.result);
            return parsed.success && parsed.data.observationDelivered;
          })
            ? rows
            : undefined;
        },
        {
          label: "SDK submission acknowledged its retained observation",
          timeoutMs: 10_000,
        },
      );
      const commands = operations.flatMap((operation) => {
        const parsed = browserCommandRecord.safeParse(operation.result);
        return parsed.success ? [parsed.data] : [];
      });
      expect(commands).toHaveLength(1);
      const record = commands[0];
      if (!record?.page)
        throw new Error("Native retained observation missing.");
      expect(record).toMatchObject({
        observationDelivered: true,
        brokerAccountId: account.id,
        workRef: targets[0]?.id,
        command: { runID: admitted.runId },
      });
      const retained = retainedResearchObservation.parse(record.page.research);
      expect(retained.observation.readableText).toContain("Size M");
      expect(retained.observation.servedURL).toBe(sourceURL);
      const originals = await database
        .select()
        .from(runEvidence)
        .where(eq(runEvidence.runId, admitted.runId));
      expect(
        originals.find((original) => original.id === retained.evidenceId),
      ).toMatchObject({
        targetId: targets[0]?.id,
        sourceMetadata: { researchUploadState: "uploaded" },
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(await controls.violations()).toEqual([]);
      durableObservation = true;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      try {
        writeFileSync(
          evidenceFile,
          JSON.stringify(
            {
              synthetic: true,
              runAdmitted: Boolean(runId),
              durableObservation,
              emitted: controls ? await controls.emitted().catch(() => []) : [],
              failure,
              limits: [
                "External capture simulated; actual Mac acceptance belongs to mac-import-e2e",
              ],
            },
            null,
            2,
          ) + "\n",
        );
      } finally {
        await started?.close();
        writeE2ERunBundle({
          repoRoot,
          outputDir: artifactDir,
          evidence: [evidenceFile],
          kind: "browser",
          status: failure ? "failed" : "passed",
          command: [
            "pnpm",
            "--dir",
            repoRoot,
            "test:postgres",
            "tooling/workerd-runtime.integration.test.ts",
            "-t",
            "native-import submits current research events and acknowledges only retained observations",
          ],
          started: identity,
          profile: "native-import",
          scenario: "Native profile real research coordinator and SDK receipt",
        });
      }
    }
  }, 120_000);

  it("native Sync resumes authenticated research on the original Run and acknowledges a fresh read", async () => {
    // Retry delivery alone cannot recover auth: the member-authorized starter
    // must resume the same task before the coordinator reconciles a read.
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const identity = captureE2ERunIdentity(repoRoot);
    const artifactDir = path.join(
      repoRoot,
      "artifacts/native-auth-resume",
      new Date().toISOString().replaceAll(":", "-"),
    );
    mkdirSync(artifactDir, { recursive: true });
    const evidenceFile = path.join(artifactDir, "boundary.json");
    let started: Awaited<ReturnType<typeof start>> | undefined;
    let failure: string | null = null;
    let paused = false;
    let recovered = false;
    try {
      started = await start("native-import");
      const controls = scenarioControls(started.harness);
      const sourceURL = "https://native-auth.example.test/order-history";
      await controls.configure({
        steps: [
          { call: "auth-next", tool: "work_next", args: {} },
          {
            call: "auth-navigate",
            tool: "work_observe",
            args: {
              workRef: from("auth-next", "work.workRef"),
              action: { kind: "navigate", url: sourceURL },
            },
          },
          { gate: "authenticated-research" },
        ],
      });
      const party = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic native auth member",
        kind: "member",
        userId: ctx.actor.userId,
      });
      const vendor = await insertWithShortcode(ctx.db, "vendor", {
        name: "Synthetic native auth shop",
        website: "https://native-auth.example.test",
        browserDomains: ["native-auth.example.test"],
      });
      const account = await insertWithShortcode(ctx.db, "vendorAccount", {
        label: "Synthetic native auth account",
        vendorId: vendor.id,
        ledgerPartyId: party.id,
        browser: "chrome",
        browserSyncEnabled: true,
        status: "active",
      });
      await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
      const browser = {
        vendorAccountId: account.id,
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
      };
      await controls.connectBrowser({
        ...browser,
        outcomes: {
          [sourceURL]: await completedCapture(sourceURL, {
            title: "Sign in to Synthetic shop",
            text: "Sign in",
            signIn: true,
          }),
        },
      });
      const env = await started.harness
        .getWorker<{ PURCHASE_AGENT_QUEUE: QueueSend }>()
        .getEnv();
      const initialEvents: PurchaseAgentEvent[] = [];
      const first = await startAccountSync(
        ctx.db,
        party.id,
        { vendorAccountId: account.shortcode },
        { send: async (event) => void initialEvents.push(event) },
      );
      const runId = await resolveOrThrow(ctx.db, "run", first.runId);
      await authorizeSyntheticRunInference(
        ctx,
        runId,
        "synthetic-native-sync-mailbox",
      );
      for (const event of initialEvents)
        await env.PURCHASE_AGENT_QUEUE.send(event);
      const database = getDb(ctx.db);
      const scope = async () =>
        (
          await database.select().from(runTable).where(eq(runTable.id, runId))
        )[0];
      await pollUntil(
        async () =>
          (await scope())?.status === "paused_auth" ? true : undefined,
        {
          label: "Native research sign-in pause",
          timeoutMs: 20_000,
        },
      );
      paused = true;
      const targets = await database
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, runId));
      expect(targets).toHaveLength(1);
      await controls.connectBrowser({
        ...browser,
        outcomes: {
          [sourceURL]: await completedCapture(sourceURL, {
            title: "Your orders",
            text: "Synthetic order 001 · Black shirt · Size M",
          }),
        },
      });
      const resumed = await startAccountSync(
        ctx.db,
        party.id,
        { vendorAccountId: account.shortcode },
        env.PURCHASE_AGENT_QUEUE,
      );
      expect(resumed).toEqual({ runId: first.runId, resumed: true });
      const read = await pollUntil(
        async () => {
          const operations = await database
            .select()
            .from(runOperation)
            .where(eq(runOperation.runId, runId));
          return operations.flatMap((operation) => {
            const record = browserCommandRecord.safeParse(operation.result);
            return record.success &&
              record.data.command.operation.type === "read" &&
              record.data.observationDelivered &&
              record.data.page &&
              !record.data.page.research.observation.authenticationRequired
              ? [record.data]
              : [];
          })[0];
        },
        {
          label: "Native Sync authenticated read durably acknowledged",
          timeoutMs: 20_000,
        },
      );
      expect((await scope())?.status).toBe("running");
      expect(read).toMatchObject({
        workRef: targets[0]?.id,
        brokerAccountId: account.id,
        command: { runID: runId, operation: { type: "read" } },
      });
      expect(read.page?.research.observation.readableText).toContain("Size M");
      expect(
        await database
          .select()
          .from(runTarget)
          .where(eq(runTarget.runId, runId)),
      ).toEqual(targets);
      expect(await controls.violations()).toEqual([]);
      recovered = true;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      try {
        writeFileSync(
          evidenceFile,
          JSON.stringify(
            {
              synthetic: true,
              paused,
              recovered,
              failure,
              limits: [
                "Authentication and capture are external peers; actual Mac uses native Settings sign-in and Sync",
              ],
            },
            null,
            2,
          ) + "\n",
        );
      } finally {
        await started?.close();
        writeE2ERunBundle({
          repoRoot,
          outputDir: artifactDir,
          evidence: [evidenceFile],
          kind: "browser",
          status: failure ? "failed" : "passed",
          command: [
            "pnpm",
            "--dir",
            repoRoot,
            "test:postgres",
            "tooling/workerd-runtime.integration.test.ts",
            "-t",
            "native Sync resumes authenticated research on the original Run and acknowledges a fresh read",
          ],
          started: identity,
          profile: "native-import",
          scenario:
            "Member-authorized native Sync auth recovery on original Run",
        });
      }
    }
  }, 120_000);

  it("purchase-agent runs the real agent and telemetry consumers with scripted peers", async () => {
    const started = await start("purchase-agent");
    try {
      await expectWriteLands(started);
      const controls = scenarioControls(started.harness);
      await controls.configure({ steps: [] });
      expect(await controls.violations()).toEqual([]);
      expect(
        await realConsumers(started.harness, [
          "cubby-telemetry",
          "cubby-purchase-agent",
        ]),
      ).toEqual(["cubby-telemetry", "cubby-purchase-agent"]);
    } finally {
      await started.close();
    }
  }, 120_000);

  it("coupled runs every real consumer", async () => {
    const started = await start("coupled");
    try {
      await expectWriteLands(started);
      expect(
        await realConsumers(started.harness, [
          "cubby-background",
          "cubby-telemetry",
          "cubby-purchase-agent",
        ]),
      ).toEqual([
        "cubby-background",
        "cubby-telemetry",
        "cubby-purchase-agent",
      ]);
    } finally {
      await started.close();
    }
  }, 120_000);
});

describe("workerd test runtime lifecycle", () => {
  // Caller-owned storage must survive both normal close and failed prepare;
  // its public URL can differ from the S3 endpoint.
  it.each([false, true])(
    "borrows storage without closing it (prepare fails: %s)",
    async (prepareFails) => {
      const storage = await createE2EObjectStorage();
      try {
        const opened = openWorkerdRuntime(
          {
            profile: "offline",
            database: { borrowed: ctx.databaseUrl },
            objectStorage: {
              borrowed: {
                endpoint: storage.url,
                publicUrl: "https://objects.example.test",
              },
            },
          },
          async (runtime) => {
            const env = await runtime.harness
              .getWorker<{ R2_ENDPOINT: string; R2_PUBLIC_URL: string }>()
              .getEnv();
            expect(env.R2_ENDPOINT).toBe(storage.url);
            expect(env.R2_PUBLIC_URL).toBe("https://objects.example.test");
            if (prepareFails)
              throw new Error("synthetic borrowed prepare failure");
          },
        );
        const outcome = await opened.then(
          async ({ runtime }) => {
            await runtime.close();
            await runtime.close();
            return "closed";
          },
          (error) => (error instanceof Error ? error.message : String(error)),
        );
        expect(outcome).toBe(
          prepareFails ? "synthetic borrowed prepare failure" : "closed",
        );
        await storage.bucket.put("survives-close", "synthetic object");
        expect(await (await storage.bucket.get("survives-close"))?.text()).toBe(
          "synthetic object",
        );
      } finally {
        await storage.close();
      }
    },
    120_000,
  );

  it("a start that fails partway leaks nothing and the next start works", async () => {
    const before = environment();
    const workerdBefore = workerdChildren();
    // Signing in is the last acquisition step: the database lease, object
    // storage and workerd are all up when it fails.
    vi.stubEnv("E2E_TEST_USER_EMAIL", "");
    try {
      await expect(
        createE2EWorkerRuntime({ authenticated: true, parallelIndex: 0 }),
      ).rejects.toThrow(/E2E_TEST_USER_EMAIL/u);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(environment()).toEqual(before);
    await pollUntil(
      () =>
        workerdChildren().length === workerdBefore.length ? true : undefined,
      { label: "workerd exited after the failed start", timeoutMs: 20_000 },
    );

    const runtime = await createE2EWorkerRuntime({
      authenticated: false,
      parallelIndex: 0,
    });
    try {
      await expectWriteLands({
        origin: runtime.baseURL,
        databaseUrl: runtime.databaseUrl,
      });
    } finally {
      await runtime.close();
    }
    expect(environment()).toEqual(before);
    await pollUntil(
      () =>
        workerdChildren().length === workerdBefore.length ? true : undefined,
      { label: "workerd exited after close", timeoutMs: 20_000 },
    );
  }, 180_000);

  it.each([
    {
      step: "publishing object storage",
      profile: "offline",
      publish: () => Promise.reject(new Error("synthetic publish failure")),
      models: undefined,
      prepareFails: false,
      error: /synthetic publish failure/u,
    },
    {
      step: "starting workerd",
      profile: "purchase-agent",
      publish: undefined,
      models: { agent: { main: "tooling/synthetic-missing-model-peer.ts" } },
      prepareFails: false,
      error: /synthetic-missing-model-peer/u,
    },
    {
      step: "preparing the listening runtime",
      profile: "offline",
      publish: undefined,
      models: undefined,
      prepareFails: true,
      error: /synthetic prepare failure/u,
    },
  ] as const)(
    "a failure while $step releases everything acquired before it",
    async ({ profile, publish, models, prepareFails, error }) => {
      const before = environment();
      const workerdBefore = workerdChildren().length;
      let released = 0;
      await expect(
        openWorkerdRuntime(
          {
            profile,
            database: {
              lease: async () => {
                const lease = await createE2EDatabase();
                return {
                  ...lease,
                  close: () => {
                    released += 1;
                    return lease.close();
                  },
                };
              },
            },
            objectStorage: { publish },
            models,
          },
          async () => {
            if (prepareFails) throw new Error("synthetic prepare failure");
          },
        ),
      ).rejects.toThrow(error);
      expect(released).toBe(1);
      expect(environment()).toEqual(before);
      await pollUntil(
        () => (workerdChildren().length === workerdBefore ? true : undefined),
        { label: "workerd exited after the failed start", timeoutMs: 20_000 },
      );
    },
    120_000,
  );

  // The live evals run billed cases inside `withWorkerdRuntime`; a case or
  // report failure after startup must still stop workerd before Vitest
  // releases the database it points at.
  it.each([
    {
      cleanupFails: false,
      expected: { message: "synthetic case failure" },
    },
    {
      cleanupFails: true,
      // The case failure stays first; the cleanup failure follows it.
      expected: {
        message: "Workerd runtime run failed and its cleanup failed",
        errors: [
          expect.objectContaining({ message: "synthetic case failure" }),
          expect.any(Error),
        ],
      },
    },
  ])(
    "a failure after startup still closes the runtime (cleanup fails: $cleanupFails)",
    async ({ cleanupFails, expected }) => {
      const before = environment();
      const workerdBefore = workerdChildren().length;
      let released = 0;
      let reached = false;
      await expect(
        withWorkerdRuntime(
          {
            profile: "purchase-agent",
            database: {
              lease: async () => {
                const lease = await createE2EDatabase();
                return {
                  ...lease,
                  close: async () => {
                    released += 1;
                    await lease.close();
                    if (cleanupFails)
                      throw new Error("synthetic release failure");
                  },
                };
              },
            },
          },
          async ({ origin, databaseUrl }) => {
            await expectWriteLands({ origin, databaseUrl });
            reached = true;
            throw new Error("synthetic case failure");
          },
        ),
      ).rejects.toMatchObject(expected);
      expect(reached).toBe(true);
      expect(released).toBe(1);
      expect(environment()).toEqual(before);
      await pollUntil(
        () => (workerdChildren().length === workerdBefore ? true : undefined),
        { label: "workerd exited after the failed run", timeoutMs: 20_000 },
      );
    },
    120_000,
  );
});
