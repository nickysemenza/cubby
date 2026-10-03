import type { ActorContext } from "@cubby/schemas/context";
import {
  vendorAccountId as toVendorAccountId,
  type LedgerPartyId,
  type VendorAccountId,
} from "@cubby/schemas/identifiers";
import {
  chargeRunStartInput,
  chargeRunStartOut,
  vendorChargeHuntsInput,
  vendorChargeHuntsOut,
  type ChargeRunStartInput,
  type VendorChargeHuntsInput,
} from "@cubby/schemas/order-mail-review";
import {
  CHARGE_HUNT_STATE,
  chargeHuntOutcomeOf,
  chargeHuntRunInput,
} from "@cubby/schemas/run-fields";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  financialTransaction,
  importHunt,
  run as runTable,
  vendorAccount,
} from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { currentMemberLedgerParty } from "~/server/repo/member-login";

import { dispatchRunEvent } from "./dispatch";
import { startOrResumeRun } from "./run-service";

/** Hunt states a member may send to a browser search. */
const SEARCHABLE_STATES: ReadonlySet<string> = new Set([
  "pending_mail",
  "pending_browser",
  "exhausted",
  CHARGE_HUNT_STATE.deferred,
  CHARGE_HUNT_STATE.notFound,
]);

const RECEIPT_STATES: ReadonlySet<string> = new Set([
  "receipt_required",
  "processing_receipt",
  "receipt_failed",
]);

type RunOwner = { shortcode: string; status: string };

/**
 * Why a charge cannot be sent to a search now, or null when it can. A hunt on
 * an unfinished run keeps that run's outcome: restart the run instead of
 * starting a second one over the same evidence.
 */
function refusalFor(state: string, owner: RunOwner | undefined) {
  // Fresh mail evidence puts a charge back on the queue; whatever run once
  // parked it no longer decides its state.
  if (state === "pending_mail" || state === "pending_browser") return null;
  if (owner)
    return `Already on run ${owner.shortcode} (${owner.status}); use or restart that run.`;
  if (state === CHARGE_HUNT_STATE.queued)
    return "Already waiting on an import run.";
  if (RECEIPT_STATES.has(state))
    return "Needs a receipt photo rather than a browser search.";
  if (SEARCHABLE_STATES.has(state)) return null;
  return `Not searchable in state ${state}.`;
}

/** Account the member owns, or a refusal. */
async function ownedAccount(
  db: Database,
  actor: ActorContext,
  shortcode: string,
) {
  const party = await currentMemberLedgerParty(db, actor);
  if (!party) throw new Error("Member identity is not configured.");
  const [account] = await getDb(db)
    .select({
      id: vendorAccount.id,
      ledgerPartyId: vendorAccount.ledgerPartyId,
      browserSyncEnabled: vendorAccount.browserSyncEnabled,
    })
    .from(vendorAccount)
    .where(
      and(eq(vendorAccount.shortcode, shortcode), notDeleted(vendorAccount)),
    )
    .limit(1);
  if (!account || account.ledgerPartyId !== party.id)
    throw new Error("Vendor account was not found for this member.");
  return { accountId: toVendorAccountId.parse(account.id), party, account };
}

/**
 * Unfinished charge-search runs of one account and the hunts they own. A run a
 * restart superseded, and a completed or failed one, own nothing.
 */
async function huntOwners(db: Database, accountId: VendorAccountId) {
  const owners = new Map<string, RunOwner>();
  const database = getDb(db);
  const runs = await database
    .select({
      id: runTable.id,
      shortcode: runTable.shortcode,
      status: runTable.status,
      input: runTable.input,
    })
    .from(runTable)
    .where(
      and(
        eq(runTable.vendorAccountId, accountId),
        sql`${runTable.input}->>'kind' = 'charge_hunts'`,
        notInArray(runTable.status, ["completed", "failed"]),
      ),
    );
  if (runs.length === 0) return owners;
  const restarted = new Set(
    (
      await database
        .select({ predecessor: runTable.predecessorRunId })
        .from(runTable)
        .where(
          inArray(
            runTable.predecessorRunId,
            runs.map((run) => run.id),
          ),
        )
    ).map((successor) => successor.predecessor),
  );
  for (const run of runs) {
    if (restarted.has(run.id)) continue;
    const parsed = chargeHuntRunInput.safeParse(run.input);
    if (!parsed.success) continue;
    for (const huntId of parsed.data.huntIds)
      owners.set(huntId, { shortcode: run.shortcode, status: run.status });
  }
  return owners;
}

const hasAllocation = sql<boolean>`EXISTS (
  SELECT 1 FROM "FinancialTransactionAllocation" a
  WHERE a."transactionId" = ${importHunt.financialTransactionId}
    AND a."deletedAt" IS NULL
)`;

async function accountHunts(
  db: Database,
  account: { id: VendorAccountId; ledgerPartyId: LedgerPartyId },
) {
  return getDb(db)
    .select({
      id: importHunt.id,
      state: importHunt.state,
      transactionId: financialTransaction.shortcode,
      merchant: financialTransaction.merchant,
      amount: financialTransaction.amount,
      transactionDate: financialTransaction.transactionDate,
      settled: hasAllocation,
    })
    .from(importHunt)
    .innerJoin(
      financialTransaction,
      and(
        eq(financialTransaction.id, importHunt.financialTransactionId),
        notDeleted(financialTransaction),
      ),
    )
    .where(
      and(
        eq(importHunt.vendorAccountId, account.id),
        eq(importHunt.ledgerPartyId, account.ledgerPartyId),
      ),
    )
    .orderBy(
      asc(financialTransaction.transactionDate),
      asc(financialTransaction.shortcode),
    );
}

