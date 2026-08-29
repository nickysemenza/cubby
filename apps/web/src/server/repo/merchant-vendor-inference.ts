import {
  type FinancialTransactionOut,
  financialTransactionSettlementViolation,
  type MerchantVendorCandidate,
  type MerchantVendorInference,
  merchantVendorInference,
  purchaseSettlementKinds,
} from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/repo/database-helpers";

/** Lowercase, trim and collapse whitespace. Punctuation and words stay intact. */
export const normalizeMerchant = (merchant: string): string =>
  merchant.trim().replace(/\s+/g, " ").toLowerCase();

const noInference = (): MerchantVendorInference => ({
  status: "none",
  candidates: [],
});

type CandidateRow = {
  merchantKey: string;
  vendorShortcode: string;
  vendorName: string;
  supportingTransactionCount: number;
  lastSeenDate: string | null;
};

const inferenceFromCandidates = (
  candidates: MerchantVendorCandidate[],
): MerchantVendorInference => {
  if (candidates.length === 0) return noInference();
  if (candidates.length >= 2)
    return merchantVendorInference.parse({ status: "ambiguous", candidates });
  const [candidate] = candidates;
  return merchantVendorInference.parse({
    status:
      candidate!.supportingTransactionCount >= 2
        ? "suggested"
        : "insufficient_history",
    candidates,
  });
};

/**
 * Load advisory Vendor evidence for a whole page in one query.
 *
 * The first grouping deliberately collapses each historical transaction to one
 * Vendor. Several allocations to Purchases from that Vendor remain one vote;
 * a transaction spanning Vendors fails the HAVING clause and casts no vote.
 */
export async function merchantVendorInferences(
  db: Database | DrizzleTransaction,
  merchants: readonly string[],
): Promise<Map<string, MerchantVendorInference>> {
  const merchantKeys = [
    ...new Set(merchants.map(normalizeMerchant).filter(Boolean)),
  ];
  const result = new Map<string, MerchantVendorInference>();
  for (const key of merchantKeys) result.set(key, noInference());
  if (merchantKeys.length === 0) return result;

  const keys = sql.join(
    merchantKeys.map((key) => sql`${key}`),
    sql`, `,
  );
  const settlementKinds = sql.join(
    purchaseSettlementKinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const queried = await unwrapDb(db).execute<CandidateRow>(sql`
    WITH transaction_vendor AS (
      SELECT
        ft.id AS "transactionId",
        btrim(regexp_replace(lower(ft.merchant), '\\s+', ' ', 'g')) AS "merchantKey",
        min(v.id::text) AS "vendorId",
        min(v.shortcode) AS "vendorShortcode",
        min(v.name) AS "vendorName",
        max(COALESCE(ft."postedDate", ft."transactionDate")) AS "lastSeenDate"
      FROM "FinancialTransaction" ft
      JOIN "FinancialTransactionAllocation" fta
        ON fta."transactionId" = ft.id AND fta."deletedAt" IS NULL
      JOIN "Purchase" p
        ON p.id = fta."purchaseId" AND p."deletedAt" IS NULL
      JOIN "Vendor" v
        ON v.id = p."vendorId" AND v."deletedAt" IS NULL
      WHERE ft."deletedAt" IS NULL
        AND ft.status <> 'void'
        AND ft."ledgerTransferId" IS NULL
        AND ft.kind IN (${settlementKinds})
        AND ft.merchant IS NOT NULL
        AND btrim(regexp_replace(lower(ft.merchant), '\\s+', ' ', 'g')) IN (${keys})
      GROUP BY ft.id, btrim(regexp_replace(lower(ft.merchant), '\\s+', ' ', 'g'))
      HAVING count(DISTINCT v.id) = 1
    )
    SELECT
      "merchantKey",
      "vendorShortcode",
      "vendorName",
      count(DISTINCT "transactionId")::int AS "supportingTransactionCount",
      max("lastSeenDate") AS "lastSeenDate"
    FROM transaction_vendor
    GROUP BY "merchantKey", "vendorId", "vendorShortcode", "vendorName"
    ORDER BY
      "merchantKey" ASC,
      count(DISTINCT "transactionId") DESC,
      max("lastSeenDate") DESC NULLS LAST,
      "vendorName" ASC
  `);

  const candidatesByMerchant = new Map<string, MerchantVendorCandidate[]>();
  for (const row of queried.rows) {
    const candidates = candidatesByMerchant.get(row.merchantKey) ?? [];
    candidates.push({
      vendorId: parseShortcodeFor("vendor", row.vendorShortcode),
      vendorName: row.vendorName,
      supportingTransactionCount: Number(row.supportingTransactionCount),
      lastSeenDate: row.lastSeenDate,
    });
    candidatesByMerchant.set(row.merchantKey, candidates);
  }
  for (const key of merchantKeys)
    result.set(
      key,
      inferenceFromCandidates(candidatesByMerchant.get(key) ?? []),
    );
  return result;
}

export const merchantVendorInferenceFor = async (
  db: Database | DrizzleTransaction,
  merchant: string,
): Promise<MerchantVendorInference> =>
  (await merchantVendorInferences(db, [merchant])).get(
    normalizeMerchant(merchant),
  ) ?? noInference();

const eligibleFinancialTransaction = (
  transaction: FinancialTransactionOut,
): boolean =>
  transaction.allocations.length === 0 &&
  transaction.ledgerTransferId === null &&
  transaction.status !== "void" &&
  transaction.merchant !== null &&
  normalizeMerchant(transaction.merchant) !== "" &&
  financialTransactionSettlementViolation({
    linked: true,
    kind: transaction.kind,
    amount: transaction.amount,
  }) === null;

export async function enrichFinancialTransactionsWithVendorInference(
  db: Database | DrizzleTransaction,
  transactions: readonly FinancialTransactionOut[],
): Promise<FinancialTransactionOut[]> {
  const eligible = transactions.filter(eligibleFinancialTransaction);
  const inferences = await merchantVendorInferences(
    db,
    eligible.flatMap((transaction) =>
      transaction.merchant === null ? [] : [transaction.merchant],
    ),
  );
  const eligibleIds = new Set(eligible.map((transaction) => transaction.id));
  return transactions.map((transaction) => ({
    ...transaction,
    vendorInference:
      eligibleIds.has(transaction.id) && transaction.merchant !== null
        ? (inferences.get(normalizeMerchant(transaction.merchant)) ??
          noInference())
        : null,
  }));
}
