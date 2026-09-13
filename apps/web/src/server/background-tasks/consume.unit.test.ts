import type { BackgroundTask } from "@cubby/schemas/background-tasks";
import type { BackgroundTaskMessageInput } from "@cubby/schemas/queue-messages";
import { testEntityId } from "@cubby/schemas/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";

import type { BackgroundQueueDeliveredMessage } from "../background-queue-types";
import { handleBackgroundQueueBatch } from "./consume";
import type { handleBackgroundTask } from "./handle";

/** A faithful executor stand-in: the consumer's contract is its outcome/throw. */
const handle = vi.fn<typeof handleBackgroundTask>();

/** What an older deploy left on the wire. */
interface LegacyWakeup {
  version: 1;
  queueType: "background";
  batchId: string;
  jobId: string;
  kind: string;
}

const db = new Database(() => {
  throw new Error("the fake handler never touches the database");
});

const requestedAt = "2026-09-12T12:00:00.000Z";

/** A delivered message is Cloudflare's transport type: the one seam faked here. */
function delivered(body: BackgroundTaskMessageInput | LegacyWakeup) {
  const message = {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  } satisfies BackgroundQueueDeliveredMessage;
  return message;
}

const task = (seed: string): BackgroundTaskMessageInput => ({
  version: 2,
  queueType: "background",
  task: {
    kind: "recipe-totals.recompute",
    requestedAt,
    recipeIds: [testEntityId("recipe", seed)],
  },
});

describe("handleBackgroundQueueBatch", () => {
  beforeEach(() => {
    handle.mockReset();
  });

  it("acks succeeded and skipped tasks, retries only the one that threw", async () => {
    handle.mockImplementation(async (_db, parsed: BackgroundTask) => {
      if (parsed.kind !== "recipe-totals.recompute") return "skipped";
      const id = parsed.recipeIds[0];
      if (id === testEntityId("recipe", "boom")) throw new Error("boom");
      return id === testEntityId("recipe", "fresh") ? "skipped" : "succeeded";
    });
    const capture = vi.fn();
    const afterSuccess = vi.fn(async () => {});
    const messages = [
      delivered(task("a")),
      delivered(task("boom")),
      delivered(task("fresh")),
    ];
    vi.spyOn(console, "error").mockImplementation(() => {});

    const outcomes = await handleBackgroundQueueBatch(
      db,
      { queue: "cubby-background", messages },
      { captureException: capture, afterSuccess, handleTask: handle },
    );

    expect(outcomes).toEqual(["succeeded", "failed", "skipped"]);
    expect(messages[0]?.ack).toHaveBeenCalledOnce();
    expect(messages[1]?.retry).toHaveBeenCalledOnce();
    expect(messages[1]?.ack).not.toHaveBeenCalled();
    expect(messages[2]?.ack).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(expect.any(Error));
    expect(afterSuccess).toHaveBeenCalledOnce();
  });

  it("retries an unreadable body instead of acking it away", async () => {
    const capture = vi.fn();
    const message = delivered({
      version: 1,
      queueType: "background",
      batchId: "b",
      jobId: "j",
      kind: "recipe-totals.recompute",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const outcomes = await handleBackgroundQueueBatch(
      db,
      { queue: "cubby-background", messages: [message] },
      { captureException: capture, handleTask: handle },
    );

    expect(outcomes).toEqual(["unreadable"]);
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Unreadable"),
      }),
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it("skips the success hook when nothing succeeded", async () => {
    handle.mockResolvedValue("skipped");
    const afterSuccess = vi.fn(async () => {});
    await handleBackgroundQueueBatch(
      db,
      { queue: "cubby-background", messages: [delivered(task("a"))] },
      { captureException: vi.fn(), afterSuccess, handleTask: handle },
    );
    expect(afterSuccess).not.toHaveBeenCalled();
  });
});
