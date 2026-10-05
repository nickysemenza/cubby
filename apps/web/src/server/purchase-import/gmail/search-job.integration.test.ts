/**
 * A vendor Gmail search is one `mail_search` Run that a Workflow instance
 * walks page by page. The Run row is the durable record; these scenarios
 * drive the step bodies the Workflow calls, with Cloudflare's binding faked.
 *
 * Failure modes guarded:
 * - a step retried after its write committed scans (and counts) a page twice;
 * - an AI Gateway 429 fails the search or spends a step retry instead of
 *   waiting the `Retry-After` it was given;
 * - a failure loses its diagnostic and Sentry event before the Run fails;
 * - a cancelled Run, or an attempt superseded by a retry, keeps writing;
 * - a retry restarts from page one instead of the saved position;
 * - a Run whose instance never started, or ended without its failure step,
 *   stays `running` forever.
 */
import { runEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { wrapAiGatewayError } from "~/server/clients/ai-gateway-error";
import { run, runProgress } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { getRunLiveProgress } from "~/server/repo/run-progress";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { controlWorkflowRun } from "~/server/workflow-runs/control";
import type {
  WorkflowInstanceState,
  WorkflowLauncher,
} from "~/server/workflow-runs/launcher";
import { reconcileWorkflowRuns } from "~/server/workflow-runs/lifecycle";

import {
  beginVendorMailSearchAttempt,
  failVendorMailSearch,
  latestVendorMailSearchJob,
  scanVendorMailPage,
  startVendorMailSearchJob,
} from "./search-job";

const fakeLauncher = () => {
  const created: { id: string; runId: string; attempt: number }[] = [];
  const terminated: string[] = [];
  const states = new Map<string, WorkflowInstanceState>();
  const launcher: WorkflowLauncher = {
    create: async (_purpose, id, params) => {
      created.push({ id, ...params });
      states.set(id, "running");
    },
    terminate: async (_purpose, id) => {
      terminated.push(id);
      states.set(id, "terminated");
    },
    status: async (_purpose, id) => ({
      state: states.get(id) ?? "missing",
      error: null,
    }),
  };
  return { launcher, created, terminated, states };
};

const page = (
  overrides: Partial<{
    searched: number;
    skipped: number;
    reviewable: number;
    nextPageToken: string | null;
  }> = {},
) => ({
  searched: 10,
  skipped: 4,
  reviewable: 1,
  after: "2025/01/02",
  nextPageToken: null,
  ...overrides,
});

describe("Vendor Gmail search Runs", () => {
  const ctx = withTestDb();

  const seed = async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic search member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic search vendor",
      website: "https://example.test",
    });
    const fake = fakeLauncher();
    const started = await startVendorMailSearchJob(
      ctx.db,
      { vendorId: vendor.shortcode, after: "2025/01/02" },
      ctx.actor,
      { launcher: fake.launcher },
    );
    const [row] = await getDb(ctx.db)
      .select({ id: run.id })
      .from(run)
      .where(eq(run.shortcode, started.runShortcode));
    if (!row) throw new Error("Synthetic Run was not saved");
    return { vendor, fake, started, runId: row.id };
  };

  const readRun = async (runId: string) => {
    const [row] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runEntityId.parse(runId)));
    if (!row) throw new Error("Run is missing");
    return row;
  };

  it("saves the search on the Run and starts one instance per attempt", async () => {
    const { vendor, fake, started, runId } = await seed();

    expect(fake.created).toEqual([
      { id: `${started.runShortcode}-1`, runId, attempt: 1 },
    ]);
    expect(await readRun(runId)).toMatchObject({
      purpose: "mail_search",
      status: "running",
      input: { after: "2025/01/02", searchTerms: ["example.test"] },
      progress: expect.objectContaining({
        phase: "queued",
        attempt: 1,
        pagesScanned: 0,
      }),
    });
    const duplicate = await startVendorMailSearchJob(
      ctx.db,
      { vendorId: vendor.shortcode },
      ctx.actor,
      { launcher: fake.launcher },
    );
    expect(duplicate.runShortcode).toBe(started.runShortcode);
    expect(fake.created).toHaveLength(1);
  });

  it("walks pages once each, even when a committed step replays", async () => {
    const { vendor, started, runId } = await seed();
    const params = { runId, attempt: 1 };
    const search = vi
      .fn()
      .mockResolvedValueOnce(page({ nextPageToken: "older-page" }))
      .mockResolvedValueOnce(
        page({ searched: 3, skipped: 1, reviewable: 2, nextPageToken: null }),
      );

    expect(await beginVendorMailSearchAttempt(ctx.db, params)).toEqual({
      kind: "page",
      page: 0,
    });
    expect(await scanVendorMailPage(ctx.db, params, 0, { search })).toEqual({
      kind: "more",
      nextPage: 1,
    });
    // The step's write committed but its result was lost: the retry sees it.
    expect(await scanVendorMailPage(ctx.db, params, 0, { search })).toEqual({
      kind: "more",
      nextPage: 1,
    });
    expect(await scanVendorMailPage(ctx.db, params, 1, { search })).toEqual({
      kind: "done",
    });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1]?.[1]).toMatchObject({
      pageToken: "older-page",
      searchTerms: ["example.test"],
    });
    expect(
      await getRunLiveProgress(ctx.db, started.runShortcode),
    ).toMatchObject({
      status: "completed",
      gmail: expect.objectContaining({
        status: "completed",
        searched: 13,
        skipped: 5,
        reviewable: 3,
        pagesScanned: 2,
      }),
    });
    expect(
      await latestVendorMailSearchJob(ctx.db, vendor.shortcode, ctx.actor),
    ).toMatchObject({ status: "completed", searched: 13 });
  });

  it("waits out an AI Gateway 429 without failing or counting the page", async () => {
    const { runId } = await seed();
    const params = { runId, attempt: 1 };
    const rateLimit = new Error("Gmail page retrieval failed", {
      cause: wrapAiGatewayError(
        new Error("generic"),
        {
          model: "synthetic-model",
          provider: "openai",
          route: "openai-responses",
          feature: "mail-classification",
          operation: "classify",
        },
        {
          status: 429,
          statusText: "Too Many Requests",
          body: "{}",
          retryAfter: "45",
        },
      ),
    });
    const search = vi.fn(async (_db, _input, _actor, onProgress) => {
      await onProgress("gmail_list", "Found 10 messages", { searched: 10 });
      throw rateLimit;
    });

    const result = await scanVendorMailPage(ctx.db, params, 0, {
      search,
      now: () => new Date("2026-10-05T12:00:00.000Z"),
    });

    expect(result).toEqual({ kind: "rate_limited", retryAfterMs: 45_000 });
    expect(await readRun(runId)).toMatchObject({
      status: "running",
      progress: expect.objectContaining({
        phase: "waiting",
        searched: 0,
        pagesScanned: 0,
        retryAt: "2026-10-05T12:00:45.000Z",
      }),
    });
    const resumed = await scanVendorMailPage(ctx.db, params, 0, {
      search: async () => page(),
    });
    expect(resumed).toEqual({ kind: "done" });
    expect(await readRun(runId)).toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ searched: 10, retryAt: null }),
    });
  });

  it("keeps a failed page's diagnostic and Sentry event for the failure step", async () => {
    const { runId } = await seed();
    const params = { runId, attempt: 1 };
    const reportError = vi.fn(() => "ffffffffffffffffffffffffffffffff");
    const failure = Object.assign(new Error("Synthetic upstream failure"), {
      status: 503,
    });

    await expect(
      scanVendorMailPage(ctx.db, params, 0, {
        search: async () => {
          throw failure;
        },
        reportError,
      }),
    ).rejects.toThrow("Synthetic upstream failure");
    expect(reportError).toHaveBeenCalledTimes(1);

    await failVendorMailSearch(ctx.db, params, "Workflow step failed");
    expect(await readRun(runId)).toMatchObject({
      status: "failed",
      failureCode: "vendor_mail_search_failed",
      dispatchError:
        "HTTP 503: Synthetic upstream failure\nSentry event: ffffffffffffffffffffffffffffffff",
      progress: expect.objectContaining({ phase: "failed" }),
    });
  });

  it("stops a cancelled attempt and resumes a retry from the saved page", async () => {
    const { fake, started, runId } = await seed();
    const first = { runId, attempt: 1 };
    await scanVendorMailPage(ctx.db, first, 0, {
      search: async () => page({ nextPageToken: "older-page" }),
    });

    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      { runPublicId: started.runShortcode, action: "cancel" },
      "mail_search",
      fake.launcher,
    );
    expect(fake.terminated).toEqual([`${started.runShortcode}-1`]);
    expect(await readRun(runId)).toMatchObject({
      status: "failed",
      failureCode: "user_cancelled",
    });
    const search = vi.fn(async () => page());
    expect(await scanVendorMailPage(ctx.db, first, 1, { search })).toEqual({
      kind: "stopped",
    });
    expect(search).not.toHaveBeenCalled();

    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      { runPublicId: started.runShortcode, action: "retry" },
      "mail_search",
      fake.launcher,
    );
    expect(fake.created.at(-1)).toEqual({
      id: `${started.runShortcode}-2`,
      runId,
      attempt: 2,
    });
    expect(await readRun(runId)).toMatchObject({
      status: "running",
      failureCode: null,
      progress: expect.objectContaining({ phase: "queued", attempt: 2 }),
    });
    expect(await scanVendorMailPage(ctx.db, first, 1, { search })).toEqual({
      kind: "stopped",
    });
    expect(
      await beginVendorMailSearchAttempt(ctx.db, { runId, attempt: 2 }),
    ).toEqual({ kind: "page", page: 1 });
    expect(
      await scanVendorMailPage(ctx.db, { runId, attempt: 2 }, 1, { search }),
    ).toEqual({ kind: "done" });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("fails the Run when Cloudflare refuses the instance", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic refused member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic refused vendor",
      website: "https://example.test",
    });
    const launcher: WorkflowLauncher = {
      ...fakeLauncher().launcher,
      create: async () => {
        throw new Error("Synthetic Workflow binding outage");
      },
    };

    await expect(
      startVendorMailSearchJob(
        ctx.db,
        { vendorId: vendor.shortcode },
        ctx.actor,
        { launcher },
      ),
    ).rejects.toThrow("Synthetic Workflow binding outage");
    const [failed] = await getDb(ctx.db)
      .select({ status: run.status, failureCode: run.failureCode })
      .from(run)
      .where(eq(run.vendorId, vendor.id));
    expect(failed).toEqual({
      status: "failed",
      failureCode: "workflow_dispatch_failed",
    });
  });

  it("fails a quiet Run whose instance ended, and leaves a waiting one", async () => {
    const { fake, started, runId } = await seed();
    const later = new Date(Date.now() + 60 * 60_000);

    fake.states.set(`${started.runShortcode}-1`, "waiting");
    expect(await reconcileWorkflowRuns(ctx.db, fake.launcher, later)).toBe(0);
    fake.states.set(`${started.runShortcode}-1`, "errored");
    expect(await reconcileWorkflowRuns(ctx.db, fake.launcher, later)).toBe(1);
    expect(await readRun(runId)).toMatchObject({
      status: "failed",
      failureCode: "workflow_instance_ended",
    });
    expect(
      await getDb(ctx.db)
        .select({ phase: runProgress.phase })
        .from(runProgress)
        .where(eq(runProgress.runId, runId)),
    ).toEqual(expect.arrayContaining([{ phase: "failed" }]));
  });
});
