import { setTimeout as delay } from "node:timers/promises";
import { pollUntil } from "@cubby/shared/retry";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { getDb } from "~/server/repo/database-helpers";

import {
  createPostgresPool,
  terminateOtherPostgresConnections,
} from "./postgres-pool";
import { withTestDb } from "./test-setup";

// Pool.end can resolve before a removed client's socket closes. Recreating its
// database then sends 57P01 to that client after its owner believes it is gone.
describe("PostgreSQL pool shutdown", () => {
  const ctx = withTestDb();

  it("waits for terminated idle clients before the next test can acquire them", async () => {
    const pool = createPostgresPool({ connectionString: ctx.databaseUrl });
    pool.on("error", () => {});
    const observerUrl = new URL(ctx.databaseUrl);
    observerUrl.pathname = "/postgres";
    const observer = createPostgresPool({ connectionString: observerUrl.href });
    const idle = await pool.connect();
    const { rows } = await idle.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const pid = rows[0]?.pid;
    expect(pid).toBeDefined();
    const control = await pool.connect();
    idle.connection.stream.pause();
    idle.release();
    control.release();
    let finished = false;
    const reset = terminateOtherPostgresConnections(pool);
    void reset.then(() => {
      finished = true;
    });
    try {
      await pollUntil(
        async () => {
          const result = await observer.query(
            "SELECT 1 FROM pg_stat_activity WHERE pid = $1",
            [pid],
          );
          return result.rows.length === 0 ? true : undefined;
        },
        { label: "terminated idle backend", timeoutMs: 1000 },
      );
      expect(finished).toBe(false);
      idle.connection.stream.resume();
      await reset;
      await expect(pool.query("SELECT 1")).resolves.toMatchObject({
        rowCount: 1,
      });
    } finally {
      idle.connection.stream.resume();
      await reset;
      await Promise.all([pool.end(), observer.end()]);
    }
  });

  it("protects selected sessions from another owned pool until their sockets close", async () => {
    const controlPool = createPostgresPool({
      connectionString: ctx.databaseUrl,
    });
    const targetPool = createPostgresPool({
      connectionString: ctx.databaseUrl,
    });
    const observerUrl = new URL(ctx.databaseUrl);
    observerUrl.pathname = "/postgres";
    const observer = createPostgresPool({ connectionString: observerUrl.href });
    const target = await targetPool.connect();
    const errors: Error[] = [];
    target.on("error", (error) => errors.push(error));
    const { rows } = await target.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const closed = new Promise<void>((resolve) => target.once("end", resolve));
    target.connection.stream.pause();
    const reset = terminateOtherPostgresConnections(controlPool);
    try {
      await pollUntil(
        async () => {
          const result = await observer.query(
            "SELECT 1 FROM pg_stat_activity WHERE pid = $1",
            [rows[0]?.pid],
          );
          return result.rows.length === 0 ? true : undefined;
        },
        { label: "selected owned-pool backend terminated", timeoutMs: 1000 },
      );
      expect(
        await Promise.race([
          reset.then(() => "returned"),
          delay(25).then(() => "waiting"),
        ]),
      ).toBe("waiting");
      target.connection.stream.resume();
      await reset;
      await closed;
      expect(errors).toContainEqual(expect.objectContaining({ code: "57P01" }));
      await expect(targetPool.query("SELECT 1")).resolves.toMatchObject({
        rowCount: 1,
      });
    } finally {
      target.connection.stream.resume();
      await reset;
      await closed;
      target.release();
      await Promise.all([controlPool.end(), targetPool.end(), observer.end()]);
    }
  });

  it("refuses unowned sessions before terminating any selected session", async () => {
    const pool = createPostgresPool({ connectionString: ctx.databaseUrl });
    const owned = await pool.connect();
    const foreign = new Client({ connectionString: ctx.databaseUrl });
    const errors: Error[] = [];
    foreign.on("error", (error) => errors.push(error));
    await foreign.connect();
    try {
      await expect(terminateOtherPostgresConnections(pool)).rejects.toThrow(
        /unowned.*Close.*runtime/su,
      );
      await expect(owned.query("SELECT 1")).resolves.toMatchObject({
        rowCount: 1,
      });
      await expect(foreign.query("SELECT 1")).resolves.toMatchObject({
        rowCount: 1,
      });
      expect(errors).toEqual([]);
    } finally {
      await foreign.end();
      owned.release();
      await pool.end();
    }
  });

  it("tracks a connection opened after reset selection but before database-wide termination", async () => {
    const pool = createPostgresPool({ connectionString: ctx.databaseUrl });
    const observerUrl = new URL(ctx.databaseUrl);
    observerUrl.pathname = "/postgres";
    const observer = createPostgresPool({ connectionString: observerUrl.href });
    const held = await pool.connect();
    const control = await pool.connect();
    control.connection.stream.cork();
    control.release();
    const reset = terminateOtherPostgresConnections(pool);
    let late: typeof held | undefined;
    let closed: Promise<void> | undefined;
    try {
      await pollUntil(
        () => (control.connection.stream.writableLength > 0 ? true : undefined),
        {
          label: "reset query buffered after selecting existing clients",
          timeoutMs: 1000,
        },
      );
      late = await pool.connect();
      const { rows } = await late.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      closed = new Promise<void>((resolve) => late!.once("end", resolve));
      late.connection.stream.pause();
      control.connection.stream.uncork();
      await pollUntil(
        async () => {
          const result = await observer.query(
            "SELECT 1 FROM pg_stat_activity WHERE pid = $1",
            [rows[0]?.pid],
          );
          return result.rows.length === 0 ? true : undefined;
        },
        {
          label: "late connection was included in the reset SQL",
          timeoutMs: 1000,
        },
      );
      expect(
        await Promise.race([
          reset.then(() => "returned"),
          delay(25).then(() => "waiting"),
        ]),
      ).toBe("waiting");
      late.connection.stream.resume();
      await reset;
      await closed;
      await expect(pool.query("SELECT 1")).resolves.toMatchObject({
        rowCount: 1,
      });
    } finally {
      control.connection.stream.uncork();
      late?.connection.stream.resume();
      await reset;
      await closed;
      held.release();
      late?.release();
      await Promise.all([pool.end(), observer.end()]);
    }
  });

  it("handles an idle reset target checked out before its buffered termination arrives", async () => {
    const pool = createPostgresPool({ connectionString: ctx.databaseUrl });
    const observerUrl = new URL(ctx.databaseUrl);
    observerUrl.pathname = "/postgres";
    const observer = createPostgresPool({ connectionString: observerUrl.href });
    const idle = await pool.connect();
    const { rows } = await idle.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const control = await pool.connect();
    const closed = new Promise<void>((resolve) => idle.once("end", resolve));
    idle.connection.stream.pause();
    idle.release();
    control.release();
    const reset = terminateOtherPostgresConnections(pool);
    let acquired: typeof idle | undefined;
    try {
      await pollUntil(
        async () => {
          const result = await observer.query(
            "SELECT 1 FROM pg_stat_activity WHERE pid = $1",
            [rows[0]?.pid],
          );
          return result.rows.length === 0 ? true : undefined;
        },
        {
          label: "idle backend terminated before reacquisition",
          timeoutMs: 1000,
        },
      );
      acquired = await pool.connect();
      expect(acquired).toBe(idle);
      idle.connection.stream.resume();
      await closed;
      await reset;
      await expect(pool.query("SELECT 1")).resolves.toMatchObject({
        rowCount: 1,
      });
    } finally {
      idle.connection.stream.resume();
      await reset;
      acquired?.release();
      await Promise.all([pool.end(), observer.end()]);
    }
  });

  it.each(["checked out", "query in flight"])(
    "handles reset termination with a client %s before its lease is released",
    async (mode) => {
      const pool = createPostgresPool({ connectionString: ctx.databaseUrl });
      const client = await pool.connect();
      const { rows } = await client.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const query =
        mode === "query in flight"
          ? client.query("SELECT pg_sleep(30)").catch((error: Error) => error)
          : undefined;
      try {
        if (query)
          await pollUntil(
            async () => {
              const activity = await pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND query = 'SELECT pg_sleep(30)' AND state = 'active'",
                [rows[0]?.pid],
              );
              return activity.rowCount ? true : undefined;
            },
            { label: "active reset target", timeoutMs: 1000 },
          );
        await terminateOtherPostgresConnections(pool);
        const refusedQuery = expect.objectContaining({ code: "57P01" });
        expect(await query).toEqual(
          mode === "query in flight" ? refusedQuery : undefined,
        );
        await expect(pool.query("SELECT 1")).resolves.toMatchObject({
          rowCount: 1,
        });
      } finally {
        client.release();
        await pool.end();
      }
    },
  );

  it("delivers repeated shutdown errors to the callback", async () => {
    const pool = createPostgresPool({ connectionString: ctx.databaseUrl });
    await pool.end();
    const error = await Promise.race([
      new Promise<unknown>((resolve) => {
        pool.end((...args: unknown[]) => resolve(args[0]));
      }),
      delay(100).then(() => "callback was not called"),
    ]);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty(
      "message",
      "Called end on pool more than once",
    );
  });

  it.each(["promise", "callback", "idle eviction", "connecting"] as const)(
    "%s shutdown waits for the backend socket before permitting database cleanup",
    async (mode) => {
      const pool = createPostgresPool({
        connectionString: ctx.databaseUrl,
        idleTimeoutMillis: mode === "idle eviction" ? 1 : 10_000,
      });
      const acquiring = pool.connect();
      let ending: Promise<void> | undefined =
        mode === "connecting" ? pool.end() : undefined;
      const client = await acquiring;
      const socketClosed = new Promise<void>((resolve) =>
        client.once("end", resolve),
      );
      const { rows } = await client.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const pid = rows[0]?.pid;
      expect(pid).toBeDefined();

      // Delay the real Terminate packet, rather than mock pg's lifecycle.
      const socket = client.connection.stream;
      socket.cork();
      client.release();
      let finished = false;
      try {
        if (mode === "idle eviction") {
          await pollUntil(() => (pool.totalCount === 0 ? true : undefined), {
            label: "idle client removal",
            timeoutMs: 1000,
          });
        }
        ending ??=
          mode === "callback"
            ? new Promise<void>((resolve) => pool.end(resolve))
            : pool.end();
        void ending.then(() => {
          finished = true;
        });
        await delay(25);
        expect(finished).toBe(false);

        socket.uncork();
        await ending;
        const observer = await getDb(ctx.db).execute(
          sql`SELECT 1 FROM pg_stat_activity WHERE pid = ${pid}`,
        );
        expect(observer.rows).toHaveLength(0);
      } finally {
        socket.uncork();
        await socketClosed;
        await (ending ?? pool.end());
      }
    },
  );
});
