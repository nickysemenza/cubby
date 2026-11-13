import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { withTransactionDatabase } from "~/server/db/helpers";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

import { publishInBackground, publishBackgroundTasks } from "./publish";

// Intent must not depend on queue acceptance or an after-commit buffer. A
// rejected authoritative write must leave neither execution nor queue work.
describe("durable task intent", () => {
  const ctx = withTestDb();
  const task = {
    kind: "maintenance.purchase-discovery",
    requestedAt: "2026-01-01T00:00:00.000Z",
  } as const;

  it("persists intent when no queue producer is installed", async () => {
    await publishInBackground(ctx.db, [task], { source: "synthetic-test" });
    const rows = (
      await repositoryQueries(ctx.db).execute<{
        cursor: unknown;
        runId: string | null;
      }>(
        sql`SELECT cursor, "doneAt", "runId" FROM "Pass" WHERE name = 'purchase.discovery'`,
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cursor: { senderAfter: null },
      doneAt: null,
    });
  });

  it("omits explicitly undefined optional fields from durable input", async () => {
    await publishBackgroundTasks(ctx.db, [{ ...task, runId: undefined }], {
      source: "synthetic-optional",
    });
    const [saved] = (
      await repositoryQueries(ctx.db).execute<{
        cursor: unknown;
        runId: string | null;
      }>(
        sql`SELECT cursor, "runId" FROM "Pass" WHERE name = 'purchase.discovery'`,
      )
    ).rows;
    expect(saved?.cursor).toEqual({ senderAfter: null });
    expect(saved?.runId).toBeNull();
  });

  it("rolls back intent with the authoritative write", async () => {
    await expect(
      withTransactionDatabase(ctx.db, async (tx) => {
        await publishBackgroundTasks(tx, [task], { source: "synthetic-test" });
        expect(
          (
            await repositoryQueries(tx).execute<{
              cursor: unknown;
              runId: string | null;
            }>(sql`SELECT * FROM "Pass" WHERE name = 'purchase.discovery'`)
          ).rows,
        ).toHaveLength(1);
        throw new Error("Synthetic rejected mutation");
      }),
    ).rejects.toThrow("Synthetic rejected mutation");
    expect(
      (
        await repositoryQueries(ctx.db).execute<{
          cursor: unknown;
          runId: string | null;
        }>(sql`SELECT * FROM "Pass" WHERE name = 'purchase.discovery'`)
      ).rows,
    ).toEqual([]);
  });
});
