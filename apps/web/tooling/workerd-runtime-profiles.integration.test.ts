import { randomUUID } from "node:crypto";

import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { pollUntil } from "@cubby/shared/retry";
import { describe, expect, it } from "vitest";
import type { TestHarness } from "wrangler";

import { scenarioControls } from "./purchase-agent-workerd-harness";
import { withTestDb } from "./test-setup";
import type { WorkerdProfile } from "./workerd-harness";
import { openWorkerdRuntime } from "./workerd-runtime";
import { expectWriteLands } from "./workerd-runtime-fixtures";

// Failure modes pinned at the real workerd boundary:
// - a profile silently stops running a real queue consumer (or starts one it
//   should not), so a lane "passes" without exercising background work;
// - a runtime points the Worker at the wrong database.
// Start and close lifecycle lives in workerd-runtime.integration.test.ts.

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

// No probe touches object storage, so the runtime starts without it.
async function start(profile: WorkerdProfile) {
  const { runtime } = await openWorkerdRuntime(
    { profile, database: { borrowed: ctx.databaseUrl } },
    async () => undefined,
  );
  return runtime;
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
