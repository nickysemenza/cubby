import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "~/server/db";
import { withTransactionDatabase } from "~/server/db/helpers";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import type { PermitRuntime } from "~/server/generic/jobs/service/permits";

import { handleBackgroundQueueBatch } from "./consume";
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
    const rows = await readJobs(ctx.db, { kind: task.kind });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.input).toEqual(task);
    expect(rows[0]).toMatchObject({ state: "queued" });
  });

  // Optional admission fields may be present as undefined in ordinary callers.
  // Persist the wire JSON shape rather than rejecting a valid domain task.
  it("runs one committed Job per permit, sends one successor, and acks an unreadable envelope", async () => {
    await publishInBackground(ctx.db, [task], { source: "synthetic-test" });
    const message = {
      body: "unreadable predecessor wake",
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const captureException = vi.fn();
    const send = vi.fn(async () => {});
    const runtime = (db: Database): PermitRuntime => ({
      db,
      handlers: {
        [task.kind]: { prepare: async () => ({ page: { done: true } }) },
      },
      drains: [],
      ports: { send, captureException },
    });
    await handleBackgroundQueueBatch(
      ctx.db,
      { queue: "cubby-background", messages: [message] },
      { captureException, runtime },
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    expect((await readJobs(ctx.db, { kind: task.kind }))[0]?.state).toBe(
      "completed",
    );
    // Lease recovery for the held claim only; nothing else is owed, so no successor.
    const [saved] = await readJobs(ctx.db, { kind: task.kind });
    expect(send.mock.calls).toEqual([
      [
        expect.any(Date),
        "job.lease-recovery",
        { kind: "job", id: saved?.id, lease: expect.any(String) },
      ],
    ]);

    // An idle permit costs one selection and sends nothing.
    const idle = { body: message.body, ack: vi.fn(), retry: vi.fn() };
    await handleBackgroundQueueBatch(
      ctx.db,
      { queue: "cubby-background", messages: [idle] },
      { captureException, runtime },
    );
    expect(idle.ack).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("omits explicitly undefined optional fields from durable input", async () => {
    await publishBackgroundTasks(ctx.db, [{ ...task, runId: undefined }], {
      source: "synthetic-optional",
    });
    const [saved] = await readJobs(ctx.db, { kind: task.kind });
    expect(saved?.input).toEqual(task);
    expect(saved?.runId).toBeNull();
  });

  it("rolls back intent with the authoritative write", async () => {
    await expect(
      withTransactionDatabase(ctx.db, async (tx) => {
        await publishBackgroundTasks(tx, [task], { source: "synthetic-test" });
        expect(await readJobs(tx, { kind: task.kind })).toHaveLength(1);
        throw new Error("Synthetic rejected mutation");
      }),
    ).rejects.toThrow("Synthetic rejected mutation");
    expect(await readJobs(ctx.db, { kind: task.kind })).toEqual([]);
  });
});
