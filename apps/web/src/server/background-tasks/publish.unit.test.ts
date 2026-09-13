import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import { testEntityId } from "@cubby/schemas/testing";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runWithExecutionCtx, setCfEnv } from "~/server/cf-env";
import { Database } from "~/server/db";

import {
  MAX_TASKS_PER_SEND,
  planSendBatches,
  publishBackgroundTasks,
  publishInBackground,
} from "./publish";

const requestedAt = "2026-09-12T12:00:00.000Z";
const recipeTask = (seed: string): BackgroundTaskInput => ({
  kind: "recipe-totals.recompute",
  requestedAt,
  recipeIds: [testEntityId("recipe", seed)],
});

const db = new Database(() => {
  throw new Error("publishing never touches the database");
});

describe("planSendBatches", () => {
  it("splits by message count", () => {
    const tasks = Array.from({ length: 205 }, (_, i) => recipeTask(`r${i}`));
    const batches = planSendBatches(tasks, {
      maxTasks: MAX_TASKS_PER_SEND,
      maxMessageBytes: 120_000,
      maxSendBytes: 240_000,
    });
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 5]);
    expect(batches[0]?.[0]).toMatchObject({
      version: 2,
      queueType: "background",
      task: { kind: "recipe-totals.recompute" },
    });
  });

  it("splits by serialized bytes before the count limit", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => recipeTask(`r${i}`));
    const oneMessage = new TextEncoder().encode(
      JSON.stringify({ version: 2, queueType: "background", task: tasks[0] }),
    ).byteLength;
    const batches = planSendBatches(tasks, {
      maxTasks: 100,
      maxMessageBytes: 120_000,
      maxSendBytes: oneMessage * 3 + 1,
    });
    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 3, 1]);
  });

  it("refuses a single task above the per-message limit", () => {
    expect(() =>
      planSendBatches([recipeTask("big")], {
        maxTasks: 100,
        maxMessageBytes: 10,
        maxSendBytes: 240_000,
      }),
    ).toThrow(/above the 10-byte message limit/);
  });
});

describe("publishBackgroundTasks", () => {
  afterEach(() => setCfEnv(undefined));

  it("awaits queue acceptance and reports the queue transport", async () => {
    const sent: unknown[][] = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (messages: Iterable<{ body: unknown }>) => {
            sent.push([...messages].map((m) => m.body));
          },
        },
      }),
    );
    const receipt = await publishBackgroundTasks(
      db,
      [recipeTask("a"), recipeTask("b")],
      { source: "test" },
    );
    expect(receipt).toEqual({ transport: "queue", count: 2 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
  });

  it("reports zero without touching the queue", async () => {
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async () => {
            throw new Error("must not be called");
          },
        },
      }),
    );
    await expect(
      publishBackgroundTasks(db, [], { source: "test" }),
    ).resolves.toEqual({ transport: "queue", count: 0 });
  });

  it("propagates a rejected send so an explicit action sees the failure", async () => {
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async () => {
            throw new Error("queue down");
          },
        },
      }),
    );
    await expect(
      publishBackgroundTasks(db, [recipeTask("a")], { source: "test" }),
    ).rejects.toThrow("queue down");
  });
});

describe("publishInBackground", () => {
  afterEach(() => {
    setCfEnv(undefined);
    vi.restoreAllMocks();
  });

  it("hands the publication to waitUntil inside a request", async () => {
    const waited: Promise<unknown>[] = [];
    let sends = 0;
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async () => {
            sends += 1;
          },
        },
      }),
    );
    await runWithExecutionCtx(
      { waitUntil: (promise) => waited.push(promise) },
      async () => {
        await publishInBackground(db, [recipeTask("a")], { source: "test" });
      },
    );
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(sends).toBe(1);
  });

  it("reports but never rejects when the queue refuses", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async () => {
            throw new Error("queue down");
          },
        },
      }),
    );
    await expect(
      publishInBackground(db, [recipeTask("a")], { source: "test" }),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "[background-tasks] publication failed",
      expect.objectContaining({ source: "test", count: 1 }),
    );
  });
});
