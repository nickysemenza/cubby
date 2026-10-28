import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getDb,
  runAfterCommit,
  withTransactionDatabase,
  withSnapshotWriteDatabase,
} from "~/server/db/helpers";
import { product } from "~/server/db/schema";
import { recordChange } from "~/server/generic/changes/repo/change";
import {
  lockJobs,
  replaceJobGeneration,
} from "~/server/generic/jobs/jobs.fixtures";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

// A coordinated stale-row lock exercises retry ownership without relying on
// the removed mutable invalidation counter. Aborted DB work alone is replayed;
// submitted evidence and committed-effect exclusions remain authoritative.
describe("snapshot write recovery", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());
  const fixture = async (name = "Synthetic snapshot subject") => {
    const subject = await createProductFixture(
      ctx.db,
      makeProductInput({ name, notes: "Synthetic original note" }),
      ctx.actor,
    );
    await enqueueJob(ctx.db, {
      key: "synthetic:snapshot-contention",
      kind: "synthetic.contention",
      input: {},
    });
    return subject;
  };
  const replaceGeneration = () =>
    replaceJobGeneration(ctx.db, { key: "synthetic:snapshot-contention" });

  // Force a real stale-row lock error independently of capture storage. This
  // synthetic fence tests snapshot retry ownership, not a production writer.
  const conflictOnExecutionGuard = async (tx: Parameters<typeof getDb>[0]) => {
    await replaceGeneration();
    await lockJobs(tx, { key: "synthetic:snapshot-contention" });
  };

  // Marking source rows does not replace an execution tuple another worker owns.
  it("allows execution writes while source marks are committed", async () => {
    const subject = await fixture();
    let attempts = 0;
    await withSnapshotWriteDatabase(
      ctx.db,
      async (tx) => {
        attempts++;
        await readJobs(tx, { key: "synthetic:snapshot-contention" });
        await getDb(tx)
          .update(product)
          .set({ notes: "Synthetic saved note" })
          .where(eq(product.id, subject.entityId));
        await replaceGeneration();
        await recordChange(tx, { kind: "source", categories: ["product"] });
      },
      { isolationLevel: "serializable" },
    );
    expect(attempts).toBe(1);
  });

  it("commits one business result and one publication after coordinated snapshot contention", async () => {
    const subject = await fixture();
    let attempts = 0;
    const publications: number[] = [];
    await withSnapshotWriteDatabase(
      ctx.db,
      async (tx) => {
        const attempt = ++attempts;
        await readJobs(tx, { key: "synthetic:snapshot-contention" });
        await getDb(tx)
          .update(product)
          .set({ notes: "Synthetic saved note" })
          .where(eq(product.id, subject.entityId));
        await runAfterCommit(tx, async () => {
          publications.push(attempt);
        });
        if (attempt === 1) await conflictOnExecutionGuard(tx);
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
            await conflictOnExecutionGuard(tx);
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
          await readJobs(tx, { key: "synthetic:snapshot-contention" });
          await runAfterCommit(tx, async () => {
            publications.push(attempt);
          });
          await conflictOnExecutionGuard(tx);
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
              await readJobs(tx, { key: "synthetic:snapshot-contention" });
              await conflictOnExecutionGuard(tx);
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
