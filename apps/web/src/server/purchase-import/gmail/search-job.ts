import { buildActorContext, type ActorContext } from "@cubby/schemas/context";
import { runEntityId, runShortcode } from "@cubby/schemas/identifiers";
import {
  type MailSearchRunProgress,
  mailSearchRunInput,
  mailSearchRunProgress,
} from "@cubby/schemas/run-fields";
import { createLogger } from "@cubby/worker-tracing";
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

import {
  describeErrorCauses,
  scrubErrorMessage,
} from "~/lib/error-diagnostics";
import { isAiGatewayRateLimit } from "~/server/clients/ai-gateway-error";
import type { Database } from "~/server/db";
import { run as runTable, runProgress, vendor } from "~/server/db/schema";
import { reportServerError } from "~/server/errors/report-error";
import { getDb } from "~/server/repo/database-helpers";
import { ensureRun } from "~/server/runs/ensure-run";

import { resolveVendorMailSearchTarget } from "./targets";
import { vendorSearchTerms } from "./vendor-identity";

const log = createLogger("vendor-mail.search");

/*
 * A Gmail search is one `mail_search` Run. `Run.input` is what was asked
 * (`after`, `searchTerms`); `Run.progress` is where the page-by-page walk
 * stands. `progress.phase` is the claim state a page's worker CAS-es on:
 * `queued` between pages, `running` while one is scanned. The Run's own
 * `status` stays `running` until the last page or a terminal failure.
 */
const activePhases = ["queued", "running"];

// A Run whose `input`/`progress` were never written (its opening transaction
// failed after `ensureRun` committed it) is not a search and stays invisible.
const mailSearchRun = and(
  eq(runTable.purpose, "mail_search"),
  isNotNull(runTable.progress),
);
const phaseIs = (phase: string) =>
  sql`${runTable.progress}->>'phase' = ${phase}`;
const phaseIn = (phases: readonly string[]) =>
  inArray(sql<string>`${runTable.progress}->>'phase'`, [...phases]);
const pagesScannedIs = (pages: number) =>
  sql`(${runTable.progress}->>'pagesScanned')::int = ${pages}`;
