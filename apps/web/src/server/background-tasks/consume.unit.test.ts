import type { BackgroundTask } from "@cubby/schemas/background-tasks";
import { entityRefKey } from "@cubby/schemas/entity";
import type { BackgroundTaskMessageInput } from "@cubby/schemas/queue-messages";
import { testEntityId } from "@cubby/schemas/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";

import type { BackgroundQueueDeliveredMessage } from "../background-queue-types";
import { handleBackgroundQueueBatch } from "./consume";
import type { refreshEntityEmbeddings } from "./embedding";
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

const embedTask = (seed: string): BackgroundTaskMessageInput => ({
  version: 2,
  queueType: "background",
  task: {
    kind: "entity-embedding.refresh",
    requestedAt,
    entityType: "recipe",
    entityId: testEntityId("recipe", seed),
  },
});

const maintenanceTask = (
  kind: "maintenance.recover" | "maintenance.purchase-discovery",
): BackgroundTaskMessageInput => ({
  version: 2,
  queueType: "background",
  task: { kind, requestedAt },
});

describe("handleBackgroundQueueBatch", () => {
  beforeEach(() => {
    handle.mockReset();
  });

  it("isolates a failed maintenance job and accepts duplicate delivery of the other", async () => {
    handle.mockImplementation(async (_db, parsed) => {
      if (parsed.kind === "maintenance.recover")
        throw new Error("repair failed");
      return "succeeded";
    });
    const capture = vi.fn();
    const messages = [
      delivered(maintenanceTask("maintenance.recover")),
      delivered(maintenanceTask("maintenance.purchase-discovery")),
      delivered(maintenanceTask("maintenance.purchase-discovery")),
    ];
    vi.spyOn(console, "error").mockImplementation(() => {});

    const outcomes = await handleBackgroundQueueBatch(
      db,
      { queue: "cubby-background", messages },
      { captureException: capture, handleTask: handle },
    );

    expect(outcomes).toEqual(["failed", "succeeded", "succeeded"]);
    expect(messages[0]?.retry).toHaveBeenCalledOnce();
    expect(messages[1]?.ack).toHaveBeenCalledOnce();
    expect(messages[2]?.ack).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
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

  describe("entity-embedding.refresh batching", () => {
    it("isolates a per-ref error from its siblings and from a same-batch recipe task", async () => {
      handle.mockResolvedValue("succeeded");
      const boomError = new Error("boom");
      const refreshEmbeddings = vi.fn<typeof refreshEntityEmbeddings>(
        async (_db, refs) =>
          new Map(
            refs.map((ref) => [
              entityRefKey(ref.entityType, ref.entityId),
              ref.entityId === testEntityId("recipe", "boom")
                ? { error: boomError, throttled: false }
                : { outcome: "written" as const },
            ]),
          ),
      );
      const capture = vi.fn();
      const afterSuccess = vi.fn(async () => {});
      const messages = [
        delivered(task("r")),
        delivered(embedTask("a")),
        delivered(embedTask("b")),
        delivered(embedTask("boom")),
      ];
      vi.spyOn(console, "error").mockImplementation(() => {});

      const outcomes = await handleBackgroundQueueBatch(
        db,
        { queue: "cubby-background", messages },
        {
          captureException: capture,
          afterSuccess,
          handleTask: handle,
          refreshEmbeddings,
        },
      );

      expect(outcomes).toEqual([
        "succeeded",
        "succeeded",
        "succeeded",
        "failed",
      ]);
      expect(messages[0]?.ack).toHaveBeenCalledOnce();
      expect(messages[1]?.ack).toHaveBeenCalledOnce();
      expect(messages[2]?.ack).toHaveBeenCalledOnce();
      expect(messages[3]?.retry).toHaveBeenCalledOnce();
      expect(messages[3]?.ack).not.toHaveBeenCalled();
      expect(handle).toHaveBeenCalledOnce();
      expect(capture).toHaveBeenCalledOnce();
      expect(capture).toHaveBeenCalledWith(boomError);
      expect(afterSuccess).toHaveBeenCalledOnce();
    });

    it("retries every embedding message and leaves the recipe task untouched when the batched call throws", async () => {
      handle.mockResolvedValue("succeeded");
      const providerDown = new Error("provider down");
      const refreshEmbeddings = vi.fn<typeof refreshEntityEmbeddings>(
        async () => {
          throw providerDown;
        },
      );
      const capture = vi.fn();
      const messages = [
        delivered(task("r")),
        delivered(embedTask("a")),
        delivered(embedTask("b")),
      ];
      vi.spyOn(console, "error").mockImplementation(() => {});

      const outcomes = await handleBackgroundQueueBatch(
        db,
        { queue: "cubby-background", messages },
        { captureException: capture, handleTask: handle, refreshEmbeddings },
      );

      expect(outcomes).toEqual(["succeeded", "failed", "failed"]);
      expect(messages[0]?.ack).toHaveBeenCalledOnce();
      expect(messages[0]?.retry).not.toHaveBeenCalled();
      expect(messages[1]?.retry).toHaveBeenCalledOnce();
      expect(messages[1]?.ack).not.toHaveBeenCalled();
      expect(messages[2]?.retry).toHaveBeenCalledOnce();
      expect(messages[2]?.ack).not.toHaveBeenCalled();
      expect(capture).toHaveBeenCalledOnce();
      expect(capture).toHaveBeenCalledWith(providerDown);
    });

    it("delays a throttled per-ref retry instead of redelivering immediately", async () => {
      const throttledError = new Error("429");
      const refreshEmbeddings = vi.fn<typeof refreshEntityEmbeddings>(
        async (_db, refs) =>
          new Map(
            refs.map((ref) => [
              entityRefKey(ref.entityType, ref.entityId),
              { error: throttledError, throttled: true },
            ]),
          ),
      );
      const messages = [delivered(embedTask("a"))];
      vi.spyOn(console, "error").mockImplementation(() => {});

      await handleBackgroundQueueBatch(
        db,
        { queue: "cubby-background", messages },
        {
          captureException: vi.fn(),
          handleTask: handle,
          refreshEmbeddings,
        },
      );

      expect(messages[0]?.retry).toHaveBeenCalledWith(
        expect.objectContaining({ delaySeconds: expect.any(Number) }),
      );
      const call = messages[0]?.retry.mock.calls[0];
      expect(call).toBeDefined();
      const [delayOptions] = call ?? [];
      expect(delayOptions?.delaySeconds).toBeGreaterThanOrEqual(30);
      expect(delayOptions?.delaySeconds).toBeLessThan(60);
    });
  });
});
