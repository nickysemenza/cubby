import { createLogger } from "@cubby/worker-tracing";
import * as Sentry from "@sentry/tanstackstart-react";

import { publishBackgroundTasks } from "~/server/background-tasks/publish";
import {
  getPurchaseImportRunAgentNamespace,
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
    { expireStaleRuns },
    { reconcileWorkflowRuns },
    { pruneRoutineRuns },
    { retireSettledCoordinators },
  ] = await Promise.all([
    import("~/server/repo/image-processing-maintenance"),
    import("~/server/purchase-import/run-service"),
    import("~/server/workflow-runs/lifecycle"),
    import("~/server/purchase-import/gmail/discovery"),
    import("~/server/purchase-import/run-retirement"),
  ]);
  const coordinators = getPurchaseImportRunAgentNamespace();
  const [image, staleResult, workflowResult, pruneResult, retireResult] =
    await Promise.allSettled([
      repairImageProcessingWork(db),
      expireStaleRuns(db),
      reconcileWorkflowRuns(db),
      pruneRoutineRuns(db),
      // A settled agent Run's transcript (including Email text it read) is
      // destroyed after a day, leaving time to read the conversation.
      coordinators
        ? retireSettledCoordinators(
            db,
            (agentId) => coordinators.getByName(agentId),
            new Date(Date.now() - 24 * 60 * 60_000),
          )
        : isCloudflareRuntime()
          ? Promise.reject(
              new Error("PURCHASE_IMPORT_RUN binding is unavailable"),
            )
          : Promise.resolve(null),
    ]);
  const errors = [image, staleResult, workflowResult, pruneResult, retireResult]
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason));
  const stale = staleResult.status === "fulfilled" ? staleResult.value : null;
  log.info("purchase runs expired", {
    staleExpired: stale?.expired,
    staleFailures: stale?.failures.length,
    workflowRunsFailed:
      workflowResult.status === "fulfilled" ? workflowResult.value : null,
    routineRunsPruned:
      pruneResult.status === "fulfilled" ? pruneResult.value : null,
    coordinatorsRetired:
      retireResult.status === "fulfilled" ? retireResult.value?.retired : null,
  });
  for (const failure of stale?.failures ?? [])
    Sentry.captureMessage(
      `Stale purchase run could not be moved to review: ${failure.error}`,
      "warning",
    );
  if (errors.length) throw new Error(errors.join("; "));
  return { stale };
}

/**
 * Start one Gmail discovery Workflow per connected mailbox; Mail import Runs
 * follow from discovery. Product research is never started here: it is a
 * member's Burn-down (ADR 0008).
 */
export async function discoverPurchases(db: Database) {
  const [
    { startMailDiscovery },
    { gmailOAuthConfigured },
    { reconcileWorkflowRuns },
  ] = await Promise.all([
    import("~/server/purchase-import/gmail/discovery"),
    import("~/server/purchase-import/gmail/provider"),
    import("~/server/workflow-runs/lifecycle"),
  ]);
  if (!gmailOAuthConfigured()) {
    log.info("Gmail discovery skipped: Google OAuth is not configured");
    return { mail: null };
  }
  // Fail a stranded pass first: recovery runs concurrently, and a stranded
  // `running` Run would otherwise hold its mailbox's slot until the next
  // trigger.
  await reconcileWorkflowRuns(db);
  const mail = await startMailDiscovery(db);
  log.info("purchase discovery", {
    mailPassesStarted: mail.started,
    mailPassesRunning: mail.running,
  });
  return { mail };
}