/** Merge into `progress` in SQL so a concurrent writer's other keys survive. */
const patchProgress = (patch: Partial<MailSearchRunProgress>) =>
  sql`coalesce(${runTable.progress}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;

const jobColumns = {
  runId: runTable.id,
  runShortcode: runTable.shortcode,
  vendorId: runTable.vendorId,
  actorUserId: runTable.actorUserId,
  status: runTable.status,
  input: runTable.input,
  progress: runTable.progress,
  skipped: runTable.skipped,
  dispatchError: runTable.dispatchError,
  createdAt: runTable.createdAt,
  updatedAt: runTable.updatedAt,
};

type JobRow = {
  runId: typeof runTable.$inferSelect.id;
  runShortcode: string;
  vendorId: typeof runTable.$inferSelect.vendorId;
  actorUserId: typeof runTable.$inferSelect.actorUserId;
  status: string;
  input: unknown;
  progress: unknown;
  skipped: number;
  dispatchError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const readJob = (row: JobRow) => ({
  ...row,
  input: mailSearchRunInput.parse(row.input),
  progress: mailSearchRunProgress.parse(row.progress),
});
type SearchJob = ReturnType<typeof readJob>;

const jobErrorText = (error: Error | string, sentryEventId?: string) => {
  const causes = describeErrorCauses(error).causes;
  const status = causes.find((cause) => cause.status)?.status;
  const first = causes[0]?.message ?? scrubErrorMessage(String(error));
  const summary = first.split("\n", 1)[0]?.slice(0, 600) ?? "Operation failed";
  const labelled =
    status && !summary.includes(`HTTP ${status}`)
      ? `HTTP ${status}: ${summary}`
      : summary;
  const coded = causes.find(
    (cause) => cause.code && !labelled.includes(cause.code),
  );
  const concise = coded
    ? `${labelled} · ${coded.code}: ${coded.message.slice(0, 120)}`
    : labelled;
  return sentryEventId ? `${concise}\nSentry event: ${sentryEventId}` : concise;
};

const displayJob = (job: SearchJob) => ({
  runShortcode: job.runShortcode,
  status: job.progress.phase,
  searched: job.progress.searched,
  skipped: job.skipped,
  reviewable: job.progress.reviewable,
  after: job.input.after,
  nextPageToken: job.progress.nextPageToken,
  error: job.progress.error ?? job.dispatchError,
  createdAt: job.createdAt.toISOString(),
});

export async function latestVendorMailSearchJob(
  db: Database,
  vendorCode: string,
  actor: ActorContext,
) {
  const target = await resolveVendorMailSearchTarget(db, vendorCode, actor);
  const [record] = await getDb(db)
    .select(jobColumns)
    .from(runTable)
    .where(
      and(
        mailSearchRun,
        eq(runTable.vendorId, target.vendorId),
        eq(runTable.ledgerPartyId, target.memberId),
        eq(runTable.actorUserId, actor.userId),
      ),
    )
    .orderBy(desc(runTable.createdAt))
    .limit(1);
  return record ? displayJob(readJob(record)) : null;
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
  const [row] = await database
    .select(jobColumns)
    .from(runTable)
    .where(
      and(
        mailSearchRun,
        eq(runTable.shortcode, runShortcode.parse(runCode)),
        eq(runTable.actorUserId, actor.userId),
      ),
    )
    .limit(1);
  if (!row) throw new Error("No Gmail search job exists for this Run.");
  const record = readJob(row);
  // Re-stating `queued` bumps `updatedAt`, which is what fences a second
  // resend inside the three-minute window.
  const [claimedRow] = await database
    .update(runTable)
    .set({ progress: patchProgress({ phase: "queued" }) })
    .where(
      and(
        eq(runTable.id, record.runId),
        phaseIs("queued"),
        lt(runTable.updatedAt, new Date(Date.now() - 3 * 60_000)),
      ),
    )
    .returning(jobColumns);
  if (!claimedRow)
    throw new Error(
      "Gmail search is still waiting for its worker or has already started. Retry is available after three minutes without a worker.",
    );
  const claimed = readJob(claimedRow);
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
          page: claimed.progress.pagesScanned,
          requestedAt: new Date().toISOString(),
        },
      ],
      { source: "vendor-mail.retry" },
    );
  } catch (error) {
    await database
      .update(runTable)
      .set({ updatedAt: record.updatedAt })
      .where(
        and(
          eq(runTable.id, claimed.runId),
          phaseIs("queued"),
          eq(runTable.updatedAt, claimed.updatedAt),
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
    detail: `Resent Gmail page ${claimed.progress.pagesScanned + 1} to the background queue`,
  });
  return displayJob(claimed);
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
    .select(jobColumns)
    .from(runTable)
    .where(
      and(
        mailSearchRun,
        eq(runTable.vendorId, target.vendorId),
        eq(runTable.ledgerPartyId, target.memberId),
        eq(runTable.actorUserId, actor.userId),
        phaseIn(activePhases),
      ),
    )
    .orderBy(desc(runTable.createdAt))
    .limit(1);
  if (active) return displayJob(readJob(active));
  const after =
    input.after ??
    new Date(Date.now() - 365 * 86_400_000)
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", "/");
  const runId = await ensureRun(
    db,
    { ...actor, runId: null },
    { purpose: "mail_search", trigger: "manual", notes: "Vendor Gmail search" },
  );
  const created = await database.transaction(async (tx) => {
    const [row] = await tx
      .update(runTable)
      .set({
        vendorId: target.vendorId,
        input: { after, searchTerms },
        progress: {
          phase: "queued",
          pageToken: input.pageToken ?? null,
          nextPageToken: null,
          pagesScanned: 0,
          searched: 0,
          reviewable: 0,
        },
      })
      .where(eq(runTable.id, runId))
      .returning(jobColumns);
    await tx.insert(runProgress).values({
      runId,
      eventId: crypto.randomUUID(),
      phase: "queued",
      detail: "Waiting to search Gmail",
    });
    return row;
  });
  if (!created) throw new Error("Gmail search Run was not created");
  const job = readJob(created);
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
        .update(runTable)
        .set({
          progress: patchProgress({ phase: "failed" }),
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
    .select(jobColumns)
    .from(runTable)
    .where(eq(runTable.id, job.runId))
    .limit(1);
  return displayJob(current ? readJob(current) : job);
}

// eslint-disable-next-line complexity -- A page's checkpoint, rate-limit retry, terminal failure, and next-page handoff share this claim boundary.
export async function runVendorMailSearchJob(
  db: Database,
  jobId: string,
  options: {
    page?: number;
    search?: typeof import("./search").searchVendorOrderMail;
    publish?: typeof import("~/server/background-tasks/publish").publishBackgroundTasks;
    reportError?: typeof reportServerError;
  } = {},
) {
  const database = getDb(db);
  const [row] = await database
    .select(jobColumns)
    .from(runTable)
    .where(and(mailSearchRun, eq(runTable.id, runEntityId.parse(jobId))))
    .limit(1);
  if (!row) return "skipped" as const;
  const job = readJob(row);
  const page = options.page ?? 0;
  const [claimed] = await database
    .update(runTable)
    .set({ progress: patchProgress({ phase: "running", error: null }) })
    .where(
      and(eq(runTable.id, job.runId), phaseIs("queued"), pagesScannedIs(page)),
    )
    .returning({ runId: runTable.id });
  if (!claimed) return "skipped" as const;
  const cursor =
    page === 0 ? job.progress.pageToken : job.progress.nextPageToken;
  const recordProgress = async (
    phase: string,
    detail: string,
    counts?: { searched?: number; skipped?: number },
  ) => {
    await database.transaction(async (tx) => {
      if (counts)
        await tx
          .update(runTable)
          .set({
            progress: patchProgress({
              searched: job.progress.searched + (counts.searched ?? 0),
            }),
            skipped: job.skipped + (counts.skipped ?? 0),
          })
          .where(eq(runTable.id, job.runId));
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
    const ownerVendorId = job.vendorId;
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
        after: job.input.after,
        pageToken: cursor ?? undefined,
        searchTerms: job.input.searchTerms,
      },
      buildActorContext(job.actorUserId, "system", {
        runId: job.runId,
      }),
      recordProgress,
    );
    if (result.nextPageToken && result.nextPageToken === cursor)
      throw new Error("Gmail returned the same page cursor twice");
    const hasNextPage = result.nextPageToken !== null;
    const pagesScanned = page + 1;
    const searched = job.progress.searched + result.searched;
    const skipped = job.skipped + result.skipped;
    const reviewable = job.progress.reviewable + result.reviewable;
    const finishedAt = hasNextPage ? null : new Date();
    await database.transaction(async (tx) => {
      await tx
        .update(runTable)
        .set({
          progress: patchProgress({
            phase: hasNextPage ? "queued" : "completed",
            searched,
            reviewable,
            pagesScanned,
            nextPageToken: result.nextPageToken,
          }),
          skipped,
          // Undefined leaves a column alone: only the last page closes the Run.
          status: finishedAt ? "completed" : undefined,
          endedAt: finishedAt ?? undefined,
        })
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
      .select({ progress: runTable.progress })
      .from(runTable)
      .where(eq(runTable.id, job.runId))
      .limit(1);
    const savedPages = current?.progress
      ? mailSearchRunProgress.parse(current.progress).pagesScanned
      : page;
    const checkpointSaved = savedPages > page;
    if (isAiGatewayRateLimit(error) && !checkpointSaved) {
      await database.transaction(async (tx) => {
        await tx
          .update(runTable)
          .set({
            progress: patchProgress({
              phase: "queued",
              error: message,
              searched: job.progress.searched,
            }),
            skipped: job.skipped,
          })
          .where(eq(runTable.id, job.runId));
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
    const eventId = (options.reportError ?? reportServerError)(error, {
      operation: "vendor-mail.search",
      stage: "run",
    });
    const failureMessage = jobErrorText(
      error instanceof Error ? error : String(error),
      eventId,
    );
    const finishedAt = new Date();
    await database.transaction(async (tx) => {
      await tx
        .update(runTable)
        .set({
          // A failed page after a saved checkpoint keeps that page's totals.
          progress: patchProgress(
            checkpointSaved
              ? { phase: "failed", error: null }
              : {
                  phase: "failed",
                  error: null,
                  searched: job.progress.searched,
                },
          ),
          skipped: checkpointSaved ? undefined : job.skipped,
          status: "failed",
          endedAt: finishedAt,
          failureCode: checkpointSaved
            ? "vendor_mail_publish_failed"
            : "vendor_mail_search_failed",
          dispatchError: failureMessage,
        })
        .where(eq(runTable.id, job.runId));
      await tx.insert(runProgress).values({
        runId: job.runId,
        eventId: crypto.randomUUID(),
        phase: "failed",
        detail: failureMessage.split("\n", 1)[0],
      });
    });
    // The Gmail client has already made its bounded retry attempts. Ack this
    // delivery so a manual retry cannot race a delayed queue replay.
    log.error("search failed", { error });
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
      runId: runTable.id,
      page: sql<number>`(${runTable.progress}->>'pagesScanned')::int`,
      updatedAt: runTable.updatedAt,
    })
    .from(runTable)
    .where(
      and(mailSearchRun, phaseIn(activePhases), lt(runTable.updatedAt, cutoff)),
    )
    .orderBy(runTable.updatedAt)
    .limit(50);
  const publish =
    options.publish ??
    (await import("~/server/background-tasks/publish")).publishBackgroundTasks;
  let republished = 0;
  for (const job of stale) {
    const [claimed] = await database
      .update(runTable)
      .set({ progress: patchProgress({ phase: "queued" }) })
      .where(
        and(
          eq(runTable.id, job.runId),
          eq(runTable.updatedAt, job.updatedAt),
          phaseIn(activePhases),
        ),
      )
      .returning({ runId: runTable.id });
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
