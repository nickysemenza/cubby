import { runShortcode } from "@cubby/schemas/identifiers";
import { runStatus } from "@cubby/schemas/run-fields";
import { desc, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { run, runProgress, vendorMailSearchJob } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

/** The small, durable progress read shared by every Run detail page. */
export async function getRunLiveProgress(db: Database, shortcode: string) {
  const database = getDb(db);
  const [record] = await database
    .select({ run, gmail: vendorMailSearchJob })
    .from(run)
    .leftJoin(vendorMailSearchJob, eq(vendorMailSearchJob.runId, run.id))
    .where(eq(run.shortcode, runShortcode.parse(shortcode)))
    .limit(1);
  if (!record) return null;
  const events = await database
    .select({
      id: runProgress.eventId,
      phase: runProgress.phase,
      detail: runProgress.detail,
      createdAt: runProgress.createdAt,
    })
    .from(runProgress)
    .where(eq(runProgress.runId, record.run.id))
    .orderBy(desc(runProgress.createdAt), desc(runProgress.id))
    .limit(100);
  return {
    status: runStatus.parse(record.run.status),
    progress: events.reverse().map((event) => ({
      ...event,
      createdAt: event.createdAt.toISOString(),
    })),
    gmail: record.gmail
      ? {
          searched: record.gmail.searched,
          skipped: record.gmail.skipped,
          reviewable: record.gmail.reviewable,
          hasOlderPage: record.gmail.nextPageToken !== null,
          error: record.gmail.error,
        }
      : null,
  };
}
