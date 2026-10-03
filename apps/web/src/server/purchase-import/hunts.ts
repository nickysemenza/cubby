import type { ActorContext } from "@cubby/schemas/context";
import type { LedgerPartyId } from "@cubby/schemas/identifiers";
import { vendorAccountId } from "@cubby/schemas/identifiers";
import {
  confirmMerchantVendorRuleInput,
  confirmMerchantVendorRuleOut,
  type ConfirmMerchantVendorRuleInput,
} from "@cubby/schemas/purchase-import";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { shiftPlainDate } from "~/lib/plain-date";
import type { Database } from "~/server/db";
import {
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  importHunt,
  merchantVendorRule,
  run as runTable,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { currentMemberLedgerParty } from "~/server/repo/member-login";
import { routedChargeEvidenceExpectationSql } from "~/server/repo/purchase-evidence-policy";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import {
  MAIL_MATCHABLE_HUNT_STATES,
  notOwnedByUnfinishedChargeRun,
} from "./charge-hunt-state";
import { dispatchRunEvent } from "./dispatch";
import { matchProcessedOrderMail } from "./gmail/match";
import { settleRetainedPaymentEvidence } from "./retained-settlement";
import {
  ACTIVE_RUN_STATUSES,
  ActiveChargeRunError,
  startOrResumeRun,
} from "./run-service";

const normalizeMerchant = (value: string) =>
  value.trim().toLowerCase().replaceAll(/\s+/g, " ");

export async function confirmMerchantVendorRule(
  db: Database,
  rawInput: ConfirmMerchantVendorRuleInput,
  actor: ActorContext,
) {
  const input = confirmMerchantVendorRuleInput.parse(rawInput);
  const party = await currentMemberLedgerParty(db, actor);
  if (!party) throw new Error("Member identity is not configured.");
  const vendorId = await resolveOrThrow(db, "vendor", input.vendorId);
  const normalizedMerchant = normalizeMerchant(input.merchant);
  await getDb(db)
    .insert(merchantVendorRule)
    .values({
      ledgerPartyId: party.id,
      normalizedMerchant,
      vendorId,
      confirmedByUserId: actor.userId,
    })
    .onConflictDoUpdate({
      target: [
        merchantVendorRule.ledgerPartyId,
        merchantVendorRule.normalizedMerchant,
      ],
      set: { vendorId, confirmedByUserId: actor.userId, updatedAt: new Date() },
    });
  return confirmMerchantVendorRuleOut.parse({
    normalizedMerchant,
    vendorId: input.vendorId,
  });
}

/** Create replay-safe work from confirmed merchant routing; no fuzzy vendor guess is persisted. */
/** A member's confirmed merchant routing, plus every vendor it may route to. */
export async function listMerchantVendorRules(
  db: Database,
  ledgerPartyId: LedgerPartyId,
) {
  const [rules, vendors] = await Promise.all([
    getDb(db)
      .select({
        merchant: merchantVendorRule.normalizedMerchant,
        vendorId: vendor.shortcode,
        vendorName: vendor.name,
      })
      .from(merchantVendorRule)
      .innerJoin(
        vendor,
        and(eq(vendor.id, merchantVendorRule.vendorId), notDeleted(vendor)),
      )
      .where(eq(merchantVendorRule.ledgerPartyId, ledgerPartyId))
      .orderBy(asc(merchantVendorRule.normalizedMerchant)),
    getDb(db)
      .select({ shortcode: vendor.shortcode, name: vendor.name })
      .from(vendor)
      .where(notDeleted(vendor))
      .orderBy(asc(vendor.name)),
  ]);
  return { rules, vendors };
}

/**
 * Open a hunt for each unallocated, vendor-routed charge whose resolved
 * `evidenceExpectation` wants evidence. The vendor's `orderEvidence` only
 * chooses where discovery looks first; it never suppresses a required hunt.
 */
export async function discoverImportHunts(db: Database): Promise<number> {
  // Retained order evidence settles first: a charge that a Purchase's own
  // payment lines uniquely explain needs no hunt.
  await settleRetainedPaymentEvidence(db);
  const database = getDb(db);
  const expectation = routedChargeEvidenceExpectationSql(
    "FinancialTransaction",
    sql`${vendor.evidenceExpectation}`,
  );
  const rows = await database
    .select({
      financialTransactionId: financialTransaction.id,
      ledgerPartyId: financialAccount.ledgerPartyId,
      amount: financialTransaction.amount,
      transactionDate: financialTransaction.transactionDate,
      vendorId: vendor.id,
      vendorAccountId: vendorAccount.id,
      orderEvidence: vendor.orderEvidence,
    })
    .from(financialTransaction)
    .innerJoin(
      financialAccount,
      and(
        eq(financialAccount.id, financialTransaction.accountId),
        notDeleted(financialAccount),
      ),
    )
    .innerJoin(
      merchantVendorRule,
      and(
        eq(merchantVendorRule.ledgerPartyId, financialAccount.ledgerPartyId),
        eq(
          merchantVendorRule.normalizedMerchant,
          sql<string>`lower(regexp_replace(trim(${financialTransaction.merchant}), '\\s+', ' ', 'g'))`,
        ),
      ),
    )
    .innerJoin(
      vendor,
      and(eq(vendor.id, merchantVendorRule.vendorId), notDeleted(vendor)),
    )
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.vendorId, vendor.id),
        eq(vendorAccount.ledgerPartyId, financialAccount.ledgerPartyId),
        notDeleted(vendorAccount),
      ),
    )
    .leftJoin(
      financialTransactionAllocation,
      and(
        eq(
          financialTransactionAllocation.transactionId,
          financialTransaction.id,
        ),
        notDeleted(financialTransactionAllocation),
      ),
    )
    .where(
      and(
        notDeleted(financialTransaction),
        isNull(financialTransactionAllocation.id),
        sql`(${expectation} = 'required'
          OR (${expectation} = 'unknown' AND ${vendor.orderEvidence} IS DISTINCT FROM 'not_expected'))`,
      ),
    );

  let created = 0;
  for (const row of rows) {
    if (!row.transactionDate || !row.ledgerPartyId) continue;
    const window = {
      dateFrom: shiftPlainDate(row.transactionDate, -7),
      dateTo: shiftPlainDate(row.transactionDate, 7),
    };
    const inserted = await database
      .insert(importHunt)
      .values({
        ledgerPartyId: row.ledgerPartyId,
        financialTransactionId: row.financialTransactionId,
        vendorId: row.vendorId,
        vendorAccountId: row.vendorAccountId,
        // Required evidence from a vendor classified as having no order trail
        // can only come from a human: surface it as the existing receipt
        // problem rather than skipping it or searching mail and browser.
        state:
          row.orderEvidence === "receipt_only" ||
          row.orderEvidence === "not_expected"
            ? "receipt_required"
            : "pending_mail",
        ...window,
      })
      .onConflictDoNothing()
      .returning({ id: importHunt.id, state: importHunt.state });
    created += inserted.length;
    // A hunt a selected run left deferred or not found may now be matched by
    // mail, unless an unfinished run still holds it.
    const [reopened] = inserted.length
      ? []
      : await database
          .select({ id: importHunt.id, state: importHunt.state })
          .from(importHunt)
          .where(
            and(
              eq(importHunt.financialTransactionId, row.financialTransactionId),
              inArray(importHunt.state, [...MAIL_MATCHABLE_HUNT_STATES]),
              notOwnedByUnfinishedChargeRun,
            ),
          );
    const [hunt] = inserted.length ? inserted : reopened ? [reopened] : [];
    // Order confirmations usually arrive days before the statement charge,
    // so mail processing found no hunt to resolve; match that mail now.
    if (
      !hunt ||
      !MAIL_MATCHABLE_HUNT_STATES.some((state) => state === hunt.state)
    )
      continue;
    const matchedOrderIds = await matchProcessedOrderMail(db, {
      ledgerPartyId: row.ledgerPartyId,
      vendorId: row.vendorId,
      amount: row.amount,
      ...window,
    });
    if (!matchedOrderIds) continue;
    await database
      .update(importHunt)
      .set({ state: "pending_browser", matchedOrderIds, updatedAt: new Date() })
      .where(
        and(
          eq(importHunt.id, hunt.id),
          inArray(importHunt.state, [...MAIL_MATCHABLE_HUNT_STATES]),
        ),
      );
  }
  return created;
}

