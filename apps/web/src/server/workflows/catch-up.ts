import { systemActor } from "@cubby/schemas/context";
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

/** Bring stopped-execution reconciliation forward; Pass admission owns its wake. */
export async function recoverMissedWork(db: Database) {
  const { scheduleRunsReconcile } = await import("./runs/reconcile-pass");
  await scheduleRunsReconcile(db);
}

/** Expires stale import Runs and projects terminal Pass outcomes; every Run is kept. */
export async function maintainRunHistory(db: Database) {
  const [
    { expireStaleRuns },
    { reconcileRunPasses },
    { activeCoordinatorRuns },
  ] = await Promise.all([
    import("~/server/domains/purchase-import/operations/run-review"),
    import("~/server/workflows/runs/reconcile-pass"),
    import("~/server/domains/run/repo/coordinator-dispatch"),
  ]);
  const stale = await expireStaleRuns(db, new Date(), {
    exempt: await activeCoordinatorRuns(db),
  });
  const reconciled = await reconcileRunPasses(db);
  return { ...stale, reconciled };
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
 * Admit one Gmail discovery Pass per connected mailbox; Mail import Runs
 * follow from discovery. Product research is never started here: it is a
 * member's Burn-down (ADR 0010).
 */
export async function discoverPurchases(
  db: Database,
  options: {
    senderAfter?: { mailboxId: string; afterId: string } | null;
  } = {},
) {
  const [
    { startMailDiscovery },
    { gmailOAuthConfigured },
    { reconcileRunPasses },
  ] = await Promise.all([
    import("~/server/domains/purchase-import/operations/gmail/discovery"),
    import("~/server/domains/purchase-import/repo/gmail/provider"),
    import("~/server/workflows/runs/reconcile-pass"),
  ]);
  if (!gmailOAuthConfigured()) {
    log.info("Gmail discovery skipped: Google OAuth is not configured");
    return { mail: null, senderAfter: null, more: false };
  }
  // Project terminal execution before checking the mailbox admission slot.
  await reconcileRunPasses(db);
  const { learnAcceptedSenders } =
    await import("~/server/domains/purchase-import/repo/sender-attribution");
  const { readSenderAttributions } =
    await import("~/server/domains/purchase-import/repo/sender-attribution-read");
  const { withTransactionDatabase } = await import("~/server/db/helpers");
  const knownAttributions = await readSenderAttributions(db);
  const senders = await withTransactionDatabase(db, (tx) =>
    learnAcceptedSenders(tx, systemActor(), knownAttributions),
  );
  const pending = await (
    await import("~/server/domains/purchase-import/repo/mail-import-run")
  ).importPendingEmails(db, {
    knownAttributions,
    senderAfter: options.senderAfter,
  });
  const mail = await startMailDiscovery(db, { knownAttributions });
  log.info("purchase discovery", {
    mailPassesStarted: mail.started,
    mailPassesRunning: mail.running,
  });
  if (pending.errors.length)
    throw new AggregateError(
      pending.errors,
      "Retained Email admission failed; discovery continued.",
    );
  return {
    mail,
    senderAfter: pending.senderAfter ?? null,
    more: senders.more || Boolean(pending.senderAfter),
  };
}
