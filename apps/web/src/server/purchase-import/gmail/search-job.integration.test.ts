import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { publishBackgroundTasks } from "~/server/background-tasks/publish";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  latestVendorMailSearchJob,
  runVendorMailSearchJob,
  startVendorMailSearchJob,
} from "./search-job";

describe("Vendor Gmail search jobs", () => {
  const ctx = withTestDb();

  it("queues once, exposes progress, and safely skips a replayed delivery", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic Gmail member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Gmail vendor",
      website: "https://example.test",
    });
    const published: BackgroundTaskInput[][] = [];
    const publish = vi.fn<typeof publishBackgroundTasks>(async (_db, tasks) => {
      published.push([...tasks]);
      return { transport: "queue", count: tasks.length };
    });
    const input = { vendorId: vendor.shortcode };
    const first = await startVendorMailSearchJob(ctx.db, input, ctx.actor, {
      publish,
    });
    const duplicate = await startVendorMailSearchJob(ctx.db, input, ctx.actor, {
      publish,
    });
    expect(first.status).toBe("queued");
    expect(duplicate.createdAt).toBe(first.createdAt);
    expect(publish).toHaveBeenCalledTimes(1);
    const task = published[0]?.[0];
    if (!task || task.kind !== "vendor-mail.search")
      throw new Error("test setup: missing Gmail search task");
    const search = vi.fn(async () => ({
      searched: 10,
      skipped: 7,
      reviewable: 2,
      after: "2025/09/27",
      nextPageToken: "older-page",
    }));
    await expect(
      runVendorMailSearchJob(ctx.db, task.jobId, { search }),
    ).resolves.toBe("succeeded");
    await expect(
      runVendorMailSearchJob(ctx.db, task.jobId, { search }),
    ).resolves.toBe("skipped");
    expect(search).toHaveBeenCalledTimes(1);
    expect(
      await latestVendorMailSearchJob(ctx.db, vendor.shortcode, ctx.actor),
    ).toMatchObject({
      status: "completed",
      searched: 10,
      skipped: 7,
      reviewable: 2,
      nextPageToken: "older-page",
    });

    const older = await startVendorMailSearchJob(
      ctx.db,
      { ...input, after: first.after, pageToken: "older-page" },
      ctx.actor,
      { publish },
    );
    expect(older.status).toBe("queued");
    const olderTask = published[1]?.[0];
    if (!olderTask || olderTask.kind !== "vendor-mail.search")
      throw new Error("test setup: missing older Gmail search task");
    await expect(
      runVendorMailSearchJob(ctx.db, olderTask.jobId, {
        search: async () => {
          throw new Error("429 synthetic limit");
        },
      }),
    ).resolves.toBe("succeeded");
    expect(
      await latestVendorMailSearchJob(ctx.db, vendor.shortcode, ctx.actor),
    ).toMatchObject({ status: "failed", error: "429 synthetic limit" });
    await expect(
      runVendorMailSearchJob(ctx.db, olderTask.jobId, {
        search: async () => {
          throw new Error("A failed delivery must not replay");
        },
      }),
    ).resolves.toBe("skipped");
    const retried = await startVendorMailSearchJob(
      ctx.db,
      { ...input, after: first.after, pageToken: "older-page" },
      ctx.actor,
      { publish },
    );
    expect(retried.status).toBe("queued");
    expect(publish).toHaveBeenCalledTimes(3);
  });
});
