import { buildActorContext, type ActorContext } from "@cubby/schemas/context";
import { vendorSearchMailOut } from "@cubby/schemas/order-mail-review";
import { and, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { vendor, vendorMailSearchJob } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

import { resolveVendorMailSearchTarget } from "./targets";
import { vendorSearchTerms } from "./vendor-identity";

const activeStatuses = ["queued", "running"];

type SearchJob = typeof vendorMailSearchJob.$inferSelect;

const displayJob = (job: SearchJob) => ({
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
  const [job] = await getDb(db)
    .select()
    .from(vendorMailSearchJob)
    .where(
      and(
        eq(vendorMailSearchJob.vendorId, target.vendorId),
        eq(vendorMailSearchJob.ledgerPartyId, target.memberId),
        eq(vendorMailSearchJob.userId, actor.userId),
      ),
    )
    .orderBy(desc(vendorMailSearchJob.createdAt))
    .limit(1);
  return job ? displayJob(job) : null;
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
    .select()
    .from(vendorMailSearchJob)
    .where(
      and(
        eq(vendorMailSearchJob.vendorId, target.vendorId),
        eq(vendorMailSearchJob.ledgerPartyId, target.memberId),
        eq(vendorMailSearchJob.userId, actor.userId),
        inArray(vendorMailSearchJob.status, activeStatuses),
      ),
    )
    .orderBy(desc(vendorMailSearchJob.createdAt))
    .limit(1);
  if (active) return displayJob(active);
  const after =
    input.after ??
    new Date(Date.now() - 365 * 86_400_000)
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", "/");
  const [job] = await database
    .insert(vendorMailSearchJob)
    .values({
      vendorId: target.vendorId,
      ledgerPartyId: target.memberId,
      userId: actor.userId,
      after,
      pageToken: input.pageToken ?? null,
    })
    .returning();
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
          jobId: job.id,
          requestedAt: new Date().toISOString(),
        },
      ],
      { source: "vendor-mail.search" },
    );
  } catch (error) {
    await database
      .update(vendorMailSearchJob)
      .set({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      })
      .where(eq(vendorMailSearchJob.id, job.id));
    throw error;
  }
  const [current] = await database
    .select()
    .from(vendorMailSearchJob)
    .where(eq(vendorMailSearchJob.id, job.id))
    .limit(1);
  return displayJob(current ?? job);
}

export async function runVendorMailSearchJob(
  db: Database,
  jobId: string,
  options: { search?: typeof import("./search").searchVendorOrderMail } = {},
) {
  const database = getDb(db);
  const [job] = await database
    .select()
    .from(vendorMailSearchJob)
    .where(eq(vendorMailSearchJob.id, jobId))
    .limit(1);
  if (!job || job.status === "completed" || job.status === "failed")
    return "skipped" as const;
  await database
    .update(vendorMailSearchJob)
    .set({ status: "running", error: null, startedAt: new Date() })
    .where(eq(vendorMailSearchJob.id, job.id));
  try {
    const search =
      options.search ?? (await import("./search")).searchVendorOrderMail;
    const [record] = await database
      .select({ shortcode: vendor.shortcode })
      .from(vendor)
      .where(eq(vendor.id, job.vendorId))
      .limit(1);
    if (!record) throw new Error("Vendor for Gmail search no longer exists");
    const result = await search(
      db,
      {
        vendorId: record.shortcode,
        after: job.after,
        pageToken: job.pageToken ?? undefined,
      },
      buildActorContext(job.userId, "system"),
    );
    await database
      .update(vendorMailSearchJob)
      .set({
        status: "completed",
        searched: result.searched,
        skipped: result.skipped,
        reviewable: result.reviewable,
        nextPageToken: result.nextPageToken,
        finishedAt: new Date(),
      })
      .where(eq(vendorMailSearchJob.id, job.id));
    return "succeeded" as const;
  } catch (error) {
    await database
      .update(vendorMailSearchJob)
      .set({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      })
      .where(eq(vendorMailSearchJob.id, job.id));
    // The Gmail client has already made its bounded retry attempts. Ack this
    // delivery so a manual retry cannot race a delayed queue replay.
    console.error("[vendor-mail.search] search failed", error);
    return "succeeded" as const;
  }
}
