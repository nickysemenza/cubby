import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import { runEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { publishBackgroundTasks } from "~/server/background-tasks/publish";
import { run, runProgress } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { getRunLiveProgress } from "~/server/repo/run-progress";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import {
  latestVendorMailSearchJob,
  recoverStaleVendorMailSearchJobs,
  retryStalledVendorMailSearchJob,
  runVendorMailSearchJob,
  startVendorMailSearchJob,
} from "./search-job";

describe("Vendor Gmail search jobs", () => {
  const ctx = withTestDb();

  it("persists the search input and page progress on the Run", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic progress member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic progress vendor",
      website: "https://example.test",
    });
    const started = await startVendorMailSearchJob(
      ctx.db,
      { vendorId: vendor.shortcode, after: "2025/01/02" },
      ctx.actor,
      { publish: async () => ({ transport: "queue", count: 1 }) },
    );
    const readRun = async () => {
      const [row] = await getDb(ctx.db)
        .select({
          id: run.id,
          purpose: run.purpose,
          status: run.status,
          input: run.input,
          progress: run.progress,
          skipped: run.skipped,
          dispatchError: run.dispatchError,
        })
        .from(run)
        .where(eq(run.shortcode, started.runShortcode));
      if (!row) throw new Error("Synthetic Run was not saved");
      return row;
    };
    const queued = await readRun();
    expect(queued).toMatchObject({
      purpose: "mail_search",
      input: { after: "2025/01/02", searchTerms: ["example.test"] },
      progress: { phase: "queued", pagesScanned: 0 },
    });

    await runVendorMailSearchJob(ctx.db, queued.id, {
      search: async () => ({
        searched: 10,
        skipped: 6,
        reviewable: 2,
        after: "2025/01/02",
        nextPageToken: "saved-cursor",
      }),
      publish: async () => ({ transport: "queue", count: 1 }),
    });
    expect(await readRun()).toMatchObject({
      status: "running",
      skipped: 6,
      progress: {
        phase: "queued",
        pagesScanned: 1,
        searched: 10,
        reviewable: 2,
        nextPageToken: "saved-cursor",
      },
    });

    await runVendorMailSearchJob(ctx.db, queued.id, {
      page: 1,
      search: async () => {
        throw new Error("Synthetic permanent search failure");
      },
      reportError: () => "ffffffffffffffffffffffffffffffff",
    });
    const failed = await readRun();
    expect(failed).toMatchObject({
      status: "failed",
      // A failed page keeps the last saved checkpoint.
      progress: { phase: "failed", pagesScanned: 1, searched: 10 },
      dispatchError: expect.stringContaining(
        "Synthetic permanent search failure",
      ),
    });
  });

  it("keeps a rate-limited page queued with a concise cause for retry", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic vendor",
      website: "https://example.test",
    });
    const started = await startVendorMailSearchJob(
      ctx.db,
      { vendorId: vendor.shortcode },
      ctx.actor,
      { publish: async () => ({ transport: "queue", count: 1 }) },
    );
    const [saved] = await getDb(ctx.db)
      .select({ id: run.id })
      .from(run)
      .where(eq(run.shortcode, started.runShortcode));
    if (!saved) throw new Error("Synthetic Run was not saved");
    const provider = Object.assign(new Error("Wholesale Rate limited"), {
      status: 429,
      code: 2018,
    });
    provider.stack =
      "Error: Wholesale Rate limited\n    at provider (synthetic.ts:12:3)";
    const error = new Error(
      "AI Gateway request failed (model: synthetic-model)",
      {
        cause: provider,
      },
    );

    await expect(
      runVendorMailSearchJob(ctx.db, saved.id, {
        search: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);

    const progress = await getRunLiveProgress(ctx.db, started.runShortcode);
    expect(progress).toMatchObject({
      status: "running",
      gmail: {
        status: "queued",
        pagesScanned: 0,
        error: expect.stringContaining("model: synthetic-model"),
      },
      progress: expect.arrayContaining([
        expect.objectContaining({ phase: "rate_limited" }),
      ]),
    });
    expect(progress?.gmail?.error).not.toContain("synthetic.ts:12:3");
    expect(progress?.gmail?.error).toContain("HTTP 429");
  });

  it("resends only an overdue queued page and leaves its checkpoint intact", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic retry member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic retry vendor",
      website: "https://example.test",
    });
    const publish = vi.fn<typeof publishBackgroundTasks>(async () => ({
      transport: "queue",
      count: 1,
    }));
    const started = await startVendorMailSearchJob(
      ctx.db,
      { vendorId: vendor.shortcode },
      ctx.actor,
      { publish },
    );
    await expect(
      retryStalledVendorMailSearchJob(ctx.db, started.runShortcode, ctx.actor, {
        publish,
      }),
    ).rejects.toThrow(/still waiting/u);
    expect(publish).toHaveBeenCalledTimes(1);
    const [saved] = await getDb(ctx.db)
      .select({ runId: run.id })
      .from(run)
      .where(eq(run.shortcode, started.runShortcode));
    if (!saved) throw new Error("Synthetic Run was not saved");
    await getDb(ctx.db)
      .update(run)
      .set({ updatedAt: new Date(Date.now() - 4 * 60_000) })
      .where(eq(run.id, saved.runId));
    await retryStalledVendorMailSearchJob(
      ctx.db,
      started.runShortcode,
      ctx.actor,
      {
        publish,
      },
    );
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[1]).toMatchObject([
      { kind: "vendor-mail.search", jobId: saved.runId, page: 0 },
    ]);
    await expect(
      retryStalledVendorMailSearchJob(ctx.db, started.runShortcode, ctx.actor, {
        publish,
      }),
    ).rejects.toThrow(/still waiting/u);
    expect(publish).toHaveBeenCalledTimes(2);
    await getDb(ctx.db)
      .update(run)
      .set({ updatedAt: new Date(Date.now() - 4 * 60_000) })
      .where(eq(run.id, saved.runId));
    await expect(
      retryStalledVendorMailSearchJob(ctx.db, started.runShortcode, ctx.actor, {
        publish: async () => {
          throw new Error("Synthetic queue unavailable");
        },
      }),
    ).rejects.toThrow("Synthetic queue unavailable");
    expect(
      (await getRunLiveProgress(ctx.db, started.runShortcode))?.progress.at(-1),
    ).toMatchObject({
      phase: "retry_failed",
      detail: "Synthetic queue unavailable",
    });
    await retryStalledVendorMailSearchJob(
      ctx.db,
      started.runShortcode,
      ctx.actor,
      { publish },
    );
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("reads durable progress for a Run without a Gmail job", async () => {
    const runId = await ensureRun(
      ctx.db,
      { ...ctx.actor, runId: null },
      {
        purpose: "background",
        trigger: "manual",
        notes: "Synthetic background work",
      },
    );
    const [record] = await getDb(ctx.db)
      .select({ shortcode: run.shortcode })
      .from(run)
      .where(eq(run.id, runId));
    if (!record) throw new Error("Synthetic Run was not saved");
    await getDb(ctx.db).insert(runProgress).values({
      runId,
      eventId: crypto.randomUUID(),
      phase: "work_started",
      detail: "Processing synthetic task",
    });
    expect(await getRunLiveProgress(ctx.db, record.shortcode)).toMatchObject({
      status: "running",
      gmail: null,
      progress: [
        expect.objectContaining({
          phase: "work_started",
          detail: "Processing synthetic task",
        }),
      ],
    });
  });

  it("scans every page in one Run, retains inputs, and skips replayed pages", async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
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
    expect(first.runShortcode).toMatch(/^RUN-/u);
    expect(duplicate.createdAt).toBe(first.createdAt);
    expect(publish).toHaveBeenCalledTimes(1);
    const [ownedRun] = await getDb(ctx.db)
      .select({
        purpose: run.purpose,
        status: run.status,
        vendorId: run.vendorId,
        ledgerPartyId: run.ledgerPartyId,
      })
      .from(run)
      .where(eq(run.vendorId, vendor.id))
      .limit(1);
    expect(ownedRun).toMatchObject({
      purpose: "mail_search",
      status: "running",
      vendorId: vendor.id,
      ledgerPartyId: member.id,
    });
    const task = published[0]?.[0];
    if (!task || task.kind !== "vendor-mail.search")
      throw new Error("test setup: missing Gmail search task");
    const search = vi.fn(async (_db, _input, _actor, onProgress) => {
      await onProgress("gmail_list", "Found 10 messages", {
        searched: 10,
      });
      expect(
        await getRunLiveProgress(ctx.db, first.runShortcode),
      ).toMatchObject({
        status: "running",
        gmail: expect.objectContaining({ searched: 10 }),
        progress: expect.arrayContaining([
          expect.objectContaining({ phase: "gmail_list" }),
        ]),
      });
      return {
        searched: 10,
        skipped: 7,
        reviewable: 2,
        after: "2025/09/27",
        nextPageToken: "older-page",
      };
    });
    await expect(
      runVendorMailSearchJob(ctx.db, task.jobId, { search, publish }),
    ).resolves.toBe("succeeded");
    await expect(
      runVendorMailSearchJob(ctx.db, task.jobId, { search, publish }),
    ).resolves.toBe("skipped");
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ vendorId: vendor.shortcode }),
      expect.objectContaining({ runId: task.jobId }),
      expect.any(Function),
    );
    const [pendingRun] = await getDb(ctx.db)
      .select({ status: run.status, endedAt: run.endedAt })
      .from(run)
      .where(eq(run.id, runEntityId.parse(task.jobId)))
      .limit(1);
    expect(pendingRun).toMatchObject({ status: "running", endedAt: null });
    expect(published[1]?.[0]).toMatchObject({
      kind: "vendor-mail.search",
      jobId: task.jobId,
      page: 1,
    });
    expect(
      await latestVendorMailSearchJob(ctx.db, vendor.shortcode, ctx.actor),
    ).toMatchObject({
      status: "queued",
      searched: 10,
      skipped: 7,
      reviewable: 2,
      nextPageToken: "older-page",
    });
    const nextTask = published[1]?.[0];
    if (!nextTask || nextTask.kind !== "vendor-mail.search")
      throw new Error("test setup: missing second page task");
    await runVendorMailSearchJob(ctx.db, nextTask.jobId, {
      page: nextTask.page,
      publish,
      search: async (_db, input) => {
        expect(input).toMatchObject({
          after: first.after,
          pageToken: "older-page",
          searchTerms: ["example.test"],
        });
        return {
          searched: 4,
          skipped: 2,
          reviewable: 1,
          after: first.after,
          nextPageToken: null,
        };
      },
    });
    expect(await getRunLiveProgress(ctx.db, first.runShortcode)).toMatchObject({
      status: "completed",
      gmail: expect.objectContaining({
        searched: 14,
        skipped: 9,
        reviewable: 3,
        pagesScanned: 2,
        after: first.after,
        searchTerms: ["example.test"],
      }),
      progress: expect.arrayContaining([
        expect.objectContaining({ phase: "completed" }),
      ]),
    });

    const older = await startVendorMailSearchJob(
      ctx.db,
      { ...input, after: first.after, pageToken: "older-page" },
      ctx.actor,
      { publish },
    );
    expect(older.status).toBe("queued");
    const olderTask = published[2]?.[0];
    if (!olderTask || olderTask.kind !== "vendor-mail.search")
      throw new Error("test setup: missing older Gmail search task");
    const captured = vi.fn(() => "ffffffffffffffffffffffffffffffff");
    await expect(
      runVendorMailSearchJob(ctx.db, olderTask.jobId, {
        search: async () => {
          throw new Error("Synthetic permanent search failure");
        },
        reportError: captured,
      }),
    ).resolves.toBe("succeeded");
    expect(captured).toHaveBeenCalledOnce();
    expect(
      await latestVendorMailSearchJob(ctx.db, vendor.shortcode, ctx.actor),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Synthetic permanent search failure"),
    });
    expect(
      (await latestVendorMailSearchJob(ctx.db, vendor.shortcode, ctx.actor))
        ?.error,
    ).toContain("Sentry event: ffffffffffffffffffffffffffffffff");
    const [failedRun] = await getDb(ctx.db)
      .select({ status: run.status, failureCode: run.failureCode })
      .from(run)
      .where(eq(run.id, runEntityId.parse(olderTask.jobId)))
      .limit(1);
    expect(failedRun).toMatchObject({
      status: "failed",
      failureCode: "vendor_mail_search_failed",
    });
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
    expect(publish).toHaveBeenCalledTimes(4);
    const retriedTask = published[3]?.[0];
    if (!retriedTask || retriedTask.kind !== "vendor-mail.search")
      throw new Error("test setup: missing retried Gmail search task");
    await runVendorMailSearchJob(ctx.db, retriedTask.jobId, {
      search: async () => {
        const cause = Object.assign(new Error("invalid UUID input"), {
          code: "22P02",
        });
        throw new Error("Failed query: synthetic", { cause });
      },
    });
    expect(
      (await latestVendorMailSearchJob(ctx.db, vendor.shortcode, ctx.actor))
        ?.error,
    ).toContain("22P02: invalid UUID input");
  });

  it("requeues a stale checkpoint without changing its totals", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic recovery member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic recovery vendor",
      website: "https://example.test",
    });
    const publish = vi.fn<typeof publishBackgroundTasks>(
      async (_db, tasks) => ({
        transport: "queue",
        count: tasks.length,
      }),
    );
    const started = await startVendorMailSearchJob(
      ctx.db,
      { vendorId: vendor.shortcode },
      ctx.actor,
      { publish },
    );
    const [saved] = await getDb(ctx.db)
      .select({ runId: run.id })
      .from(run)
      .where(eq(run.shortcode, started.runShortcode));
    if (!saved) throw new Error("Synthetic job was not saved");
    await getDb(ctx.db)
      .update(run)
      .set({
        progress: {
          phase: "queued",
          pagesScanned: 1,
          searched: 10,
          reviewable: 0,
          pageToken: null,
          nextPageToken: "checkpoint",
        },
        updatedAt: new Date(Date.now() - 20 * 60_000),
      })
      .where(eq(run.id, saved.runId));
    await recoverStaleVendorMailSearchJobs(ctx.db, { publish });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[1]).toMatchObject([
      { kind: "vendor-mail.search", jobId: saved.runId, page: 1 },
    ]);
    expect(
      await latestVendorMailSearchJob(ctx.db, vendor.shortcode, ctx.actor),
    ).toMatchObject({
      status: "queued",
      searched: 10,
      nextPageToken: "checkpoint",
    });
  });

  it("keeps a completed page's counts and cursor when the next handoff fails", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic handoff member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic handoff vendor",
      website: "https://example.test",
    });
    const started = await startVendorMailSearchJob(
      ctx.db,
      { vendorId: vendor.shortcode },
      ctx.actor,
      { publish: async () => ({ transport: "queue", count: 1 }) },
    );
    const [saved] = await getDb(ctx.db)
      .select({ runId: run.id })
      .from(run)
      .where(eq(run.shortcode, started.runShortcode));
    if (!saved) throw new Error("Synthetic job was not saved");
    await runVendorMailSearchJob(ctx.db, saved.runId, {
      search: async () => ({
        searched: 10,
        skipped: 6,
        reviewable: 2,
        after: started.after,
        nextPageToken: "saved-cursor",
      }),
      publish: async () => {
        throw new Error("Synthetic queue outage");
      },
    });
    expect(
      await latestVendorMailSearchJob(ctx.db, vendor.shortcode, ctx.actor),
    ).toMatchObject({
      status: "failed",
      searched: 10,
      skipped: 6,
      reviewable: 2,
      nextPageToken: "saved-cursor",
      error: expect.stringContaining("Synthetic queue outage"),
    });
  });
});
