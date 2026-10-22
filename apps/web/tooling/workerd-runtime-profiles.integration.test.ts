import { randomUUID } from "node:crypto";

import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { pollUntil } from "@cubby/shared/retry";
import { describe, expect, it } from "vitest";

import type { TestHarness } from "./test-runtime";
import { withTestDb } from "./test-setup";
import { openWorkerdRuntime } from "./workerd-runtime";
import { expectWriteLands } from "./workerd-runtime-fixtures";

// Failure modes pinned at the real workerd boundary:
// - a real queue consumer silently stops running, so a lane "passes"
//   without exercising background work;
// - a runtime points the Worker at the wrong database.

// What each real consumer logs for a body it cannot parse. Peers that drop
// messages log nothing, and an unconsumed queue never delivers.
const queues = {
  "cubby-background": {
    producer: "BACKGROUND_QUEUE",
    consumerLog: "[background-tasks] unreadable message queue=cubby-background",
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
  return consumed();
}

const ctx = withTestDb();

// No probe touches object storage, so the runtime starts without it.
async function start() {
  const { runtime } = await openWorkerdRuntime(
    { profile: "coupled", database: { borrowed: ctx.databaseUrl } },
    async () => undefined,
  );
  return runtime;
}

describe("workerd test runtime profiles", () => {
  it("coupled runs every real consumer", async () => {
    const started = await start();
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
