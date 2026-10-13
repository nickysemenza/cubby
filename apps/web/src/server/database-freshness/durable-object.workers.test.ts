import { problemsCountSchema } from "@cubby/schemas/problems";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";

import { decideReadConsistency } from "../read-consistency";

describe("database freshness Durable Object", () => {
  it("cancels a queued ticket and bounds admission waits", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    using first = await stub.requestDatabaseWork({ priority: "background" });
    await first.ready();
    using second = await stub.requestDatabaseWork({ priority: "background" });
    await second.ready();
    const cancelled = await stub.requestDatabaseWork({
      priority: "background",
    });
    const settled = cancelled.ready();
    await cancelled.release();
    cancelled[Symbol.dispose]();
    await expect
      .poll(async () => (await stub.databaseWorkSnapshot()).queued)
      .toBe(0);
    expect(await settled).toMatchObject({ ok: false });
    using timed = await stub.requestDatabaseWork({
      priority: "background",
      waitTimeoutMs: 20,
    });
    expect(await timed.ready()).toMatchObject({
      ok: false,
      error: expect.stringContaining("Database admission wait exceeded"),
    });
    expect(await stub.databaseWorkSnapshot()).toMatchObject({
      active: 2,
      queued: 0,
    });
  });

  it("returns database capacity automatically when a Worker caller finishes", async () => {
    const name = crypto.randomUUID();
    const response = await SELF.fetch(`https://${name}/database/admission`);
    expect(response.status).toBe(200);
    await response.text();
    const stub = env.DB_FRESHNESS.getByName(name);
    await expect
      .poll(async () => (await stub.databaseWorkSnapshot()).active)
      .toBe(0);
  });

  // Queue delivery cannot bound database work launched by other coordinators.
  // Permits must span RPC callers and return on normal or automatic disposal.
  it("bounds background database work across callers while reserving navigation capacity", async () => {
    const name = crypto.randomUUID();
    const stub = env.DB_FRESHNESS.getByName(name);
    using first = await stub.requestDatabaseWork({ priority: "background" });
    await first.ready();
    using _second = await stub.requestDatabaseWork({ priority: "background" });
    await _second.ready();
    const waiting = stub.requestDatabaseWork({ priority: "background" });
    const other = env.DB_FRESHNESS.getByName(name);
    using _interactive = await other.requestDatabaseWork({
      priority: "interactive",
    });
    await _interactive.ready();
    expect(await stub.databaseWorkSnapshot()).toMatchObject({
      active: 3,
      backgroundActive: 2,
      queued: 1,
    });
    await first.release();
    using _third = await waiting;
    await _third.ready();
    expect(await stub.databaseWorkSnapshot()).toMatchObject({
      active: 3,
      backgroundActive: 2,
      queued: 0,
    });
    await first.release();
    expect((await stub.databaseWorkSnapshot()).active).toBe(3);
  });

  it("returns database capacity when the caller disposes its RPC permit", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    const permit = await stub.requestDatabaseWork({ priority: "background" });
    await permit.ready();
    permit[Symbol.dispose]();
    await expect
      .poll(async () => (await stub.databaseWorkSnapshot()).active)
      .toBe(0);
  });

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
});