/** One member's open charge hunts on a Vendor account, with why each can or cannot be selected. */
export async function listChargeHunts(
  db: Database,
  rawInput: VendorChargeHuntsInput,
  actor: ActorContext,
) {
  const input = vendorChargeHuntsInput.parse(rawInput);
  const { accountId, party } = await ownedAccount(
    db,
    actor,
    input.vendorAccountId,
  );
  const [hunts, owners] = await Promise.all([
    accountHunts(db, { id: accountId, ledgerPartyId: party.id }),
    huntOwners(db, accountId),
  ]);
  const owned = new Map<string, RunOwner>(owners);
  return vendorChargeHuntsOut.parse({
    items: hunts
      // A settled charge or one the member dismissed has nothing to search.
      .filter(
        (hunt) =>
          !hunt.settled &&
          hunt.state !== CHARGE_HUNT_STATE.resolved &&
          hunt.state !== "dismissed",
      )
      .map((hunt) => {
        const fresh =
          hunt.state === "pending_mail" || hunt.state === "pending_browser";
        const owner = fresh ? undefined : owned.get(hunt.id);
        return {
          transactionId: hunt.transactionId,
          merchant: hunt.merchant,
          amount: hunt.amount,
          transactionDate: hunt.transactionDate,
          state: hunt.state,
          reason: refusalFor(hunt.state, owner),
          runId: owner?.shortcode ?? null,
          outcome: owner ? chargeHuntOutcomeOf(hunt.state) : null,
        };
      }),
  });
}

/**
 * One browser run over exactly the charges a member selected. Every selected
 * charge must be an open, unallocated, searchable hunt of this member's account
 * and on no other unfinished run, or the whole selection is refused with the
 * reason and nothing changes. The account holds one run at a time, so a busy
 * account refuses too (rather than the charges joining an implicit queue).
 */
export async function startSelectedChargeRun(
  db: Database,
  rawInput: ChargeRunStartInput,
  actor: ActorContext,
  queue: PurchaseAgentQueueProducer,
) {
  const input = chargeRunStartInput.parse(rawInput);
  if (new Set(input.transactionIds).size !== input.transactionIds.length)
    throw new Error("A charge was selected more than once.");
  const admitted = await withTransaction(db, async (tx) => {
    const txDb = databaseForTransaction(tx);
    const { accountId, party, account } = await ownedAccount(
      txDb,
      actor,
      input.vendorAccountId,
    );
    if (!account.browserSyncEnabled)
      throw new Error("Browser sync is not enabled for this Vendor account");
    // Serialize with run admission for this account (same key as
    // `startOrResumeRun`) so the checks below hold when the run is created.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${accountId}))`);
    const hunts = await tx
      .select({
        id: importHunt.id,
        state: importHunt.state,
        transactionId: financialTransaction.shortcode,
        transactionDate: financialTransaction.transactionDate,
        settled: hasAllocation,
      })
      .from(importHunt)
      .innerJoin(
        financialTransaction,
        and(
          eq(financialTransaction.id, importHunt.financialTransactionId),
          notDeleted(financialTransaction),
        ),
      )
      .where(
        and(
          eq(importHunt.vendorAccountId, accountId),
          eq(importHunt.ledgerPartyId, party.id),
          inArray(financialTransaction.shortcode, input.transactionIds),
        ),
      )
      .orderBy(asc(importHunt.id))
      .for("update", { of: importHunt });
    const byCharge = new Map(hunts.map((hunt) => [hunt.transactionId, hunt]));
    const owners = await huntOwners(txDb, accountId);
    for (const transactionId of input.transactionIds) {
      const hunt = byCharge.get(transactionId);
      if (!hunt)
        throw new Error(
          `Charge ${transactionId} has no open search on this Vendor account.`,
        );
      if (hunt.settled || hunt.state === CHARGE_HUNT_STATE.resolved)
        throw new Error(`Charge ${transactionId} is already settled.`);
      const refusal = refusalFor(hunt.state, owners.get(hunt.id));
      if (refusal) throw new Error(`Charge ${transactionId}: ${refusal}`);
    }
    // Search oldest charge first, as claims follow input order.
    const ordered = [...hunts].sort(
      (a, b) =>
        (a.transactionDate ?? "").localeCompare(b.transactionDate ?? "") ||
        a.transactionId.localeCompare(b.transactionId),
    );
    const run = await startOrResumeRun(txDb, {
      ledgerPartyId: party.id,
      vendorAccountId: accountId,
      trigger: "manual",
      chargeHuntIds: ordered.map((hunt) => hunt.id),
    });
    await tx
      .update(importHunt)
      .set({
        state: CHARGE_HUNT_STATE.queued,
        error: null,
        attempts: sql`${importHunt.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(
        inArray(
          importHunt.id,
          ordered.map((hunt) => hunt.id),
        ),
      );
    return run;
  });
  if (!admitted.dispatchEventId)
    throw new Error("Charge search has no dispatch generation.");
  await dispatchRunEvent(db, queue, {
    version: 1,
    runId: admitted.id,
    eventId: admitted.dispatchEventId,
    type: "start_or_resume",
  });
  return chargeRunStartOut.parse({ runId: admitted.publicId });
}
