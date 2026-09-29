import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runWithExecutionCtx, setCfEnv } from "~/server/cf-env";

import { scheduleCalendarFeedDirty } from "./client";

afterEach(() => {
  setCfEnv(undefined);
  vi.useRealTimers();
});

/**
 * `markDirty` only sets a flag on the target Durable Object, so retrying it
 * inside the same `waitUntil` task is safe — this closes the "CalDAV feed
 * dirty-mark can fail silently" easy fix (docs/todos.md): a transient RPC
 * failure is now absorbed by a couple of retries instead of leaving the feed
 * stale after the very first failure.
 */
describe("scheduleCalendarFeedDirty", () => {
  it("retries a failed dirty-mark before giving up", async () => {
    vi.useFakeTimers();
    const markDirty = vi
      .fn()
      .mockRejectedValueOnce(new Error("stub RPC failure"))
      .mockRejectedValueOnce(new Error("stub RPC failure"))
      .mockResolvedValueOnce(undefined);
    setCfEnv(
      fromPartial<Env>({
        CALENDAR_FEED: { getByName: () => ({ markDirty }) },
      }),
    );

    const tasks: Promise<unknown>[] = [];
    await runWithExecutionCtx(
      { waitUntil: (task) => tasks.push(task) },
      async () => {
        scheduleCalendarFeedDirty("test.write");
      },
      "https://cubby.example",
    );
    expect(tasks).toHaveLength(1);

    // Let the two backoff `setTimeout`s elapse without a real wall-clock wait.
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(750);
    await tasks[0];

    expect(markDirty).toHaveBeenCalledTimes(3);
    expect(markDirty).toHaveBeenCalledWith(
      "test.write",
      "https://cubby.example",
    );
  });

  it("logs once and stops after every retry fails", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // SILENT: assertion target only, not the code under test.
    });
    const markDirty = vi.fn().mockRejectedValue(new Error("stub RPC failure"));
    setCfEnv(
      fromPartial<Env>({
        CALENDAR_FEED: { getByName: () => ({ markDirty }) },
      }),
    );

    const tasks: Promise<unknown>[] = [];
    await runWithExecutionCtx(
      { waitUntil: (task) => tasks.push(task) },
      async () => {
        scheduleCalendarFeedDirty("test.write");
      },
      "https://cubby.example",
    );
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(750);
    await tasks[0];

    expect(markDirty).toHaveBeenCalledTimes(3);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "[calendar-feed] failed to mark snapshot dirty",
      expect.objectContaining({ reason: "test.write", attempt: 2 }),
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("enqueues a calendar-feed.mark-dirty task once every retry fails", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // SILENT: assertion target only, not the code under test.
    });
    const markDirty = vi.fn().mockRejectedValue(new Error("stub RPC failure"));
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    setCfEnv(
      fromPartial<Env>({
        CALENDAR_FEED: { getByName: () => ({ markDirty }) },
        BACKGROUND_QUEUE: { sendBatch },
      }),
    );

    const tasks: Promise<unknown>[] = [];
    await runWithExecutionCtx(
      { waitUntil: (task) => tasks.push(task) },
      async () => {
        scheduleCalendarFeedDirty("test.write");
      },
      "https://cubby.example",
    );
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(750);
    await tasks[0];

    expect(markDirty).toHaveBeenCalledTimes(3);
    expect(sendBatch).toHaveBeenCalledTimes(1);
    const [messages] = sendBatch.mock.calls[0] ?? [];
    expect(messages).toHaveLength(1);
    // The real envelope schema is the contract the queue consumer enforces.
    expect(
      backgroundTaskMessageSchema.parse(messages[0].body).task,
    ).toMatchObject({
      kind: "calendar-feed.mark-dirty",
      origin: "https://cubby.example",
      reason: "test.write",
    });
    consoleError.mockRestore();
  });

  it("does not enqueue when a retry succeeds", async () => {
    vi.useFakeTimers();
    const markDirty = vi
      .fn()
      .mockRejectedValueOnce(new Error("stub RPC failure"))
      .mockResolvedValueOnce(undefined);
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    setCfEnv(
      fromPartial<Env>({
        CALENDAR_FEED: { getByName: () => ({ markDirty }) },
        BACKGROUND_QUEUE: { sendBatch },
      }),
    );

    const tasks: Promise<unknown>[] = [];
    await runWithExecutionCtx(
      { waitUntil: (task) => tasks.push(task) },
      async () => {
        scheduleCalendarFeedDirty("test.write");
      },
      "https://cubby.example",
    );
    await vi.advanceTimersByTimeAsync(250);
    await tasks[0];

    expect(markDirty).toHaveBeenCalledTimes(2);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("reports a fallback enqueue failure without throwing from waitUntil", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // SILENT: assertion target only, not the code under test.
    });
    const markDirty = vi.fn().mockRejectedValue(new Error("stub RPC failure"));
    const sendBatch = vi.fn().mockRejectedValue(new Error("queue down"));
    setCfEnv(
      fromPartial<Env>({
        CALENDAR_FEED: { getByName: () => ({ markDirty }) },
        BACKGROUND_QUEUE: { sendBatch },
      }),
    );

    const tasks: Promise<unknown>[] = [];
    await runWithExecutionCtx(
      { waitUntil: (task) => tasks.push(task) },
      async () => {
        scheduleCalendarFeedDirty("test.write");
      },
      "https://cubby.example",
    );
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(750);

    await expect(tasks[0]).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "[calendar-feed] failed to enqueue mark-dirty fallback",
      expect.objectContaining({ reason: "test.write" }),
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});
