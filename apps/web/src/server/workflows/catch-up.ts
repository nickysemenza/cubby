import { createLogger } from "@cubby/worker-tracing";

import {
  getPurchaseImportRunAgentNamespace,
  isCloudflareRuntime,
} from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  claimCatchUp,
  releaseCatchUpClaim,
} from "~/server/generic/work-queue/repo/catch-up-claim";
import { publishBackgroundTasks } from "~/server/workflows/background-tasks/publish";

const log = createLogger("catch-up");

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

/**
 * Resumes paused or lost Runs (AI work, step-ledger maintenance and Sweeps,
 * budget-paused imports). The backlog drains themselves belong
 * to the `maintenance` Run (`domains/maintenance/service/maintenance-run`), so
 * app open and the cron never run them twice.
 */
export async function recoverMissedWork(
  db: Database,
  coordinatorRetireBefore?: Date,
) {
  // Ended instances are marked failed before recovery, never only by the
  // maintenance Run, which may itself be the Run whose instance died.
  await (
    await import("~/server/workflows/runs/lifecycle")
  ).reconcileWorkflowRuns(db);
  await (
    await import("~/server/domains/run/service/ai-refresh")
  ).recoverAiRefresh(db);
  const aiWork = await import("~/server/domains/run/service/ai-work");
  await aiWork.recoverManualAiWork(db);
  await aiWork.resumeFundingPausedRuns(db);
  // Operator recovery with its own fixed cutoff; the nightly retirement is
  // a maintenance step.
  if (coordinatorRetireBefore)
    await retireCoordinators(db, coordinatorRetireBefore);
}

/** Expires stale import Runs, fails Workflow Runs whose instance ended, prunes routine history. */
export async function maintainRunHistory(db: Database) {
  const [{ expireStaleRuns }, { reconcileWorkflowRuns }, { pruneRoutineRuns }] =
    await Promise.all([
      import("~/server/domains/purchase-import/operations/run-review"),
      import("~/server/workflows/runs/lifecycle"),
      import("~/server/domains/purchase-import/operations/gmail/discovery"),
    ]);
  const stale = await expireStaleRuns(db);
  const reconciled = await reconcileWorkflowRuns(db);
  const pruned = await pruneRoutineRuns(db);
  return { ...stale, reconciled, pruned };
}

/**
 * A settled agent Run's transcript (including Email text it read) is
 * destroyed once it settled before `before`.
 */
export async function retireCoordinators(db: Database, before: Date) {
  const coordinators = getPurchaseImportRunAgentNamespace();
  if (!coordinators) {
    if (isCloudflareRuntime())
      throw new Error("PURCHASE_IMPORT_RUN binding is unavailable");
    return null;
  }
  const { retireSettledCoordinators } =
    await import("~/server/domains/purchase-import/repo/run-retirement");
  return retireSettledCoordinators(
    db,
    (agentId) => coordinators.getByName(agentId),
    before,
  );
}

/**
 * Start one Gmail discovery Workflow per connected mailbox; Mail import Runs
 * follow from discovery. Product research is never started here: it is a
 * member's Burn-down (ADR 0010).
 */
export async function discoverPurchases(db: Database) {
  const [
    { startMailDiscovery },
    { gmailOAuthConfigured },
    { reconcileWorkflowRuns },
  ] = await Promise.all([
    import("~/server/domains/purchase-import/operations/gmail/discovery"),
    import("~/server/domains/purchase-import/repo/gmail/provider"),
    import("~/server/workflows/runs/lifecycle"),
  ]);
  if (!gmailOAuthConfigured()) {
    log.info("Gmail discovery skipped: Google OAuth is not configured");
    return { mail: null };
  }
  // Fail a stranded pass first: recovery runs concurrently, and a stranded
  // `running` Run would otherwise hold its mailbox's slot until the next
  // trigger.
  await reconcileWorkflowRuns(db);
  const pending = await (
    await import("~/server/domains/purchase-import/repo/mail-import-run")
  ).importPendingEmails(db);
  const mail = await startMailDiscovery(db);
  log.info("purchase discovery", {
    mailPassesStarted: mail.started,
    mailPassesRunning: mail.running,
  });
  if (pending.errors.length)
    throw new AggregateError(
      pending.errors,
      "Retained Email admission failed; discovery continued.",
    );
  return { mail };
}