/**
 * How long an unmatched `pending_mail` hunt waits for the hourly mail sync
 * before a browser run looks for its order. A hunt whose order id is already
 * known (`pending_browser`) dispatches immediately.
 */
export const MAIL_GRACE_MS = 24 * 60 * 60 * 1_000;

export async function dispatchImportHunts(
  db: Database,
  queue: PurchaseAgentQueueProducer,
  now = new Date(),
): Promise<number> {
  const database = getDb(db);
  const hunts = await database
    .select({
      id: importHunt.id,
      ledgerPartyId: importHunt.ledgerPartyId,
      vendorAccountId: importHunt.vendorAccountId,
      state: importHunt.state,
    })
    .from(importHunt)
    .innerJoin(
      vendor,
      and(eq(vendor.id, importHunt.vendorId), notDeleted(vendor)),
    )
    .innerJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, importHunt.vendorAccountId),
        eq(vendorAccount.status, "active"),
        eq(vendorAccount.browserSyncEnabled, true),
        notDeleted(vendorAccount),
      ),
    )
    .where(
      or(
        eq(importHunt.state, "pending_browser"),
        and(
          eq(importHunt.state, "pending_mail"),
          lte(importHunt.createdAt, new Date(now.getTime() - MAIL_GRACE_MS)),
        ),
      ),
    );
  // An account running a member's selected charges does only that: another
  // hunt must not join it, so it waits for the next implicit run.
  const selectedChargeAccounts = new Set<string | null>(
    (
      await database
        .select({ accountId: runTable.vendorAccountId })
        .from(runTable)
        .where(
          and(
            sql`${runTable.input}->>'kind' = 'charge_hunts'`,
            inArray(runTable.status, [...ACTIVE_RUN_STATUSES]),
          ),
        )
    ).map((row) => row.accountId),
  );
  let dispatched = 0;
  const runsByAccount = new Map<
    string,
    Awaited<ReturnType<typeof startOrResumeRun>>
  >();
  for (const hunt of hunts) {
    if (
      !hunt.vendorAccountId ||
      selectedChargeAccounts.has(hunt.vendorAccountId)
    )
      continue;
    let run = runsByAccount.get(hunt.vendorAccountId);
    if (!run) {
      try {
        run = await startOrResumeRun(db, {
          ledgerPartyId: hunt.ledgerPartyId,
          vendorAccountId: vendorAccountId.parse(hunt.vendorAccountId),
          trigger: "discovery",
        });
      } catch (error) {
        // A selected-charges run began after the read above: leave the hunt.
        if (!(error instanceof ActiveChargeRunError)) throw error;
        selectedChargeAccounts.add(hunt.vendorAccountId);
        continue;
      }
      runsByAccount.set(hunt.vendorAccountId, run);
      await dispatchRunEvent(db, queue, {
        version: 1,
        runId: run.id,
        eventId: run.created
          ? (run.dispatchEventId ?? crypto.randomUUID())
          : crypto.randomUUID(),
        type: run.created ? "start_or_resume" : "retry",
      });
    }
    await database
      .update(importHunt)
      .set({
        state: "browser_queued",
        attempts: sql`${importHunt.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(importHunt.id, hunt.id),
          inArray(importHunt.state, ["pending_browser", "pending_mail"]),
        ),
      );
    dispatched += 1;
  }
  return dispatched;
}
