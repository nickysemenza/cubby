import { createLogger } from "@cubby/worker-tracing";
import * as Sentry from "@sentry/tanstackstart-react";

import { publishBackgroundTasks } from "~/server/background-tasks/publish";
import {
  getPurchaseAgentQueue,
  getPurchaseImportNamespace,
  isCloudflareRuntime,
} from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  claimCatchUp,
  releaseCatchUpClaim,
} from "~/server/repo/catch-up-claim";

const log = createLogger("catch-up");

export { claimCatchUp } from "~/server/repo/catch-up-claim";

export async function requestCatchUp(
  db: Database,
): Promise<{ status: "queued" | "recent" }> {
  const claimedAt = new Date();
  if (!(await claimCatchUp(db, claimedAt))) return { status: "recent" };
  try {
    await publishBackgroundTasks(
      db,
      [
        { kind: "maintenance.recover", requestedAt: claimedAt.toISOString() },
        {
          kind: "maintenance.purchase-discovery",
          requestedAt: claimedAt.toISOString(),
        },
      ],
      { source: "maintenance.app-open" },
    );
  } catch (error) {
    await releaseCatchUpClaim(db, claimedAt);
    throw error;
  }
  return { status: "queued" };
}

export async function recoverMissedWork(db: Database) {
  const [
    { repairImageProcessingWork },
    { expireOfflineRuns, expireStaleRuns },
    { reconcileWorkflowRuns },
    { pruneRoutineRuns },
  ] = await Promise.all([
    import("~/server/repo/image-processing-maintenance"),
    import("~/server/purchase-import/run-service"),
    import("~/server/workflow-runs/lifecycle"),
    import("~/server/purchase-import/gmail/discovery"),
  ]);
  const namespace = getPurchaseImportNamespace();
  const [image, offlineResult, staleResult, workflowResult, pruneResult] =
    await Promise.allSettled([
      repairImageProcessingWork(db),
      expireOfflineRuns(db),
      namespace
        ? expireStaleRuns(db, namespace)
        : isCloudflareRuntime()
          ? Promise.reject(new Error("PURCHASE_IMPORT binding is unavailable"))
          : Promise.resolve(null),
      reconcileWorkflowRuns(db),
      pruneRoutineRuns(db),
    ]);
  const errors = [
    image,
    offlineResult,
    staleResult,
    workflowResult,
    pruneResult,
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
 * it goes to the browser, which covers the pass's lag.
 */
export async function discoverPurchases(db: Database) {
  const [
    { discoverImportHunts, dispatchImportHunts },
    { startMailDiscovery },
    { gmailOAuthConfigured },
    { reconcileWorkflowRuns },
  ] = await Promise.all([
    import("~/server/purchase-import/hunts"),
    import("~/server/purchase-import/gmail/discovery"),
    import("~/server/purchase-import/gmail/provider"),
    import("~/server/workflow-runs/lifecycle"),
  ]);
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
  const huntsCreated =
    huntResult.status === "fulfilled" ? huntResult.value : null;
  const mail = gmailResult.status === "fulfilled" ? gmailResult.value : null;
  const huntsDispatched =
    dispatchResult[0]?.status === "fulfilled" ? dispatchResult[0].value : 0;
  log.info("purchase discovery", {
    huntsCreated,
    huntsDispatched,
    mailPassesStarted: mail?.started,
    mailPassesRunning: mail?.running,
  });
  const errors = [huntResult, gmailResult, ...dispatchResult]
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason));
  if (errors.length) throw new Error(errors.join("; "));
  return { huntsCreated, huntsDispatched, mail };
}
