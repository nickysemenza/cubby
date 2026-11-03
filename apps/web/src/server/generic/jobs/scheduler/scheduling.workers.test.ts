import { jobShortcode } from "@cubby/schemas/identifiers";
import {
  schedulerDeadline,
  schedulerSnapshot,
} from "@cubby/schemas/job-scheduler";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { z } from "zod";

const deadline = (offset: number) =>
  schedulerDeadline.parse({
    job: jobShortcode.parse("JOB-A3F2A3F2A3"),
    kind: "synthetic.work",
    at: new Date(Date.now() + offset).toISOString(),
    reason: "available",
  });

// PostgreSQL observation is the external seam. The actual DO storage, RPC,
// concurrency gates, queue producer and alarm handler run inside workerd.
it("delivers a deferred wake, disarms an exhausted schedule and retains history across eviction", async () => {
  const stub = env.JOB_SCHEDULER.getByName(crypto.randomUUID());
  let deadlines = [deadline(86_400_000)];
  await runInDurableObject(stub, (instance) => {
    Object.defineProperty(instance, "readDeadlines", {
      value: async () => deadlines,
    });
  });
  await stub.reconcile("synthetic.defer");
  expect((await stub.snapshot()).alarmAt).toBe(deadlines[0]!.at);
  deadlines = [];
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const settled = schedulerSnapshot.parse(await stub.snapshot());
  expect(settled.alarmAt).toBeNull();
  expect(settled.deliveryPendingSince).toBeNull();
  expect(settled.events.map((entry) => entry.event)).toContain("wake-accepted");
  await evictDurableObject(stub);
  expect((await stub.snapshot()).events).toEqual(settled.events);
});

it("keeps the earlier deadline notified while an older observation is in flight", async () => {
  const stub = env.JOB_SCHEDULER.getByName(crypto.randomUUID());
  const later = deadline(86_400_000);
  const earlier = deadline(43_200_000);
  let calls = 0;
  await runInDurableObject(stub, (instance) => {
    Object.defineProperty(instance, "readDeadlines", {
      value: async (): Promise<z.infer<typeof schedulerDeadline>[]> => {
        if (calls++ === 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return [later];
        }
        return [earlier, later];
      },
    });
  });
  const oldObservation = stub.reconcile("synthetic.old");
  const notification = stub.reconcile("synthetic.earlier");
  await Promise.all([oldObservation, notification]);
  expect((await stub.snapshot()).alarmAt).toBe(earlier.at);
});

it("allows failed daily enrollment to retry and fences late bootstrap completion", async () => {
  const stub = env.JOB_SCHEDULER.getByName(crypto.randomUUID());
  const date = "2026-11-03";
  const first = await stub.admitDaily(date);
  if (!first) throw new Error("Expected daily admission");
  expect(await stub.admitDaily(date)).toBeNull();
  await stub.finishDaily(date, first, "Synthetic database unavailable");
  const retry = await stub.admitDaily(date);
  if (!retry) throw new Error("Expected retry admission");
  await stub.finishDaily(date, retry, null);
  expect(await stub.admitDaily(date)).toBeNull();
  const old = await stub.claimBootstrap("synthetic-old");
  const current = await stub.claimBootstrap("synthetic-current");
  if (!old || !current) throw new Error("Expected bootstrap claims");
  await stub.finishBootstrap("synthetic-old", old, null);
  // A late old completion cannot delete the newer pending claim.
  expect(await stub.claimBootstrap("synthetic-current")).toBeNull();
  await stub.finishBootstrap("synthetic-current", current, null);
  await evictDurableObject(stub);
  expect(await stub.claimBootstrap("synthetic-current")).toBeNull();
});

it("bounds failed wake delivery and keeps the raw error visible after retries exhaust", async () => {
  const stub = env.JOB_SCHEDULER.getByName(crypto.randomUUID());
  await runInDurableObject(stub, (instance) => {
    Object.defineProperty(instance, "readDeadlines", { value: async () => [] });
    Object.defineProperty(instance, "sendWake", {
      value: async () => {
        throw new Error("Synthetic queue unavailable");
      },
    });
  });
  await stub.wake("synthetic.failure");
  for (let attempt = 1; attempt < 6; attempt++)
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  const failed = schedulerSnapshot.parse(await stub.snapshot());
  expect(failed.deliveryAttempts).toBe(6);
  expect(failed.deliveryPendingSince).not.toBeNull();
  expect(failed.alarmAt).toBeNull();
  expect(failed.events.at(-2)?.error).toContain("Synthetic queue unavailable");
  expect(await runDurableObjectAlarm(stub)).toBe(false);
});

it("bounds failed deadline observations and allows explicit recovery after the database returns", async () => {
  const stub = env.JOB_SCHEDULER.getByName(crypto.randomUUID());
  let unavailable = true;
  await runInDurableObject(stub, (instance) => {
    Object.defineProperty(instance, "readDeadlines", {
      value: async () => {
        if (unavailable) throw new Error("Synthetic database unavailable");
        return [];
      },
    });
  });
  expect(await stub.reconcile("synthetic.database-failure")).toContain(
    "Synthetic database unavailable",
  );
  for (let attempt = 1; attempt < 6; attempt++)
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  const failed = schedulerSnapshot.parse(await stub.snapshot());
  expect(failed.observationAttempts).toBe(6);
  expect(failed.observationError).toContain("Synthetic database unavailable");
  expect(failed.alarmAt).toBeNull();
  unavailable = false;
  await stub.reconcile("synthetic.database-returned");
  const recovered = schedulerSnapshot.parse(await stub.snapshot());
  expect(recovered.observationError).toBeNull();
  expect(recovered.alarmAt).toBeNull();
});
