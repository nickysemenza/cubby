import { backgroundTaskSchema } from "@cubby/schemas/background-tasks";
import { describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";

import {
  handleBackgroundTask,
  productionBackgroundTaskPorts,
  type BackgroundTaskPorts,
} from "./handle";

const db = new Database(() => {
  throw new Error("the calendar handler never touches the database");
});

const markDirtyTask = backgroundTaskSchema.parse({
  kind: "calendar-feed.mark-dirty",
  requestedAt: "2026-09-12T12:00:00.000Z",
  origin: "https://cubby.example",
  reason: "api.product.update",
});

const portsWith = (
  markCalendarFeedDirty: BackgroundTaskPorts["markCalendarFeedDirty"],
): BackgroundTaskPorts => ({
  ...productionBackgroundTaskPorts,
  markCalendarFeedDirty,
});

describe("calendar-feed.mark-dirty", () => {
  it("marks the origin's feed dirty with the original reason", async () => {
    const markCalendarFeedDirty = vi.fn().mockResolvedValue(undefined);

    const outcome = await handleBackgroundTask(
      db,
      markDirtyTask,
      portsWith(markCalendarFeedDirty),
    );

    expect(outcome).toBe("succeeded");
    expect(markCalendarFeedDirty).toHaveBeenCalledWith(
      "https://cubby.example",
      "api.product.update",
    );
  });

  // The queue only retries a throwing handler; swallowing the failure would
  // leave the feed stale, which is the gap this task exists to close.
  it("throws when the dirty-mark fails so the queue retries", async () => {
    const markCalendarFeedDirty = vi
      .fn()
      .mockRejectedValue(new Error("stub RPC failure"));

    await expect(
      handleBackgroundTask(db, markDirtyTask, portsWith(markCalendarFeedDirty)),
    ).rejects.toThrow("stub RPC failure");
  });
});
