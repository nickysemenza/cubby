import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { pollUntil } from "@cubby/shared/retry";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestHarness } from "wrangler";
import { z } from "zod";

import { createE2EDatabase } from "../tests/e2e/e2e-database";
import { createE2EWorkerRuntime } from "../tests/e2e/e2e-worker-runtime";
import { scenarioControls } from "./purchase-agent-workerd-harness";
import { prepareTemplate } from "./test-database-lease";
import { withTestDb } from "./test-setup";
import {
  HOLD_WORKERD_HARNESS_TIMEOUT_MS,
  holdWorkerdHarness,
  type WorkerdProfile,
} from "./workerd-harness";
import { openWorkerdRuntime, withWorkerdRuntime } from "./workerd-runtime";

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
let releaseHarness: (() => void) | undefined;
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

  it("native-import delivers agent events to the continuation peer", async () => {
    const started = await start("native-import");
    try {
      await expectWriteLands(started);
      const event: PurchaseAgentEvent = {
        version: 1,
        type: "retry",
        runId: randomUUID(),
        eventId: `probe-${randomUUID()}`,
      };
      const env = await started.harness
        .getWorker<{ PURCHASE_AGENT_QUEUE: QueueSend }>()
        .getEnv();
      await env.PURCHASE_AGENT_QUEUE.send(event);
      const continuation = started.harness.getWorker(
        "native-import-continuation",
      );
      const delivered = await pollUntil(
        async () => {
          const { retryEvents } = z
            .object({ retryEvents: z.array(z.object({ eventId: z.string() })) })
            .parse(
              await (
                await continuation.fetch("https://continuation.test/")
              ).json(),
            );
          return retryEvents.find((retry) => retry.eventId === event.eventId);
        },
        { label: "continuation peer received the retry", timeoutMs: 20_000 },
      );
      expect(delivered.eventId).toBe(event.eventId);
    } finally {
      await started.close();
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
