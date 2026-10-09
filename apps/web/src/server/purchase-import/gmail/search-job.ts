import { buildActorContext, type ActorContext } from "@cubby/schemas/context";
import {
  type MailSearchRunProgress,
  mailSearchRunInput,
  mailSearchRunProgress,
} from "@cubby/schemas/run-fields";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { aiGatewayRateLimitDelayMs } from "~/server/ai/gateway-error";
import type { Database } from "~/server/db";
import { run as runTable, runProgress, vendor } from "~/server/db/schema";
import { reportServerError } from "~/server/errors/report-error";
import { getDb } from "~/server/repo/database-helpers";
import { ensureRun } from "~/server/runs/ensure-run";
import type { WorkflowRunParams } from "~/server/workflow-runs/contract";
import {
  productionWorkflowLauncher,
  type WorkflowLauncher,
} from "~/server/workflow-runs/launcher";
import {
  claimWorkflowRun,
  failWorkflowRun,
  launchWorkflowRun,
  recordRunProgress,
  runFailureText,
} from "~/server/workflow-runs/lifecycle";

import { searchVendorOrderMail } from "./search";
import { resolveVendorMailSearchTarget } from "./targets";
import { vendorSearchTerms } from "./vendor-identity";
import { defaultVendorMailSearchAfter } from "./vendor-search";

/*
 * A Gmail search is one `mail_search` Run that the `VendorMailSearchWorkflow`
 * walks page by page. `Run.input` is what was asked (`after`,
 * `searchTerms`); `Run.progress` is where the walk stands, written by each
 * page step under a compare-and-set on `pagesScanned` and the attempt, so a
 * replayed step never counts a page twice and a superseded attempt never
 * writes. `phase` is display state: `queued` between pages, `running` while
 * one is scanned, `waiting` through an AI Gateway rate limit.
 */
const activePhases = ["queued", "running", "waiting"];

// A Run whose `input`/`progress` were never written (its opening transaction
// failed after `ensureRun` committed it) is not a search and stays invisible.
const mailSearchRun = and(
  eq(runTable.purpose, "mail_search"),
  isNotNull(runTable.progress),
);
const phaseIn = (phases: readonly string[]) =>
  inArray(sql<string>`${runTable.progress}->>'phase'`, [...phases]);
const pagesScannedIs = (pages: number) =>
  sql`(${runTable.progress}->>'pagesScanned')::int = ${pages}`;
const attemptIs = (attempt: number) =>
  sql`coalesce((${runTable.progress}->>'attempt')::int, 0) = ${attempt}`;
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

export async function startVendorMailSearchJob(
  db: Database,
  input: { vendorId: string; after?: string; pageToken?: string },
  actor: ActorContext,
  options: { launcher?: WorkflowLauncher } = {},
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
        eq(runTable.status, "running"),
        phaseIn(activePhases),
      ),
    )
    .orderBy(desc(runTable.createdAt))
    .limit(1);
  if (active) return displayJob(readJob(active));
  const after = input.after ?? defaultVendorMailSearchAfter();
  const runId = await ensureRun(
    db,
    { ...actor, runId: null },
    { purpose: "mail_search", trigger: "manual", notes: "Vendor Gmail search" },
  );
  await database.transaction(async (tx) => {
    await tx
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
          attempt: 0,
        },
      })
      .where(eq(runTable.id, runId));
    await tx.insert(runProgress).values({
      runId,
      eventId: crypto.randomUUID(),
      phase: "queued",
      detail: "Waiting to search Gmail",
    });
  });
  await launchWorkflowRun(
    db,
    { runId, purpose: "mail_search" },
    options.launcher ?? productionWorkflowLauncher,
  );
  const [current] = await database
    .select(jobColumns)
    .from(runTable)
    .where(eq(runTable.id, runId))
    .limit(1);
  if (!current) throw new Error("Gmail search Run was not created");
  return displayJob(readJob(current));
}

/** Where this attempt resumes: the first page no attempt has saved. */
export async function beginVendorMailSearchAttempt(
  db: Database,
  params: WorkflowRunParams,
): Promise<{ kind: "stopped" } | { kind: "page"; page: number }> {
  const row = await claimWorkflowRun(db, params);
  if (!row) return { kind: "stopped" };
  return {
    kind: "page",
    page: mailSearchRunProgress.parse(row.progress).pagesScanned,
  };
}

export type VendorMailPageResult =
  | { kind: "stopped" }
  | { kind: "more"; nextPage: number }
  | { kind: "done" }
  | { kind: "rate_limited"; retryAfterMs: number };

/**
 * Scan one Gmail page for the Workflow step `page.<n>.scan.<try>`. A page
 * another delivery of this step already saved is not scanned again. A rate
 * limit returns the wait instead of throwing, so the Workflow sleeps without
 * spending a retry; any other failure is reported and kept on the Run for
 * the failure step, then thrown for the step to retry.
 */
