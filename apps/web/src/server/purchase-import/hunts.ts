import type { ActorContext } from "@cubby/schemas/context";
import { browserBridgeRequest } from "@cubby/schemas/purchase-import";
import {
  confirmMerchantVendorRuleInput,
  confirmMerchantVendorRuleOut,
  type ConfirmMerchantVendorRuleInput,
} from "@cubby/schemas/purchase-import";
import { vendorAgentHints } from "@cubby/schemas/vendor-import-fields";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  importHunt,
  importRun,
  ledgerParty,
  merchantVendorRule,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

const normalizeMerchant = (value: string) =>
  value.trim().toLowerCase().replaceAll(/\s+/g, " ");

export async function confirmMerchantVendorRule(
  db: Database,
  rawInput: ConfirmMerchantVendorRuleInput,
  actor: ActorContext,
) {
  const input = confirmMerchantVendorRuleInput.parse(rawInput);
  const [party] = await getDb(db)
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .limit(1);
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

const shiftDate = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

/** Create replay-safe work from confirmed merchant routing; no fuzzy vendor guess is persisted. */
export async function discoverImportHunts(db: Database): Promise<number> {
  const database = getDb(db);
  const rows = await database
    .select({
      financialTransactionId: financialTransaction.id,
      ledgerPartyId: financialAccount.ledgerPartyId,
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
        sql`${vendor.orderEvidence} IS DISTINCT FROM 'not_expected'`,
      ),
    );

  let created = 0;
  for (const row of rows) {
    if (!row.transactionDate || !row.ledgerPartyId) continue;
    const inserted = await database
      .insert(importHunt)
      .values({
        ledgerPartyId: row.ledgerPartyId,
        financialTransactionId: row.financialTransactionId,
        vendorId: row.vendorId,
        vendorAccountId: row.vendorAccountId,
        state:
          row.orderEvidence === "receipt_only"
            ? "receipt_required"
            : "pending_mail",
        dateFrom: shiftDate(row.transactionDate, -7),
        dateTo: shiftDate(row.transactionDate, 7),
      })
      .onConflictDoNothing()
      .returning({ id: importHunt.id });
    created += inserted.length;
  }
  return created;
}

export async function dispatchImportHunts(
  db: Database,
  namespace: {
    getByName(name: string): {
      enqueue(
        command: ReturnType<typeof browserBridgeRequest.parse>,
      ): Promise<void>;
    };
  },
): Promise<number> {
  const database = getDb(db);
  const hunts = await database
    .select({
      id: importHunt.id,
      ledgerPartyId: importHunt.ledgerPartyId,
      vendorAccountId: importHunt.vendorAccountId,
      orderIds: importHunt.matchedOrderIds,
      state: importHunt.state,
      orderUrlTemplate: vendor.orderUrlTemplate,
      agentHints: vendor.agentHints,
      browserDomains: vendor.browserDomains,
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
        notDeleted(vendorAccount),
      ),
    )
    .where(inArray(importHunt.state, ["pending_browser", "pending_mail"]));
  const alreadyQueued = await database
    .select({ vendorAccountId: importHunt.vendorAccountId })
    .from(importHunt)
    .where(eq(importHunt.state, "browser_queued"));
  let dispatched = 0;
  const claimedAccounts = new Set(
    alreadyQueued.flatMap(({ vendorAccountId }) =>
      vendorAccountId ? [vendorAccountId] : [],
    ),
  );
  for (const hunt of hunts) {
    const orderId = hunt.orderIds[0];
    if (!hunt.vendorAccountId) continue;
    // A bridge is serialized per vendor account. Leave later hunts queued for the next cron
    // instead of letting one completion resolve unrelated work for the same login.
    if (claimedAccounts.has(hunt.vendorAccountId)) continue;
    claimedAccounts.add(hunt.vendorAccountId);
    const hints = vendorAgentHints.parse(hunt.agentHints);
    const url =
      orderId && hunt.orderUrlTemplate
        ? hunt.orderUrlTemplate
            .replaceAll("{orderId}", encodeURIComponent(orderId))
            .replaceAll("{order_id}", encodeURIComponent(orderId))
        : hints.ordersListUrl;
    if (!url) continue;
    const parsedUrl = new URL(url);
    const allowedHosts =
      hunt.browserDomains.length > 0
        ? hunt.browserDomains
        : [parsedUrl.hostname];
    const [run] = await database
      .insert(importRun)
      .values({
        ledgerPartyId: hunt.ledgerPartyId,
        vendorAccountId: hunt.vendorAccountId,
        trigger: "discovery",
      })
      .returning({ id: importRun.id });
    if (!run) continue;
    const command = browserBridgeRequest.parse({
      id: crypto.randomUUID(),
      runID: run.id,
      // Discovery may be queued while the owner's Mac is asleep. Keep the
      // read-only command replayable until the next weekly housekeeping pass.
      deadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      operation: { type: "navigate", url, allowedHosts },
    });
    await namespace.getByName(hunt.vendorAccountId).enqueue(command);
    await database
      .update(importHunt)
      .set({
        state: "browser_queued",
        attempts: sql`${importHunt.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(importHunt.id, hunt.id));
    dispatched += 1;
  }
  return dispatched;
}
