import { runShortcode } from "@cubby/schemas/identifiers";
import {
  mailSearchRunInput,
  mailSearchRunProgress,
  orderMailImportRunInput,
  runOrderCandidateState,
  runStatus,
} from "@cubby/schemas/run-fields";
import { asc, desc, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { run, runOrderCandidate, runProgress } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

/** The small, durable progress read shared by every Run detail page. */
export async function getRunLiveProgress(db: Database, shortcode: string) {
  const database = getDb(db);
  const [record] = await database
    .select({ run })
    .from(run)
    .where(eq(run.shortcode, runShortcode.parse(shortcode)))
    .limit(1);
  if (!record) return null;
  const search =
    record.run.purpose === "mail_search"
      ? {
          input: mailSearchRunInput.parse(record.run.input),
          progress: mailSearchRunProgress.parse(record.run.progress),
        }
      : null;
  const events = await database
    .select({
      id: runProgress.eventId,
      phase: runProgress.phase,
      detail: runProgress.detail,
      createdAt: runProgress.createdAt,
      ageSeconds: sql<number>`greatest(0, floor(extract(epoch from (now()::timestamp - ${runProgress.createdAt}))))::int`,
    })
    .from(runProgress)
    .where(eq(runProgress.runId, record.run.id))
    .orderBy(desc(runProgress.createdAt), desc(runProgress.id))
    .limit(100);
  const selected = orderMailImportRunInput.safeParse(record.run.input);
  const orders =
    selected.success && "orders" in selected.data
      ? await database
          .select({
            orderId: runOrderCandidate.orderId,
            state: runOrderCandidate.state,
          })
          .from(runOrderCandidate)
          .where(eq(runOrderCandidate.runId, record.run.id))
          .orderBy(
            asc(runOrderCandidate.orderedAt),
            asc(runOrderCandidate.orderId),
          )
      : [];
  return {
    status: runStatus.parse(record.run.status),
    orders: orders.map((order) => ({
      orderId: order.orderId,
      state: runOrderCandidateState.parse(order.state),
    })),
    progress: events.reverse().map((event) => ({
      ...event,
      createdAt: event.createdAt.toISOString(),
    })),
    gmail: search
      ? {
          status: search.progress.phase,
          searched: search.progress.searched,
          skipped: record.run.skipped,
          reviewable: search.progress.reviewable,
          pagesScanned: search.progress.pagesScanned,
          after: search.input.after,
          searchTerms: search.input.searchTerms,
          startedFromOlderPage: search.progress.pageToken !== null,
          hasMorePages: search.progress.nextPageToken !== null,
          error: search.progress.error ?? record.run.dispatchError,
        }
      : null,
  };
}
