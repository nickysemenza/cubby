import { createLogger } from "@cubby/worker-tracing";
/**
 * The daily maintenance cron's jobs (`handler.scheduled` in cf-server.ts loads
 * this module on the run). Each job reports its own failure and the next one
 * still runs.
 */
import * as Sentry from "@sentry/cloudflare";

import { calendarFeedStateFor } from "~/server/calendar/client";
import { db, withRequestDbClient } from "~/server/db";
import { selectRecentlySoftDeletedSearchRefs } from "~/server/repo/entity-embedding-cleanup";
import type { SearchDocumentCursor } from "~/server/repo/search-document";
import { semanticEmbeddingsConfigured } from "~/server/semantic/embeddings";
import { productionVectorStore } from "~/server/semantic/vector-store";
import { countAwaitingWork } from "~/server/services/awaiting-work.service";
import {
  claimCatchUp,
  discoverPurchases,
  recoverMissedWork,
} from "~/server/services/catch-up.service";
import { withTrace } from "~/server/tracing";

const scheduledLog = createLogger("scheduled");

export async function runDailyMaintenance(env: Env) {
  try {
    await withRequestDbClient(env.HYPERDRIVE.connectionString, async () => {
      const claimedAt = new Date();
      if (await claimCatchUp(db, claimedAt)) {
        const jobs = await Promise.allSettled([
          withTrace("cf.scheduled.job", () => recoverMissedWork(db), {
            "cubby.scheduled.job": "recover-missed-work",
          }),
          withTrace("cf.scheduled.job", () => discoverPurchases(db), {
            "cubby.scheduled.job": "purchase-discovery",
          }),
        ]);
        for (const job of jobs)
          if (job.status === "rejected") Sentry.captureException(job.reason);
      }
    });
  } catch (error) {
    Sentry.captureException(error);
  }
  try {
    await withTrace(
      "cf.scheduled.job",
      async () =>
        await (
          await calendarFeedStateFor(env.APP_ORIGIN)
        ).refreshNow("cron.daily"),
      { "cubby.scheduled.job": "calendar-feed" },
    );
  } catch (error) {
    // Calendar keeps serving its previous atomic snapshot. Keep the
    // independent assertion below running while surfacing the failure
    // through both the errored child span and Sentry.
    Sentry.captureException(error);
  }
  // The clock is a legitimate input for the calendar above. This job is
  // not a repair: it only reads the markers that "Settle now" acts on
  // and reports when they are non-zero, which is the evidence that a
  // wakeup was lost — the cue to look, not a sweep that would hide it.
  // (The vector-reconcile job below IS a repair — see its comment.)
  try {
    await withRequestDbClient(env.HYPERDRIVE.connectionString, () =>
      withTrace(
        "cf.scheduled.job",
        async (span) => {
          try {
            const awaiting = await countAwaitingWork(db);
            span.setAttributes({
              "cubby.awaiting.stale_recipe_totals": awaiting.staleRecipeTotals,
              "cubby.awaiting.unembedded_entities": awaiting.unembeddedEntities,
              "cubby.awaiting.pending_uploads": awaiting.pendingUploads,
            });
            scheduledLog.info("awaiting work", awaiting);
            if (
              awaiting.staleRecipeTotals > 0 ||
              awaiting.unembeddedEntities > 0 ||
              awaiting.pendingUploads > 0
            ) {
              Sentry.captureMessage(
                `Derived work is waiting: ${awaiting.staleRecipeTotals} stale recipe totals, ${awaiting.unembeddedEntities} unembedded entities, ${awaiting.pendingUploads} pending uploads`,
                "warning",
              );
            }
          } catch (error) {
            span.setError("Awaiting-work assertion failed");
            Sentry.captureException(error);
          }
        },
        { "cubby.scheduled.job": "awaiting-work-assertion" },
      ),
    );
  } catch (error) {
    Sentry.captureException(error);
  }
  // This job IS a repair, unlike the assert-only sibling above:
  // Vectorize cannot join the Postgres transaction that soft-deletes
  // `SearchDocument`/`EntityEmbedding` (`softDeleteEntitySearchArtifactsTx`),
  // so a removed entity's vector otherwise lingers in Vectorize forever.
  // `deleteByIds` is idempotent, so re-running or overlapping passes
  // over the same refs are safe.
  try {
    await withTrace(
      "cf.scheduled.job",
      async (span) => {
        if (!semanticEmbeddingsConfigured()) {
          span.setAttribute("cubby.vectorReconcile.skipped", true);
          return;
        }
        await withRequestDbClient(env.HYPERDRIVE.connectionString, async () => {
          const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          let cursor: SearchDocumentCursor | undefined;
          let deletedCount = 0;
          do {
            const page = await selectRecentlySoftDeletedSearchRefs(db, {
              since,
              cursor,
            });
            if (page.refs.length > 0) {
              await productionVectorStore.deleteByIds(page.refs);
              deletedCount += page.refs.length;
            }
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          span.setAttribute("cubby.vectorReconcile.deletedCount", deletedCount);
        });
      },
      { "cubby.scheduled.job": "vector-reconcile" },
    );
  } catch (error) {
    // Mirror the calendar job above: report and move on rather than
    // failing the whole scheduled invocation over one job.
    Sentry.captureException(error);
  }
}
