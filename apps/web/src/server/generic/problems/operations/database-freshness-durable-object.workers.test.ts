import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { decideReadConsistency } from "~/server/db/read-consistency";

describe("database freshness Durable Object", () => {
  it("publishes committed-change hints over a hibernating socket after enabling strong reads", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    const response = await stub.fetch(
      new Request("https://example.test/socket", {
        headers: { Upgrade: "websocket" },
      }),
    );
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing subscription socket");
    socket.accept();
    const received = new Promise<string>((resolve) =>
      socket.addEventListener(
        "message",
        (event: MessageEvent) => resolve(String(event.data)),
        { once: true },
      ),
    );
    await evictDurableObject(stub);
    await stub.publishChanges(["task"]);
    expect(JSON.parse(await received)).toEqual({
      type: "invalidate",
      categories: ["task"],
    });
    const freshness = await stub.readFreshness();
    expect(
      decideReadConsistency({
        boundedStaleAvailable: true,
        freshness,
        now: Date.now(),
      }).consistency,
    ).toBe("strong");
    socket.close();
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
