import { createLogger } from "@cubby/worker-tracing";
import * as Sentry from "@sentry/tanstackstart-react";

import {
  getPurchaseAgentQueue,
  getPurchaseImportNamespace,
  isCloudflareRuntime,
} from "~/server/cf-env";
import type { Database } from "~/server/db";
import { sweepPendingEnrichment } from "~/server/purchase-import/enrichment-sweep";
import {
  pruneRoutineRuns,
  startMailDiscovery,
} from "~/server/purchase-import/gmail/discovery";
import { gmailOAuthConfigured } from "~/server/purchase-import/gmail/provider";
import {
  discoverImportHunts,
  dispatchImportHunts,
} from "~/server/purchase-import/hunts";
import { publishPendingResearchRetention } from "~/server/purchase-import/research-retention-delivery";
import {
  expireOfflineRuns,
  expireStaleRuns,
} from "~/server/purchase-import/run-service";
import { repairImageProcessingWork } from "~/server/repo/image-processing-maintenance";
import { reconcileWorkflowRuns } from "~/server/workflow-runs/lifecycle";

/**
 * The queue- and cron-run catch-up passes. The app-open request only queues
 * them (`app-open-catch-up.service.ts`).
 */
const log = createLogger("catch-up");

export { claimCatchUp } from "~/server/repo/catch-up-claim";

export async function recoverMissedWork(db: Database) {
  const namespace = getPurchaseImportNamespace();
  const [
    image,
    offlineResult,
    staleResult,
    workflowResult,
    pruneResult,
    retentionResult,
  ] = await Promise.allSettled([
    repairImageProcessingWork(db),
    expireOfflineRuns(db),
    namespace
      ? expireStaleRuns(db, namespace)
      : isCloudflareRuntime()
        ? Promise.reject(new Error("PURCHASE_IMPORT binding is unavailable"))
        : Promise.resolve(null),
    reconcileWorkflowRuns(db),
    pruneRoutineRuns(db),
    publishPendingResearchRetention(db),
  ]);
  const errors = [
    image,
    offlineResult,
    staleResult,
    workflowResult,
    pruneResult,
    retentionResult,
  ]
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason));
  const offline =
    offlineResult.status === "fulfilled" ? offlineResult.value : null;
  const stale = staleResult.status === "fulfilled" ? staleResult.value : null;
  log.info("purchase runs expired", {
    offlineExpired: offline?.expired,
    staleExpired: stale?.expired,
    staleFailures: stale?.failures.length,
    workflowRunsFailed:
      workflowResult.status === "fulfilled" ? workflowResult.value : null,
    routineRunsPruned:
      pruneResult.status === "fulfilled" ? pruneResult.value : null,
  });
  for (const failure of stale?.failures ?? [])
    Sentry.captureMessage(
      `Stale purchase run could not be moved to review: ${failure.error}`,
      "warning",
    );
  if (errors.length) throw new Error(errors.join("; "));
  return { offline, stale };
}

/**
 * Find new purchase evidence: open charge hunts, start one Gmail discovery
 * Workflow per connected mailbox, and dispatch browser hunts. Gmail work runs
 * in its Workflow, not here; a hunt waiting on mail has a grace period before
 * it goes to the browser, which covers the pass's lag. Then start enrichment
 * for imported Products an earlier pass left behind.
 */
export async function discoverPurchases(db: Database) {
  const gmailConfigured = gmailOAuthConfigured();
  if (!gmailConfigured)
    log.info("Gmail discovery skipped: Google OAuth is not configured");
  const [huntResult, gmailResult] = await Promise.allSettled([
    discoverImportHunts(db),
    gmailConfigured
      ? // Fail a stranded pass first: recovery runs concurrently, and a
        // stranded `running` Run would otherwise hold its mailbox's slot
        // until the next trigger.
        reconcileWorkflowRuns(db).then(() => startMailDiscovery(db))
      : Promise.resolve(null),
  ]);
  const queue = getPurchaseAgentQueue();
  const dispatchResult = await Promise.allSettled([
    queue
      ? dispatchImportHunts(db, queue)
      : isCloudflareRuntime()
        ? Promise.reject(
            new Error("PURCHASE_AGENT_QUEUE binding is unavailable"),
          )
        : Promise.resolve(0),
  ]);
  const [enrichmentResult] = await Promise.allSettled([
    sweepPendingEnrichment(db),
  ]);
  const huntsCreated =
    huntResult.status === "fulfilled" ? huntResult.value : null;
  const mail = gmailResult.status === "fulfilled" ? gmailResult.value : null;
  const huntsDispatched =
    dispatchResult[0]?.status === "fulfilled" ? dispatchResult[0].value : 0;
  const enrichment =
    enrichmentResult?.status === "fulfilled" ? enrichmentResult.value : null;
  log.info("purchase discovery", {
    huntsCreated,
    huntsDispatched,
    mailPassesStarted: mail?.started,
    mailPassesRunning: mail?.running,
    enrichmentRunsStarted: enrichment?.started.length,
  });
  const errors = [huntResult, gmailResult, ...dispatchResult, enrichmentResult]
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason));
  if (errors.length) throw new Error(errors.join("; "));
  return { huntsCreated, huntsDispatched, mail, enrichment };
}
