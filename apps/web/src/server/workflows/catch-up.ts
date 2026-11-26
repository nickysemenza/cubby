import { parseEntityId } from "@cubby/schemas/identifiers";
import { createLogger } from "@cubby/worker-tracing";
import { z } from "zod";

import {
  getPurchaseImportRunAgentNamespace,
  isCloudflareRuntime,
} from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  claimCatchUp,
  releaseCatchUpClaim,
} from "~/server/generic/work-queue/repo/catch-up-claim";
import {
  PassPageBudgetError,
  type Claim,
  type Json,
  type PassResult,
} from "~/server/kernel/api";

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

/** Advance over Shipment and Email UUIDs even when a page is ineligible. */
export async function discoverPurchases(
  db: Database,
  raw: Json | null,
  claim: Claim,
): Promise<PassResult> {
  const { gmailOAuthConfigured } =
    await import("~/server/domains/purchase-import/repo/gmail/provider");
  if (!gmailOAuthConfigured()) {
    log.info("Gmail discovery skipped: Google OAuth is not configured");
    return { cursor: raw, done: true };
  }
  const { importPendingEmails, retainedAdmissionCursor } =
    await import("~/server/domains/purchase-import/repo/mail-import-run");
  const cursor = z
    .object({
      emailAfter: z.uuid().nullable().default(null),
      shipmentAfter: z.uuid().nullable().default(null),
      retained: retainedAdmissionCursor.nullable().default(null),
    })
    .parse(raw ?? {});
  try {
    if (!cursor.emailAfter && !cursor.retained) {
      const { linkShipmentsByOrderIdPage } =
        await import("~/server/domains/shipment/repo/evidence");
      const shipmentAfter = await linkShipmentsByOrderIdPage(
        db,
        cursor.shipmentAfter
          ? parseEntityId("shipment", cursor.shipmentAfter)
          : null,
        claim,
      );
      if (shipmentAfter)
        return { cursor: { emailAfter: null, shipmentAfter }, done: false };
    }
    const pending = await importPendingEmails(db, {
      after: cursor.emailAfter,
      learnSenders: true,
      resume: cursor.retained,
      claim,
    });
    return {
      cursor: {
        emailAfter: pending.after,
        shipmentAfter: null,
        ...(pending.resume ? { retained: pending.resume } : {}),
      },
      done: !pending.after && !pending.resume,
      ...(pending.errors.length
        ? {
            itemError: new AggregateError(
              pending.errors,
              "Retained Email admission failed.",
            ),
          }
        : {}),
    };
  } catch (error) {
    if (!(error instanceof PassPageBudgetError)) throw error;
    return { cursor, done: false };
  }
}
