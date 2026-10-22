import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { decideReadConsistency } from "~/server/db/read-consistency";

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

  // Regression: an older deploy's Problem counts refresh alarm can fire
  // before the constructor deletes it.
  it("drains an alarm left by an older deploy without changing freshness", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    const before = await stub.readFreshness();
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.setAlarm(Date.now() + 60_000),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.readFreshness()).toEqual(before);
  });
});
