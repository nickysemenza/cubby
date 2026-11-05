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

const log = createLogger("catch-up");

export async function requestCatchUp(
  db: Database,
): Promise<{ status: "queued" | "recent" }> {
  const claimedAt = new Date();
  if (!(await claimCatchUp(db, claimedAt))) return { status: "recent" };
  try {
    await recoverMissedWork(db, undefined, { daily: false, wake: false });
    // A wake alone cannot discover new mail without a durable admission task.
    await (
      await import("~/server/workflows/background-tasks/publish")
    ).publishBackgroundTasks(
      db,
      [
        {
          kind: "maintenance.purchase-discovery",
          requestedAt: claimedAt.toISOString(),
        },
      ],
      { source: "app-open" },
    );
  } catch (error) {
    await releaseCatchUpClaim(db, claimedAt);
    throw error;
  }
  return { status: "queued" };
}

/** Admit periodic families and drain due Jobs; stopped work needs explicit retry. */
export async function recoverMissedWork(
  db: Database,
  coordinatorRetireBefore?: Date,
  { daily = true, wake = true }: { daily?: boolean; wake?: boolean } = {},
) {
  const obligations = await Promise.allSettled([
    (async () => {
      const { scheduleDerivedDiscovery } =
        await import("~/server/domains/run/service/derived-discovery");
      await scheduleDerivedDiscovery(db);
    })(),
    ...(daily
      ? [
          (async () => {
            const { enrollQueueMaintenance } =
              await import("~/server/workflows/job-maintenance");
            await enrollQueueMaintenance(db);
          })(),
        ]
      : []),
    (async () => {
      const { reconcileWorkflowRuns } =
        await import("~/server/workflows/runs/lifecycle");
      // Every bounded page is owed; don't stop after the first hundred Runs.
      let after: string | null = null;
      do {
        after = (await reconcileWorkflowRuns(db, after)).next;
      } while (after);
    })(),
  ]);
  if (wake || obligations.some((result) => result.status === "rejected"))
    await (
      await import("~/server/workflows/background-tasks/publish")
    ).wakeJobs({ source: daily ? "daily-recovery" : "app-open-recovery" });
  const errors = obligations.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(errors, "Background recovery failed");
  // Operator recovery with its own fixed cutoff; the nightly retirement is
  // a maintenance step.
  if (coordinatorRetireBefore)
    await retireCoordinators(db, coordinatorRetireBefore);
}

/** Expires stale import Runs and projects terminal Job outcomes; every Run is kept. */
export async function maintainRunHistory(db: Database) {
  const [{ expireStaleRuns }, { reconcileWorkflowRuns }] = await Promise.all([
    import("~/server/domains/purchase-import/operations/run-review"),
    import("~/server/workflows/runs/lifecycle"),
  ]);
  const stale = await expireStaleRuns(db);
  const reconciled = await reconcileWorkflowRuns(db);
  return { ...stale, reconciled: reconciled.reconciled };
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
 * Admit one Gmail discovery Job per connected mailbox; Mail import Runs
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
  // Project terminal execution before checking the mailbox admission slot.
  await reconcileWorkflowRuns(db);
  const { learnAcceptedSenders } =
    await import("~/server/domains/purchase-import/repo/sender-attribution");
  const { systemActor } = await import("~/server/domains/run/repo/ensure-run");
  const { withTransactionDatabase } = await import("~/server/db/helpers");
  const learned = await withTransactionDatabase(db, (tx) =>
    learnAcceptedSenders(tx, systemActor()),
  );
  const pending = await (
    await import("~/server/domains/purchase-import/repo/mail-import-run")
  ).importPendingEmails(db);
  if (learned === 50)
    await (
      await import("~/server/workflows/background-tasks/publish")
    ).publishBackgroundTasks(
      db,
      [
        {
          kind: "maintenance.purchase-discovery",
          requestedAt: new Date().toISOString(),
        },
      ],
      { source: "sender-attribution-continuation" },
    );
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