// eslint-disable-next-line complexity -- One page's claim, replay check, rate-limit wait, failure record and saved checkpoint share this boundary.
export async function scanVendorMailPage(
  db: Database,
  params: WorkflowRunParams,
  page: number,
  options: {
    search?: typeof searchVendorOrderMail;
    reportError?: typeof reportServerError;
    now?: () => Date;
  } = {},
): Promise<VendorMailPageResult> {
  const row = await claimWorkflowRun(db, params);
  if (!row) return { kind: "stopped" };
  const job = readJob({ ...row, runId: row.id, runShortcode: row.shortcode });
  if (job.progress.pagesScanned > page)
    return job.progress.nextPageToken === null
      ? { kind: "done" }
      : { kind: "more", nextPage: page + 1 };
  if (job.progress.pagesScanned < page)
    throw new Error(
      `Gmail search Run is at page ${job.progress.pagesScanned + 1}, not ${page + 1}`,
    );
  const database = getDb(db);
  const owned = and(
    eq(runTable.id, job.runId),
    eq(runTable.status, "running"),
    attemptIs(params.attempt),
    pagesScannedIs(page),
  );
  await database
    .update(runTable)
    .set({
      progress: patchProgress({ phase: "running", error: null, retryAt: null }),
    })
    .where(owned);
  const cursor =
    page === 0 ? job.progress.pageToken : job.progress.nextPageToken;
  const recordProgress = async (
    phase: string,
    detail: string,
    counts?: { searched?: number; skipped?: number },
  ) => {
    await database.transaction(async (tx) => {
      // The update doubles as the ownership check: a cancelled or superseded
      // attempt writes no progress line.
      const [stillOwned] = await tx
        .update(runTable)
        .set(
          counts
            ? {
                progress: patchProgress({
                  searched: job.progress.searched + (counts.searched ?? 0),
                }),
                skipped: job.skipped + (counts.skipped ?? 0),
              }
            : { updatedAt: new Date() },
        )
        .where(owned)
        .returning({ id: runTable.id });
      if (!stillOwned) return;
      await tx.insert(runProgress).values({
        runId: job.runId,
        eventId: crypto.randomUUID(),
        phase,
        detail,
      });
    });
  };
  await recordProgress("running", `Searching Gmail page ${page + 1}`);
  let result: Awaited<ReturnType<typeof searchVendorOrderMail>>;
  try {
    const search = options.search ?? searchVendorOrderMail;
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
    result = await search(
      db,
      {
        vendorId: vendorRecord.shortcode,
        after: job.input.after,
        pageToken: cursor ?? undefined,
        searchTerms: job.input.searchTerms,
      },
      buildActorContext(job.actorUserId, "system", { runId: job.runId }),
      recordProgress,
    );
    if (result.nextPageToken && result.nextPageToken === cursor)
      throw new Error("Gmail returned the same page cursor twice");
  } catch (error) {
    const now = (options.now ?? (() => new Date()))();
    const delay = aiGatewayRateLimitDelayMs(
      error instanceof Error ? error : String(error),
      now.getTime(),
    );
    const message = runFailureText(
      error instanceof Error ? error : String(error),
      delay === null
        ? (options.reportError ?? reportServerError)(error, {
            operation: "vendor-mail.search",
            stage: "page",
          })
        : undefined,
    );
    // The page's partial counts are undone; a retry scans it from the start.
    await database
      .update(runTable)
      .set({
        progress: patchProgress({
          phase: delay === null ? "running" : "waiting",
          error: message,
          searched: job.progress.searched,
          retryAt:
            delay === null
              ? null
              : new Date(now.getTime() + delay).toISOString(),
        }),
        skipped: job.skipped,
      })
      .where(owned);
    if (delay === null) throw error;
    await recordRunProgress(
      db,
      job.runId,
      "rate_limited",
      `AI Gateway rate limited page ${page + 1}; retrying in ${Math.ceil(delay / 1000)}s`,
    );
    return { kind: "rate_limited", retryAfterMs: delay };
  }
  const hasNextPage = result.nextPageToken !== null;
  const pagesScanned = page + 1;
  const searched = job.progress.searched + result.searched;
  const skipped = job.skipped + result.skipped;
  const reviewable = job.progress.reviewable + result.reviewable;
  const finishedAt = hasNextPage ? null : new Date();
  const saved = await database.transaction(async (tx) => {
    const [checkpoint] = await tx
      .update(runTable)
      .set({
        progress: patchProgress({
          phase: hasNextPage ? "queued" : "completed",
          searched,
          reviewable,
          pagesScanned,
          nextPageToken: result.nextPageToken,
          error: null,
          retryAt: null,
        }),
        skipped,
        // Undefined leaves a column alone: only the last page closes the Run.
        status: finishedAt ? "completed" : undefined,
        endedAt: finishedAt ?? undefined,
      })
      .where(owned)
      .returning({ id: runTable.id });
    if (!checkpoint) return false;
    await tx.insert(runProgress).values({
      runId: job.runId,
      eventId: crypto.randomUUID(),
      phase: hasNextPage ? "page_completed" : "completed",
      detail: `Checked ${searched} messages across ${pagesScanned} pages; ${skipped} already saved; ${reviewable} order emails to review${hasNextPage ? "; continuing" : ""}`,
    });
    return true;
  });
  if (!saved) return { kind: "stopped" };
  return hasNextPage
    ? { kind: "more", nextPage: pagesScanned }
    : { kind: "done" };
}

/**
 * The Workflow's failure step: fail this attempt's Run with the diagnostic
 * the failed page saved (its full cause chain and Sentry event), or with the
 * step error Cloudflare rethrew when no page saved one.
 */
export async function failVendorMailSearch(
  db: Database,
  params: WorkflowRunParams,
  stepError: string,
): Promise<void> {
  const row = await claimWorkflowRun(db, params);
  if (!row) return;
  const saved = mailSearchRunProgress.safeParse(row.progress);
  await failWorkflowRun(db, params, {
    failureCode: "vendor_mail_search_failed",
    message: (saved.success ? saved.data.error : null) ?? stepError,
  });
}
