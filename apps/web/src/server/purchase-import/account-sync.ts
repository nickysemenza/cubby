import { buildActorContext } from "@cubby/schemas/context";
import type {
  LedgerPartyId,
  VendorAccountId,
} from "@cubby/schemas/identifiers";
import {
  syncPlanOutput,
  type SyncPlanInput,
  type SyncPlanAccount,
  type StartSyncInput,
} from "@cubby/schemas/run";
import { runWorkLabel } from "@cubby/schemas/run-fields";
import { vendorAccountCursor } from "@cubby/schemas/vendor-account-fields";
import { and, desc, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  ledgerParty,
  run as runTable,
  runProgress,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { loadVendorAccountRunActivity } from "~/server/repo/vendor-account";

import { dispatchRunEvent } from "./dispatch";
import { controlRun, startOrResumeRun } from "./run-service";
import {
  accountSyncEligibility,
  readAccountSyncAdmission,
} from "./sync-admission";

export async function loadSyncPlan(
  db: Database,
  partyId: LedgerPartyId,
  input: SyncPlanInput,
  bridge?: { connected(accountId: VendorAccountId): Promise<boolean> },
) {
  const client = getDb(db);
  const accounts = await client
    .select({
      id: vendorAccount.id,
      shortcode: vendorAccount.shortcode,
      label: vendorAccount.label,
      vendorName: vendor.name,
      cursor: vendorAccount.cursor,
      accountStatus: vendorAccount.status,
    })
    .from(vendorAccount)
    .innerJoin(
      vendor,
      and(eq(vendor.id, vendorAccount.vendorId), notDeleted(vendor)),
    )
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, vendorAccount.ledgerPartyId),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        eq(vendorAccount.ledgerPartyId, partyId),
        accountSyncEligibility(),
        input.vendorAccountId
          ? eq(vendorAccount.shortcode, input.vendorAccountId)
          : undefined,
      ),
    )
    .orderBy(vendorAccount.label, vendorAccount.shortcode);
  const activity = await loadVendorAccountRunActivity(
    db,
    accounts.map((account) => account.id),
  );
  return syncPlanOutput.parse({
    accounts: await Promise.all(
      accounts.map(async (account) => {
        const admission = await readAccountSyncAdmission(client, account.id);
        const since = vendorAccountCursor.parse(account.cursor).newestOrderAt;
        let action: SyncPlanAccount["action"];
        let line: string;
        let disabledReason: string | null = null;
        if (admission?.kind === "blocked") {
          action = {
            kind: "blocked",
            runId: admission.run.shortcode,
            purpose: admission.run.purpose,
          };
          const work = admission.isChargeSearch
            ? "a selected charge search"
            : runWorkLabel(admission.run).toLowerCase();
          line = `Finish or stop ${work} (${admission.run.shortcode}) before syncing.`;
          disabledReason = line;
        } else if (admission) {
          const [progress] = await client
            .select({ detail: runProgress.detail })
            .from(runProgress)
            .where(eq(runProgress.runId, admission.run.id))
            .orderBy(desc(runProgress.createdAt), desc(runProgress.id))
            .limit(1);
          const detail =
            progress?.detail ??
            admission.run.dispatchError ??
            admission.run.failureCode;
          action = {
            kind: "resume",
            runId: admission.run.shortcode,
            status: admission.run.status,
            detail,
          };
          line = `Resume ${admission.run.shortcode} (${admission.run.status})${detail ? `: ${detail}` : "."}`;
        } else if (since) {
          action = { kind: "start", since };
          line = `Check orders since ${since.slice(0, 10)}.`;
        } else {
          action = { kind: "firstSync" };
          line = "First sync: read available order history.";
        }
        return {
          shortcode: account.shortcode,
          label: account.label,
          vendorName: account.vendorName,
          accountStatus: account.accountStatus,
          connected: bridge ? await bridge.connected(account.id) : null,
          lastSuccessAt:
            activity.get(account.id)?.lastSuccessAt?.toISOString() ?? null,
          action,
          line,
          disabledReason,
        };
      }),
    ),
  });
}

export async function startAccountSync(
  db: Database,
  partyId: LedgerPartyId,
  input: StartSyncInput,
  queue: PurchaseAgentQueueProducer | null | undefined,
) {
  if (!queue) throw new Error("Purchase import agent unavailable");
  const accountId = await resolveOrThrow(
    db,
    "vendorAccount",
    input.vendorAccountId,
  );
  const run = await startOrResumeRun(db, {
    ledgerPartyId: partyId,
    vendorAccountId: accountId,
    ...(input.backfill
      ? { trigger: "backfill" as const, backfill: input.backfill }
      : { trigger: "manual" as const }),
  });
  if (!run.created) {
    const [current] = await getDb(db)
      .select({ status: runTable.status, actorUserId: runTable.actorUserId })
      .from(runTable)
      .where(and(eq(runTable.id, run.id), notDeleted(runTable)));
    if (!current) throw new Error("Account sync Run is no longer available");
    if (
      current.status === "paused_auth" ||
      current.status === "paused_offline"
    ) {
      if (!current.actorUserId)
        throw new Error("Account sync Run has no owning member actor");
      const resumed = await controlRun(
        db,
        buildActorContext(current.actorUserId),
        { runPublicId: run.publicId, action: "resume" },
      );
      if (!("dispatchEventId" in resumed) || !resumed.dispatchEventId)
        throw new Error(
          "Account sync resume did not admit a dispatch generation",
        );
      await dispatchRunEvent(db, queue, {
        version: 1,
        runId: run.id,
        eventId: resumed.dispatchEventId,
        type: "start_or_resume",
      });
      return { runId: run.publicId, resumed: true };
    }
  }
  await dispatchRunEvent(db, queue, {
    version: 1,
    runId: run.id,
    eventId: run.created
      ? (run.dispatchEventId ?? crypto.randomUUID())
      : crypto.randomUUID(),
    type: run.created ? "start_or_resume" : "retry",
  });
  return { runId: run.publicId, resumed: !run.created };
}
