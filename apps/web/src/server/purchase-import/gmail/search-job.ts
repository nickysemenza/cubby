import { buildActorContext, type ActorContext } from "@cubby/schemas/context";
import { runEntityId } from "@cubby/schemas/identifiers";
import { vendorSearchMailOut } from "@cubby/schemas/order-mail-review";
import { and, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  run as runTable,
  vendor,
  vendorMailSearchJob,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { ensureRun } from "~/server/runs/ensure-run";

import { resolveVendorMailSearchTarget } from "./targets";
import { vendorSearchTerms } from "./vendor-identity";

const activeStatuses = ["queued", "running"];

type SearchJob = typeof vendorMailSearchJob.$inferSelect;

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

export async function startVendorMailSearchJob(
  db: Database,
  input: { vendorId: string; after?: string; pageToken?: string },
  actor: ActorContext,
  options: {
    publish?: typeof import("~/server/background-tasks/publish").publishBackgroundTasks;
  } = {},
) {
  const target = await resolveVendorMailSearchTarget(db, input.vendorId, actor);
  if (vendorSearchTerms(target.identity).length === 0)
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
    return tx
      .insert(vendorMailSearchJob)
      .values({ runId, after, pageToken: input.pageToken ?? null })
      .returning();
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
          requestedAt: new Date().toISOString(),
        },
      ],
      { source: "vendor-mail.search" },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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

export async function runVendorMailSearchJob(
  db: Database,
  jobId: string,
  options: { search?: typeof import("./search").searchVendorOrderMail } = {},
) {
  const database = getDb(db);
  const [record] = await database
    .select({ job: vendorMailSearchJob, owner: runTable })
    .from(vendorMailSearchJob)
    .innerJoin(runTable, eq(vendorMailSearchJob.runId, runTable.id))
    .where(eq(vendorMailSearchJob.runId, runEntityId.parse(jobId)))
    .limit(1);
  if (
    !record ||
    record.job.status === "completed" ||
    record.job.status === "failed"
  )
    return "skipped" as const;
  const job = record.job;
  await database
    .update(vendorMailSearchJob)
    .set({ status: "running", error: null, startedAt: new Date() })
    .where(eq(vendorMailSearchJob.runId, job.runId));
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
        pageToken: job.pageToken ?? undefined,
      },
      buildActorContext(record.owner.actorUserId, "system", {
        runId: job.runId,
      }),
    );
    const finishedAt = new Date();
    await database.transaction(async (tx) => {
      await tx
        .update(vendorMailSearchJob)
        .set({
          status: "completed",
          searched: result.searched,
          skipped: result.skipped,
          reviewable: result.reviewable,
          nextPageToken: result.nextPageToken,
          finishedAt,
        })
        .where(eq(vendorMailSearchJob.runId, job.runId));
      await tx
        .update(runTable)
        .set({ status: "completed", endedAt: finishedAt })
        .where(eq(runTable.id, job.runId));
    });
    return "succeeded" as const;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
          failureCode: "vendor_mail_search_failed",
        })
        .where(eq(runTable.id, job.runId));
    });
    // The Gmail client has already made its bounded retry attempts. Ack this
    // delivery so a manual retry cannot race a delayed queue replay.
    console.error("[vendor-mail.search] search failed", error);
    return "succeeded" as const;
  }
}
