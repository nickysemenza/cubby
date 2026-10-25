import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getDb,
  runAfterCommit,
  withTransactionDatabase,
  withSnapshotWriteDatabase,
} from "~/server/db/helpers";
import { job, jobInvalidation, product } from "~/server/db/schema";
import { recordChange } from "~/server/generic/changes/repo/change";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

// A concurrent capture on a second connection replaces the family's
// invalidation tuple after snapshot creation. Recovery must replay only
// aborted DB work and retain submitted review evidence. Execution writes to
// the family Job (claim, renew, publish) never conflict with a capture.
describe("snapshot write recovery", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());
  const fixture = (name = "Synthetic snapshot subject") =>
    createProductFixture(
      ctx.db,
      makeProductInput({ name, notes: "Synthetic original note" }),
      ctx.actor,
    );
  const replaceInvalidation = () =>
    getDb(ctx.db)
      .update(jobInvalidation)
      .set({ revision: sql`${jobInvalidation.revision} + 1` })
      .where(eq(jobInvalidation.key, "refresh:search"));
  const replaceJobGeneration = () =>
    getDb(ctx.db)
      .update(job)
      .set({ generation: sql`${job.generation} + 1` })
      .where(eq(job.key, "refresh:search"));

  // Production finding: a family Job's claim and renewal on another backend
  // replaced the tuple the capture wrote and aborted admission with 40001.
  it("never aborts a capture for execution writes to the family Job", async () => {
    const subject = await fixture();
    let attempts = 0;
    await withSnapshotWriteDatabase(
      ctx.db,
      async (tx) => {
        attempts++;
        await getDb(tx).select().from(job).where(eq(job.key, "refresh:search"));
        await getDb(tx)
          .update(product)
          .set({ notes: "Synthetic saved note" })
          .where(eq(product.id, subject.entityId));
        await replaceJobGeneration();
        await recordChange(tx, { kind: "source", categories: ["product"] });
      },
      { isolationLevel: "serializable" },
    );
    expect(attempts).toBe(1);
  });

  it("commits one business result and one publication after late capture contention", async () => {
    const subject = await fixture();
    let attempts = 0;
    const publications: number[] = [];
    await withSnapshotWriteDatabase(
      ctx.db,
      async (tx) => {
        const attempt = ++attempts;
        await getDb(tx)
          .select()
          .from(jobInvalidation)
          .where(eq(jobInvalidation.key, "refresh:search"));
        await getDb(tx)
          .update(product)
          .set({ notes: "Synthetic saved note" })
          .where(eq(product.id, subject.entityId));
        await runAfterCommit(tx, async () => {
          publications.push(attempt);
        });
        if (attempt === 1) await replaceInvalidation();
        await recordChange(tx, { kind: "source", categories: ["product"] });
      },
      { isolationLevel: "serializable" },
    );
    expect(attempts).toBe(2);
    expect(publications).toEqual([2]);
    const [stored] = await getDb(ctx.db)
      .select({ notes: product.notes })
      .from(product)
      .where(eq(product.id, subject.entityId));
    expect(stored?.notes).toBe("Synthetic saved note");
  });

  it("refuses the original review when authoritative evidence changes before retry", async () => {
    const subject = await fixture();
    const evidence = await fixture("Synthetic snapshot review evidence");
    const publications: number[] = [];
    let attempts = 0;
    await expect(
      withSnapshotWriteDatabase(
        ctx.db,
        async (tx) => {
          const attempt = ++attempts;
          const [observed] = await getDb(tx)
            .select({ notes: product.notes })
            .from(product)
            .where(eq(product.id, evidence.entityId));
          if (observed?.notes !== "Synthetic original note")
            throw new Error("Synthetic review is stale");
          await getDb(tx)
            .update(product)
            .set({ notes: "Synthetic refused note" })
            .where(eq(product.id, subject.entityId));
          await runAfterCommit(tx, async () => {
            publications.push(attempt);
          });
          if (attempt === 1) {
            await getDb(ctx.db)
              .update(product)
              .set({ notes: "Synthetic changed evidence" })
              .where(eq(product.id, evidence.entityId));
            await replaceInvalidation();
          }
          await recordChange(tx, { kind: "source", categories: ["product"] });
        },
        { isolationLevel: "serializable" },
      ),
    ).rejects.toThrow("Synthetic review is stale");
    expect(publications).toEqual([]);
    const [stored] = await getDb(ctx.db)
      .select({ notes: product.notes })
      .from(product)
      .where(eq(product.id, subject.entityId));
    expect(stored?.notes).toBe("Synthetic original note");
  });

  it("bounds repeated serialization failures to three attempts", async () => {
    await fixture();
    let attempts = 0;
    const publications: number[] = [];
    await expect(
      withSnapshotWriteDatabase(
        ctx.db,
        async (tx) => {
          const attempt = ++attempts;
          await getDb(tx)
            .select()
            .from(jobInvalidation)
            .where(eq(jobInvalidation.key, "refresh:search"));
          await runAfterCommit(tx, async () => {
            publications.push(attempt);
          });
          await replaceInvalidation();
          await recordChange(tx, { kind: "source", categories: ["product"] });
        },
        { isolationLevel: "repeatable read" },
      ),
    ).rejects.toMatchObject({ cause: { code: "40001" } });
    expect(attempts).toBe(3);
    expect(publications).toEqual([]);
  });

  it("does not retry a caller-owned snapshot transaction", async () => {
    await fixture();
    let attempts = 0;
    await expect(
      withTransactionDatabase(
        ctx.db,
        (outer) =>
          withSnapshotWriteDatabase(
            outer,
            async (tx) => {
              attempts++;
              await getDb(tx)
                .select()
                .from(jobInvalidation)
                .where(eq(jobInvalidation.key, "refresh:search"));
              await replaceInvalidation();
              await recordChange(tx, {
                kind: "source",
                categories: ["product"],
              });
            },
            { isolationLevel: "serializable" },
          ),
        { isolationLevel: "serializable" },
      ),
    ).rejects.toMatchObject({ cause: { code: "40001" } });
    expect(attempts).toBe(1);
  });

  it("does not retry other database errors", async () => {
    let attempts = 0;
    await expect(
      withSnapshotWriteDatabase(
        ctx.db,
        async (tx) => {
          attempts++;
          await getDb(tx).execute(sql`SELECT 1/0`);
        },
        { isolationLevel: "serializable" },
      ),
    ).rejects.toMatchObject({ cause: { code: "22012" } });
    expect(attempts).toBe(1);
  });
});
