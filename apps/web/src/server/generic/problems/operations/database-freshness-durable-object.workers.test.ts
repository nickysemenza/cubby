import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { describe, expect, it } from "vitest";

import { decideReadConsistency } from "~/server/db/read-consistency";

import baseline from "../repo/database-freshness-migrations/0000_baseline.sql?raw";
import journal from "../repo/database-freshness-migrations/meta/_journal.json";
import { DatabaseFreshnessStore } from "../repo/database-freshness-store";

describe("database freshness Durable Object", () => {
  it("adopts a populated legacy store and reinitializes after a later migration", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    const lastWriteAt = Date.now() + 100000;
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TABLE freshness");
      state.storage.sql.exec("DROP TABLE __drizzle_migrations");
      state.storage.sql.exec(
        "CREATE TABLE freshness (id INTEGER PRIMARY KEY CHECK (id = 1), last_write_at REAL NOT NULL)",
      );
      state.storage.sql.exec(
        "INSERT INTO freshness VALUES (1, ?)",
        lastWriteAt,
      );
      state.storage.sql.exec(
        "ALTER TABLE freshness ADD COLUMN write_sequence INTEGER NOT NULL DEFAULT 0",
      );
      state.storage.sql.exec(
        "ALTER TABLE freshness ADD COLUMN refresh_due_at REAL",
      );
      state.storage.sql.exec(
        "UPDATE freshness SET write_sequence = 7, refresh_due_at = 1234 WHERE id = 1",
      );
      state.storage.sql.exec("CREATE TABLE problem_counts (snapshot TEXT)");
    });
    await evictDurableObject(stub);
    // An immediate RPC must wait for constructor migration and retain the hint.
    expect((await stub.readFreshness()).lastWriteAt).toBe(lastWriteAt);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT write_sequence, refresh_due_at FROM freshness WHERE id = 1",
          )
          .one(),
      ).toEqual({ write_sequence: 7, refresh_due_at: 1234 });
      expect(
        state.storage.sql.exec("SELECT * FROM __drizzle_migrations").toArray(),
      ).toHaveLength(1);
      expect(
        state.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE name = 'problem_counts'")
          .toArray(),
      ).toEqual([]);
      const first = journal.entries[0];
      if (!first) throw new Error("Missing baseline journal entry");
      // The fixture upgrade changes the catalog without adding production
      // schema solely to exercise a later deployment and its next restart.
      await migrate(drizzle(state.storage), {
        journal: {
          ...journal,
          entries: [
            ...journal.entries,
            { ...first, idx: 1, when: first.when + 1, tag: "test_upgrade" },
          ],
        },
        migrations: {
          m0000: baseline,
          m0001: "ALTER TABLE freshness ADD COLUMN test_upgrade TEXT",
        },
      });
    });
    await evictDurableObject(stub);
    expect((await stub.recordWrite()).lastWriteAt).toBe(lastWriteAt);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT * FROM __drizzle_migrations").toArray(),
      ).toHaveLength(2);
    });
  });

  it("refuses an incompatible legacy schema before recording adoption or serving reads", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DROP TABLE freshness");
      state.storage.sql.exec("DROP TABLE __drizzle_migrations");
      state.storage.sql.exec(
        "CREATE TABLE freshness (id INTEGER PRIMARY KEY, last_write_at TEXT NOT NULL)",
      );
      state.storage.sql.exec(
        "INSERT INTO freshness VALUES (1, 'synthetic legacy hint')",
      );
      await expect(
        new DatabaseFreshnessStore(state.storage).migrate(),
      ).rejects.toThrow("Incompatible legacy database freshness schema");
      expect(
        state.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'",
          )
          .toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql.exec("SELECT last_write_at FROM freshness").one(),
      ).toEqual({ last_write_at: "synthetic legacy hint" });
    });
    await evictDurableObject(stub);
    const error = await stub.readFreshness().then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    expect(error).toContain("Incompatible legacy database freshness schema");
  });

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
});
