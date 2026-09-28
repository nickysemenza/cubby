import { buildActorContext, type ActorContext } from "@cubby/schemas/context";
import { runEntityId, runShortcode } from "@cubby/schemas/identifiers";
import { vendorSearchMailOut } from "@cubby/schemas/order-mail-review";
import { and, desc, eq, inArray, lt } from "drizzle-orm";

import {
  describeErrorCauses,
  scrubErrorMessage,
} from "~/lib/error-diagnostics";
import { isAiGatewayRateLimit } from "~/server/clients/ai-gateway-error";
import type { Database } from "~/server/db";
import {
  run as runTable,
  runProgress,
  vendor,
  vendorMailSearchJob,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { ensureRun } from "~/server/runs/ensure-run";

import { resolveVendorMailSearchTarget } from "./targets";
import { vendorSearchTerms } from "./vendor-identity";

const activeStatuses = ["queued", "running"];

type SearchJob = typeof vendorMailSearchJob.$inferSelect;

const jobErrorText = (error: Error | string) => {
  const causes = describeErrorCauses(error, { includeStacks: true }).causes;
  if (causes.length === 0) return scrubErrorMessage(String(error));
  const chain = causes
    .map((cause, index) => {
      const status = cause.status ? `HTTP ${cause.status} ` : "";
      const code = cause.code ? `${cause.code}: ` : "";
      return `${index ? "Caused by: " : ""}${status}${code}${cause.message}`;
    })
    .join("\n");
  const stacks = causes.flatMap((cause) => (cause.stack ? [cause.stack] : []));
  return stacks.length
    ? `${chain}\n\nStack traces:\n${stacks.join("\n\n")}`
    : chain;
};

const displayJob = (job: SearchJob, runShortcode: string) => ({
  runShortcode,
  status: vendorSearchMailOut.shape.status.parse(job.status),
  searched: job.searched,
  skipped: job.skipped,
  reviewable: job.reviewable,
  after: job.after,
  nextPageToken: job.nextPageToken,
  error: job.error,
  createdAt: job.createdAt.toISOString(),
});

export async function latestVendorMailSearchJob(
  db: Database,
  vendorCode: string,
  actor: ActorContext,
) {
  const target = await resolveVendorMailSearchTarget(db, vendorCode, actor);
  const [record] = await getDb(db)
    .select({ job: vendorMailSearchJob, runShortcode: runTable.shortcode })
    .from(vendorMailSearchJob)
    .innerJoin(runTable, eq(vendorMailSearchJob.runId, runTable.id))
    .where(
      and(
        eq(runTable.vendorId, target.vendorId),
        eq(runTable.ledgerPartyId, target.memberId),
        eq(runTable.actorUserId, actor.userId),
      ),
    )
    .orderBy(desc(vendorMailSearchJob.createdAt))
    .limit(1);
  return record ? displayJob(record.job, record.runShortcode) : null;
}

/** Resend a saved page when queue delivery has not reached its worker. */
export async function retryStalledVendorMailSearchJob(
  db: Database,
  runCode: string,
  actor: ActorContext,
  options: {
    publish?: typeof import("~/server/background-tasks/publish").publishBackgroundTasks;
  } = {},
) {
  const database = getDb(db);
  const [record] = await database
    .select({ job: vendorMailSearchJob, runShortcode: runTable.shortcode })
    .from(vendorMailSearchJob)
    .innerJoin(runTable, eq(vendorMailSearchJob.runId, runTable.id))
    .where(
      and(
        eq(runTable.shortcode, runShortcode.parse(runCode)),
        eq(runTable.actorUserId, actor.userId),
      ),
    )
    .limit(1);
  if (!record) throw new Error("No Gmail search job exists for this Run.");
  const [claimed] = await database
    .update(vendorMailSearchJob)
    .set({ status: "queued" })
    .where(
      and(
        eq(vendorMailSearchJob.runId, record.job.runId),
        eq(vendorMailSearchJob.status, "queued"),
        lt(vendorMailSearchJob.updatedAt, new Date(Date.now() - 3 * 60_000)),
      ),
    )
    .returning();
  if (!claimed)
    throw new Error(
      "Gmail search is still waiting for its worker or has already started. Retry is available after three minutes without a worker.",
    );
  const publish =
    options.publish ??
    (await import("~/server/background-tasks/publish")).publishBackgroundTasks;
  try {
    await publish(
      db,
      [
        {
          kind: "vendor-mail.search",
          jobId: claimed.runId,
          page: claimed.pagesScanned,
          requestedAt: new Date().toISOString(),
        },
      ],
      { source: "vendor-mail.retry" },
    );
  } catch (error) {
    await database
      .update(vendorMailSearchJob)
      .set({ updatedAt: record.job.updatedAt })
      .where(
        and(
          eq(vendorMailSearchJob.runId, claimed.runId),
          eq(vendorMailSearchJob.status, "queued"),
          eq(vendorMailSearchJob.updatedAt, claimed.updatedAt),
        ),
      );
    await database.insert(runProgress).values({
      runId: claimed.runId,
      eventId: crypto.randomUUID(),
      phase: "retry_failed",
      detail: jobErrorText(
        error instanceof Error ? error : String(error),
      ).split("\n", 1)[0],
    });
    throw error;
  }
  await database.insert(runProgress).values({
    runId: claimed.runId,
    eventId: crypto.randomUUID(),
    phase: "requeued",
    detail: `Resent Gmail page ${claimed.pagesScanned + 1} to the background queue`,
  });
  return displayJob(claimed, record.runShortcode);
}

export async function startVendorMailSearchJob(
  db: Database,
  input: { vendorId: string; after?: string; pageToken?: string },
  actor: ActorContext,
  options: {
    publish?: typeof import("~/server/background-tasks/publish").publishBackgroundTasks;
  } = {},
) {
  const target = await resolveVendorMailSearchTarget(db, input.vendorId, actor);
  const searchTerms = vendorSearchTerms(target.identity);
  if (searchTerms.length === 0)
    throw new Error(
      "Add a Vendor website or verified sender before searching Gmail.",
    );
  const database = getDb(db);
  const [active] = await database
    .select({ job: vendorMailSearchJob, runShortcode: runTable.shortcode })
    .from(vendorMailSearchJob)
    .innerJoin(runTable, eq(vendorMailSearchJob.runId, runTable.id))
    .where(
      and(
        eq(runTable.vendorId, target.vendorId),
        eq(runTable.ledgerPartyId, target.memberId),
        eq(runTable.actorUserId, actor.userId),
        inArray(vendorMailSearchJob.status, activeStatuses),
      ),
    )
    .orderBy(desc(vendorMailSearchJob.createdAt))
    .limit(1);
  if (active) return displayJob(active.job, active.runShortcode);
  const after =
    input.after ??
    new Date(Date.now() - 365 * 86_400_000)
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", "/");
  const runId = await ensureRun(
    db,
    { ...actor, runId: null },
    { purpose: "background", trigger: "manual", notes: "Vendor Gmail search" },
  );
  const [runRecord] = await database
    .select({ shortcode: runTable.shortcode })
    .from(runTable)
    .where(eq(runTable.id, runId))
    .limit(1);
  if (!runRecord) throw new Error("Gmail search Run was not created");
  const [job] = await database.transaction(async (tx) => {
    await tx
      .update(runTable)
      .set({ vendorId: target.vendorId })
      .where(eq(runTable.id, runId));
    const jobs = await tx
      .insert(vendorMailSearchJob)
      .values({ runId, after, pageToken: input.pageToken ?? null, searchTerms })
      .returning();
    await tx.insert(runProgress).values({
      runId,
      eventId: crypto.randomUUID(),
      phase: "queued",
      detail: "Waiting to search Gmail",
    });
    return jobs;
  });
  if (!job) throw new Error("Gmail search job was not created");
  try {
    const publish =
      options.publish ??
      (await import("~/server/background-tasks/publish"))
        .publishBackgroundTasks;
    await publish(
      db,
      [
        {
          kind: "vendor-mail.search",
          jobId: job.runId,
          page: 0,
          requestedAt: new Date().toISOString(),
        },
      ],
      { source: "vendor-mail.search" },
    );
  } catch (error) {
    const message = jobErrorText(
      error instanceof Error ? error : String(error),
    );
    const finishedAt = new Date();
    await database.transaction(async (tx) => {
      await tx
        .update(vendorMailSearchJob)
        .set({ status: "failed", error: message, finishedAt })
        .where(eq(vendorMailSearchJob.runId, job.runId));
      await tx
        .update(runTable)
        .set({
          status: "failed",
          endedAt: finishedAt,
          failureCode: "vendor_mail_publish_failed",
          dispatchError: message,
        })
        .where(eq(runTable.id, job.runId));
      await tx.insert(runProgress).values({
        runId: job.runId,
        eventId: crypto.randomUUID(),
        phase: "failed",
        detail: message.split("\n", 1)[0],
      });
    });
    throw error;
  }
  const [current] = await database
    .select()
    .from(vendorMailSearchJob)
    .where(eq(vendorMailSearchJob.runId, job.runId))
    .limit(1);
  return displayJob(current ?? job, runRecord.shortcode);
}

// eslint-disable-next-line complexity -- A page's checkpoint, rate-limit retry, terminal failure, and next-page handoff share this claim boundary.
export async function runVendorMailSearchJob(
  db: Database,
  jobId: string,
  options: {
    page?: number;
    search?: typeof import("./search").searchVendorOrderMail;
    publish?: typeof import("~/server/background-tasks/publish").publishBackgroundTasks;
  } = {},
) {
  const database = getDb(db);
  const [record] = await database
    .select({ job: vendorMailSearchJob, owner: runTable })
    .from(vendorMailSearchJob)
    .innerJoin(runTable, eq(vendorMailSearchJob.runId, runTable.id))
    .where(eq(vendorMailSearchJob.runId, runEntityId.parse(jobId)))
    .limit(1);
  if (!record) return "skipped" as const;
  const job = record.job;
  const page = options.page ?? 0;
  const [claimed] = await database
    .update(vendorMailSearchJob)
    .set({
      status: "running",
      error: null,
      startedAt: job.startedAt ?? new Date(),
    })
    .where(
      and(
        eq(vendorMailSearchJob.runId, job.runId),
        eq(vendorMailSearchJob.status, "queued"),
        eq(vendorMailSearchJob.pagesScanned, page),
      ),
    )
    .returning({ runId: vendorMailSearchJob.runId });
  if (!claimed) return "skipped" as const;
  const cursor = page === 0 ? job.pageToken : job.nextPageToken;
  const recordProgress = async (
    phase: string,
    detail: string,
    counts?: { searched?: number; skipped?: number },
  ) => {
    await database.transaction(async (tx) => {
      if (counts)
        await tx
          .update(vendorMailSearchJob)
          .set({
            searched: job.searched + (counts.searched ?? 0),
            skipped: job.skipped + (counts.skipped ?? 0),
          })
          .where(eq(vendorMailSearchJob.runId, job.runId));
      await tx.insert(runProgress).values({
        runId: job.runId,
        eventId: crypto.randomUUID(),
        phase,
        detail,
      });
    });
  };
  await recordProgress("running", `Searching Gmail page ${page + 1}`);
  try {
    const search =
      options.search ?? (await import("./search")).searchVendorOrderMail;
    const ownerVendorId = record.owner.vendorId;
    if (!ownerVendorId)
      throw new Error("Vendor for Gmail search no longer exists");
    const [vendorRecord] = await database
      .select({ shortcode: vendor.shortcode })
      .from(vendor)
      .where(eq(vendor.id, ownerVendorId))
      .limit(1);
    if (!vendorRecord)
      throw new Error("Vendor for Gmail search no longer exists");
    const result = await search(
      db,
      {
        vendorId: vendorRecord.shortcode,
        after: job.after,
        pageToken: cursor ?? undefined,
        searchTerms: job.searchTerms,
      },
      buildActorContext(record.owner.actorUserId, "system", {
        runId: job.runId,
      }),
      recordProgress,
    );
    if (result.nextPageToken && result.nextPageToken === cursor)
      throw new Error("Gmail returned the same page cursor twice");
    const hasNextPage = result.nextPageToken !== null;
    const pagesScanned = page + 1;
    const searched = job.searched + result.searched;
    const skipped = job.skipped + result.skipped;
    const reviewable = job.reviewable + result.reviewable;
    const finishedAt = hasNextPage ? null : new Date();
    await database.transaction(async (tx) => {
      await tx
        .update(vendorMailSearchJob)
        .set({
          status: hasNextPage ? "queued" : "completed",
          searched,
          skipped,
          reviewable,
          pagesScanned,
          nextPageToken: result.nextPageToken,
          finishedAt,
        })
        .where(eq(vendorMailSearchJob.runId, job.runId));
      if (finishedAt)
        await tx
          .update(runTable)
          .set({ status: "completed", endedAt: finishedAt })
          .where(eq(runTable.id, job.runId));
      await tx.insert(runProgress).values({
        runId: job.runId,
        eventId: crypto.randomUUID(),
        phase: hasNextPage ? "page_completed" : "completed",
        detail: `Checked ${searched} messages across ${pagesScanned} pages; ${skipped} already saved; ${reviewable} order emails to review${hasNextPage ? "; continuing" : ""}`,
      });
    });
    if (hasNextPage) {
      const publish =
        options.publish ??
        (await import("~/server/background-tasks/publish"))
          .publishBackgroundTasks;
      await publish(
        db,
        [
          {
            kind: "vendor-mail.search",
            jobId: job.runId,
            page: pagesScanned,
            requestedAt: new Date().toISOString(),
          },
        ],
        { source: "vendor-mail.search" },
      );
    }
    return "succeeded" as const;
  } catch (error) {
    const message = jobErrorText(
      error instanceof Error ? error : String(error),
    );
    const [current] = await database
      .select({ pagesScanned: vendorMailSearchJob.pagesScanned })
      .from(vendorMailSearchJob)
      .where(eq(vendorMailSearchJob.runId, job.runId))
      .limit(1);
    const checkpointSaved = (current?.pagesScanned ?? page) > page;
    if (isAiGatewayRateLimit(error) && !checkpointSaved) {
      await database.transaction(async (tx) => {
        await tx
          .update(vendorMailSearchJob)
          .set({
            status: "queued",
            error: message,
            searched: job.searched,
            skipped: job.skipped,
          })
          .where(eq(vendorMailSearchJob.runId, job.runId));
        await tx.insert(runProgress).values({
          runId: job.runId,
          eventId: crypto.randomUUID(),
          phase: "rate_limited",
          detail:
            "AI Gateway rate limited this page. Retrying in about two minutes.",
        });
      });
      throw error;
    }
    const finishedAt = new Date();
    await database.transaction(async (tx) => {
      await tx
        .update(vendorMailSearchJob)
        .set(
          checkpointSaved
            ? { status: "failed", error: message, finishedAt }
            : {
                status: "failed",
                error: message,
                finishedAt,
                searched: job.searched,
                skipped: job.skipped,
              },
        )
        .where(eq(vendorMailSearchJob.runId, job.runId));
      await tx
        .update(runTable)
        .set({
          status: "failed",
          endedAt: finishedAt,
          failureCode: checkpointSaved
            ? "vendor_mail_publish_failed"
            : "vendor_mail_search_failed",
        })
        .where(eq(runTable.id, job.runId));
      await tx.insert(runProgress).values({
        runId: job.runId,
        eventId: crypto.randomUUID(),
        phase: "failed",
        detail: message.split("\n", 1)[0],
      });
    });
    // The Gmail client has already made its bounded retry attempts. Ack this
    // delivery so a manual retry cannot race a delayed queue replay.
    console.error("[vendor-mail.search] search failed", error);
    return "succeeded" as const;
  }
}

/** Repair a worker interruption or a lost handoff after a saved page. */
export async function recoverStaleVendorMailSearchJobs(
  db: Database,
  options: {
    publish?: typeof import("~/server/background-tasks/publish").publishBackgroundTasks;
  } = {},
) {
  const database = getDb(db);
  const cutoff = new Date(Date.now() - 15 * 60_000);
  const stale = await database
    .select({
      runId: vendorMailSearchJob.runId,
      page: vendorMailSearchJob.pagesScanned,
      updatedAt: vendorMailSearchJob.updatedAt,
    })
    .from(vendorMailSearchJob)
    .where(
      and(
        inArray(vendorMailSearchJob.status, activeStatuses),
        lt(vendorMailSearchJob.updatedAt, cutoff),
      ),
    )
    .orderBy(vendorMailSearchJob.updatedAt)
    .limit(50);
  const publish =
    options.publish ??
    (await import("~/server/background-tasks/publish")).publishBackgroundTasks;
  let republished = 0;
  for (const job of stale) {
    const [claimed] = await database
      .update(vendorMailSearchJob)
      .set({ status: "queued" })
      .where(
        and(
          eq(vendorMailSearchJob.runId, job.runId),
          eq(vendorMailSearchJob.updatedAt, job.updatedAt),
          inArray(vendorMailSearchJob.status, activeStatuses),
        ),
      )
      .returning({ runId: vendorMailSearchJob.runId });
    if (!claimed) continue;
    await database.insert(runProgress).values({
      runId: job.runId,
      eventId: crypto.randomUUID(),
      phase: "resumed",
      detail: `Resuming Gmail page ${job.page + 1} after an interrupted handoff`,
    });
    await publish(
      db,
      [
        {
          kind: "vendor-mail.search",
          jobId: job.runId,
          page: job.page,
          requestedAt: new Date().toISOString(),
        },
      ],
      { source: "vendor-mail.recover" },
    );
    republished += 1;
  }
  return republished;
}
