import { dashboardLocalCounts } from "@cubby/schemas/dashboard";
import { problemsCountSchema } from "@cubby/schemas/problems";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import superjson from "superjson";
import { describe, expect, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";

import { decideReadConsistency } from "../read-consistency";

describe("database freshness Durable Object", () => {
  it("warms up once, persists across eviction, and extends writes monotonically", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    const initial = await stub.readFreshness();
    expect(initial.strongUntil - initial.lastWriteAt).toBe(90000);
    await evictDurableObject(stub);
    expect(await stub.readFreshness()).toEqual(initial);
    const future = Date.now() + 100000;
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE freshness SET last_write_at = ? WHERE id = 1",
        future,
      );
    });
    expect((await stub.recordWrite()).lastWriteAt).toBe(future);
  });

  it("shares a write with a second user and expires without extending pure reads", async () => {
    const name = crypto.randomUUID();
    const first = env.DB_FRESHNESS.getByName(name);
    const second = env.DB_FRESHNESS.getByName(name);
    const write = await first.recordWrite();
    expect(await second.readFreshness()).toEqual(write);
    expect(
      decideReadConsistency({
        boundedStaleAvailable: true,
        freshness: await second.readFreshness(),
        now: write.lastWriteAt,
      }).consistency,
    ).toBe("strong");
    expect(
      decideReadConsistency({
        boundedStaleAvailable: true,
        freshness: await second.readFreshness(),
        now: write.strongUntil,
      }).consistency,
    ).toBe("bounded-stale");
    expect(await first.readFreshness()).toEqual(write);
  });

  it("batches writes behind the first alarm and retains a snapshot when refresh fails", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    const counts = mock(problemsCountSchema, { seed: 17 });

    await stub.recordWrite();
    const firstAlarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(firstAlarm).not.toBeNull();
    if (firstAlarm === null) throw new Error("write did not schedule an alarm");
    expect(firstAlarm - Date.now()).toBeGreaterThan(14 * 60_000);

    await stub.recordWrite();
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBe(firstAlarm);

    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO problem_counts (id, counts_json, computed_at, covered_sequence, quality) VALUES (1, ?, ?, 0, 'complete')",
        JSON.stringify(counts),
        Date.now(),
      );
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeGreaterThan(firstAlarm);
    });

    expect(await stub.getProblemCounts()).toEqual(counts);
  });

  it("persists warm read snapshots and rejects them after a write", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    const dashboard = dashboardLocalCounts.parse(
      Object.fromEntries(
        Object.keys(dashboardLocalCounts.shape).map((key) => [key, 1]),
      ),
    );
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO read_snapshots (kind, payload, computed_at, covered_sequence) VALUES (?, ?, ?, 0)",
        "dashboard",
        superjson.stringify(dashboard),
        Date.now(),
      );
    });

    expect(await stub.getDashboardCounts()).toEqual(dashboard);
    await evictDurableObject(stub);
    expect(await stub.getDashboardCounts()).toEqual(dashboard);

    await stub.recordWrite();
    expect(await stub.getDashboardCounts()).toBeNull();
  });
});
