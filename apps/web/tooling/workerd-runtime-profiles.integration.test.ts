import { randomUUID } from "node:crypto";

import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import {
  BACKGROUND_TASK_MESSAGE_VERSION,
  type BackgroundTaskMessage,
} from "@cubby/schemas/queue-messages";
import { pollUntil } from "@cubby/shared/retry";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { enqueueJob } from "~/server/generic/jobs/repo/jobs";

import type { TestHarness } from "./test-runtime";
import { withTestDb } from "./test-setup";
import { openWorkerdRuntime } from "./workerd-runtime";
import { expectWriteLands } from "./workerd-runtime-fixtures";

// Failure modes pinned at the real workerd boundary:
// - a real queue consumer silently stops running, so a lane "passes"
//   without exercising background work;
// - a runtime points the Worker at the wrong database.

// Background wakes prove execution through persisted Job state. The other
// consumers log invalid probes; peers that drop messages produce neither.
const queues = {
  "cubby-background": {
    producer: "BACKGROUND_QUEUE",
    consumerLog: null,
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
  send(
    body: { probe: string } | PurchaseAgentEvent | BackgroundTaskMessage,
  ): Promise<void>;
};

/**
 * Send through the Worker's producers and observe each real consumer.
 */
async function realConsumers(harness: TestHarness, expected: string[]) {
  const env = await harness.getWorker<Record<string, QueueSend>>().getEnv();
  const probe = await enqueueJob(ctx.db, {
    key: `runtime-probe:${randomUUID()}`,
    kind: "refresh.family",
    input: { family: "recipes" },
    availableAt: new Date(0),
  });
  harness.clearLogs();
  for (const [queue, { producer }] of Object.entries(queues))
    await env[producer]?.send(
      queue === "cubby-background"
        ? {
            version: BACKGROUND_TASK_MESSAGE_VERSION,
            queueType: "background",
            jobId: probe.id,
          }
        : { probe: randomUUID() },
    );
  const consumed = async () => {
    const [saved] = await getDb(ctx.db)
      .select({ state: job.state })
      .from(job)
      .where(eq(job.id, probe.id));
    return Object.entries(queues)
      .filter(([, { consumerLog }]) =>
        consumerLog === null
          ? saved?.state === "completed"
          : harness.getLogs().some((log) => log.message.includes(consumerLog)),
      )
      .map(([queue]) => queue);
  };
  await pollUntil(
    async () => {
      const observed = await consumed();
      return expected.every((queue) => observed.includes(queue))
        ? true
        : undefined;
    },
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
