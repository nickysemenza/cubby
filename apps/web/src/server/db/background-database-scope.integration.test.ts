import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";
import { z } from "zod";

import { db, withInvocationDb } from "~/server/db";
import { resolveDatabaseRuntime } from "~/server/db/database-runtime";
import {
  getDb,
  runAfterCommit,
  withTransactionDatabase,
} from "~/server/db/helpers";

const ctx = withTestDb();
const backendRow = z.object({ pid: z.number().int() });

// Independent maintenance transactions share an invocation, never a commit.
// One committing while another awaits work must not commit the latter's rows.
it("isolates concurrent background transactions and their after-commit effects", async () => {
  await getDb(ctx.db).execute(sql`CREATE TABLE synthetic_background_scope (
    name text PRIMARY KEY
  )`);
  const firstWritten = Promise.withResolvers<void>();
  const secondFinished = Promise.withResolvers<void>();
  const published: string[] = [];
  const backendIds: number[] = [];

  await withInvocationDb(ctx.databaseUrl, async () => {
    const first = withTransactionDatabase(db, async (transactionDb) => {
      const backend = await getDb(transactionDb).execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`,
      );
      backendIds.push(backendRow.parse(backend.rows[0]).pid);
      await getDb(transactionDb).execute(
        sql`INSERT INTO synthetic_background_scope VALUES ('rolled-back')`,
      );
      await runAfterCommit(transactionDb, async () => {
        published.push("rolled-back");
      });
      firstWritten.resolve();
      await secondFinished.promise;
      throw new Error("Synthetic transaction rollback");
    });
    // Attach rejection handling before releasing either transaction barrier.
    const firstOutcome = first.catch((error: unknown) => error);
    await firstWritten.promise;
    try {
      await withTransactionDatabase(db, async (transactionDb) => {
        const backend = await getDb(transactionDb).execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        backendIds.push(backendRow.parse(backend.rows[0]).pid);
        await getDb(transactionDb).execute(
          sql`INSERT INTO synthetic_background_scope VALUES ('kept-row')`,
        );
        await runAfterCommit(transactionDb, async () => {
          published.push("committed");
        });
      });
    } finally {
      secondFinished.resolve();
    }
    expect(await firstOutcome).toEqual(
      new Error("Synthetic transaction rollback"),
    );
  });

  const rows = await getDb(ctx.db).execute<{ name: string }>(
    sql`SELECT name FROM synthetic_background_scope ORDER BY name`,
  );
  expect(rows.rows.map((row) => row.name)).toEqual(["kept-row"]);
  expect(published).toEqual(["committed"]);
  // Client shutdown precedes PostgreSQL removing its backend from the activity view.
  // One second is below the pool's ten-second idle timeout, so a missing close still fails.
  await expect
    .poll(
      async () => {
        const remaining = await getDb(ctx.db).execute<{ pid: number }>(
          sql`SELECT pid FROM pg_stat_activity WHERE pid IN (${sql.join(
            backendIds.map((pid) => sql`${pid}`),
            sql`, `,
          )})`,
        );
        return remaining.rows;
      },
      { timeout: 1000 },
    )
    .toEqual([]);
});

// A rejected task must release its database resources before its caller retries.
it("closes background database connections when the invocation throws", async () => {
  let backendId: number | undefined;
  await expect(
    withInvocationDb(ctx.databaseUrl, async () => {
      const result = await getDb(db).execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`,
      );
      backendId = backendRow.parse(result.rows[0]).pid;
      throw new Error("Synthetic invocation failure");
    }),
  ).rejects.toThrow("Synthetic invocation failure");
  await expect
    .poll(
      async () => {
        const remaining = await getDb(ctx.db).execute<{ pid: number }>(
          sql`SELECT pid FROM pg_stat_activity WHERE pid = ${backendId}`,
        );
        return remaining.rows;
      },
      { timeout: 1000 },
    )
    .toEqual([]);
});

// A continuation inherits its AsyncLocalStorage scope, but not a new lifetime.
// It must not open an unowned pool after the invocation has already closed.
it("refuses database work inherited from a completed background scope", async () => {
  const resume = Promise.withResolvers<void>();
  const late = Promise.withResolvers<unknown>();
  await withInvocationDb(ctx.databaseUrl, async () => {
    void resume.promise
      .then(async () => {
        const runtime = resolveDatabaseRuntime(db);
        try {
          return await runtime.client.execute(sql`SELECT 1`);
        } finally {
          // Contain an unexpectedly opened pool if the lifetime guard fails.
          await runtime.close?.();
        }
      })
      .then(late.resolve, late.reject);
  });
  const outcome = late.promise.catch((error: unknown) => error);
  resume.resolve();
  expect(await outcome).toEqual(
    new Error("Database invocation scope has completed"),
  );
});
