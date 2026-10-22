import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { job } from "~/server/db/schema";

import { handleBackgroundQueueMessage } from "./consume";
import { publishInBackground, publishBackgroundTasks } from "./publish";

// Intent must not depend on queue acceptance or an after-commit buffer. A
// rejected authoritative write must leave neither execution nor queue work.
describe("durable task intent", () => {
  const ctx = withTestDb();
  const task = {
    kind: "calendar-feed.mark-dirty",
    origin: "https://synthetic.example",
    reason: "Synthetic edit",
    requestedAt: "2026-01-01T00:00:00.000Z",
  } as const;

  it("persists intent when no queue producer is installed", async () => {
    await publishInBackground(ctx.db, [task], { source: "synthetic-test" });
    const rows = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.kind, task.kind));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.input).toEqual(task);
    expect(rows[0]).toMatchObject({
      state: "queued",
      subjectKind: "calendar",
      subjectId: task.origin,
    });
  });

  // Optional admission fields may be present as undefined in ordinary callers.
  // Persist the wire JSON shape rather than rejecting a valid domain task.
  it("drains committed Jobs and acks even when the wake body is unreadable", async () => {
    await publishInBackground(ctx.db, [task], { source: "synthetic-test" });
    const message = {
      body: "unreadable predecessor wake",
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const captureException = vi.fn();
    const outcome = await handleBackgroundQueueMessage(ctx.db, message, {
      captureException,
      handlers: {
        [task.kind]: { prepare: async () => ({ page: { done: true } }) },
      },
    });
    expect(outcome).toBe("unreadable");
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    expect(
      (await getDb(ctx.db).select().from(job).where(eq(job.kind, task.kind)))[0]
        ?.state,
    ).toBe("completed");
  });

  it("omits explicitly undefined optional fields from durable input", async () => {
    await publishBackgroundTasks(ctx.db, [{ ...task, runId: undefined }], {
      source: "synthetic-optional",
    });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.kind, task.kind));
    expect(saved?.input).toEqual(task);
    expect(saved?.runId).toBeNull();
  });

  it("rolls back intent with the authoritative write", async () => {
    await expect(
      withTransactionDatabase(ctx.db, async (tx) => {
        await publishBackgroundTasks(tx, [task], { source: "synthetic-test" });
        expect(
          await getDb(tx).select().from(job).where(eq(job.kind, task.kind)),
        ).toHaveLength(1);
        throw new Error("Synthetic rejected mutation");
      }),
    ).rejects.toThrow("Synthetic rejected mutation");
    expect(
      await getDb(ctx.db).select().from(job).where(eq(job.kind, task.kind)),
    ).toEqual([]);
  });
});
