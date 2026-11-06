import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/schema";

import { advanceJob } from "../service/jobs";
import { enqueueJob } from "./producer";

describe("generic Job execution", () => {
  const ctx = withTestDb();

  it("opens serializable isolation for snapshot-dependent publication", async () => {
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic.serializable-publication",
      kind: "synthetic.serializable",
      input: {},
    });
    let isolation: string | undefined;
    await expect(
      advanceJob(ctx.db, saved.id, {
        "synthetic.serializable": {
          prepare: async () => ({
            isolationLevel: "serializable",
            page: { done: true },
            publish: async (tx) => {
              const result = await getDb(tx).execute<{ isolation: string }>(
                sql`SELECT current_setting('transaction_isolation') AS isolation`,
              );
              isolation = result.rows[0]?.isolation;
            },
          }),
        },
      }),
    ).resolves.toBe("succeeded");
    expect(isolation).toBe("serializable");
  });

  it("fences publication after lease loss", async () => {
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic.lease-loss",
      kind: "synthetic.lease-loss",
      input: {},
    });
    let published = false;
    await expect(
      advanceJob(ctx.db, saved.id, {
        "synthetic.lease-loss": {
          prepare: async (db, claim, context) => {
            await getDb(db)
              .update(job)
              .set({ leaseToken: crypto.randomUUID() })
              .where(eq(job.id, claim.id));
            await expect(context.check()).rejects.toThrow(
              "Job generation or lease is obsolete",
            );
            return {
              page: { done: true },
              publish: async () => {
                published = true;
              },
            };
          },
        },
      }),
    ).resolves.toBe("superseded");
    expect(published).toBe(false);
  });
});
