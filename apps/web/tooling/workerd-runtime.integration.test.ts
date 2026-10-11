import { execFileSync } from "node:child_process";

import { pollUntil } from "@cubby/shared/retry";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createE2EDatabase } from "../tests/e2e/e2e-database";
import { createE2EWorkerRuntime } from "../tests/e2e/e2e-worker-runtime";
import { createE2EObjectStorage } from "./local-object-storage";
import { prepareTemplate } from "./test-database-lease";
import { withTestDb } from "./test-setup";
import { openWorkerdRuntime, withWorkerdRuntime } from "./workerd-runtime";
import { expectWriteLands } from "./workerd-runtime-fixtures";

// Failure modes pinned at the real workerd boundary: a start that fails
// partway leaks workerd, a database lease, or the process environment, and
// wedges the next start. Profile routing lives in
// workerd-runtime-profiles.integration.test.ts.

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

const ctx = withTestDb();
beforeAll(() => prepareTemplate("browser"), 120_000);

describe("workerd test runtime lifecycle", () => {
  // Caller-owned storage survives close (here) and a failed prepare (below);
  // its public URL can differ from the S3 endpoint.
  it("borrows storage without closing it", async () => {
    const storage = await createE2EObjectStorage();
    try {
      const { runtime } = await openWorkerdRuntime(
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
        async (started) => {
          const env = await started.harness
            .getWorker<{ R2_ENDPOINT: string; R2_PUBLIC_URL: string }>()
            .getEnv();
          expect(env.R2_ENDPOINT).toBe(storage.url);
          expect(env.R2_PUBLIC_URL).toBe("https://objects.example.test");
        },
      );
      await runtime.close();
      await runtime.close();
      await storage.bucket.put("survives-close", "synthetic object");
      expect(await (await storage.bucket.get("survives-close"))?.text()).toBe(
        "synthetic object",
      );
    } finally {
      await storage.close();
    }
  }, 120_000);

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
      error: /synthetic publish failure/u,
    },
    {
      step: "starting workerd",
      profile: "purchase-agent",
      publish: undefined,
      models: { agent: { main: "tooling/synthetic-missing-model-peer.ts" } },
      error: /synthetic-missing-model-peer/u,
    },
  ] as const)(
    "a failure while $step releases everything acquired before it",
    async ({ profile, publish, models, error }) => {
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
          async () => undefined,
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

  it("a failure while preparing the listening runtime releases everything acquired before it, but not borrowed storage", async () => {
    const storage = await createE2EObjectStorage();
    try {
      const before = environment();
      const workerdBefore = workerdChildren().length;
      let released = 0;
      await expect(
        openWorkerdRuntime(
          {
            profile: "offline",
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
            objectStorage: {
              borrowed: {
                endpoint: storage.url,
                publicUrl: "https://objects.example.test",
              },
            },
          },
          async (started) => {
            const env = await started.harness
              .getWorker<{ R2_ENDPOINT: string; R2_PUBLIC_URL: string }>()
              .getEnv();
            expect(env.R2_ENDPOINT).toBe(storage.url);
            expect(env.R2_PUBLIC_URL).toBe("https://objects.example.test");
            throw new Error("synthetic prepare failure");
          },
        ),
      ).rejects.toThrow(/synthetic prepare failure/u);
      expect(released).toBe(1);
      expect(environment()).toEqual(before);
      await pollUntil(
        () => (workerdChildren().length === workerdBefore ? true : undefined),
        { label: "workerd exited after the failed prepare", timeoutMs: 20_000 },
      );
      await storage.bucket.put("survives-failure", "synthetic object");
      expect(await (await storage.bucket.get("survives-failure"))?.text()).toBe(
        "synthetic object",
      );
    } finally {
      await storage.close();
    }
  }, 120_000);

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
