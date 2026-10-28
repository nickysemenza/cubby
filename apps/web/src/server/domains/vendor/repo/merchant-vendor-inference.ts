import { type FinancialTransactionRawOut as RawFinancialTransactionOut } from "@cubby/schemas/entity-contracts/financialTransaction";
import {
  financialTransactionSettlementViolation,
  type MerchantVendorCandidate,
  type MerchantVendorInference,
  merchantVendorInference,
  purchaseSettlementKinds,
} from "@cubby/schemas/financial-transaction";
import {
  parseEntityId,
  parseShortcodeFor,
  type VendorId,
} from "@cubby/schemas/identifiers";
import { sql, type SQL } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { possibleVendorLabel } from "~/server/entity-kernel/repo/detail-display-labels";

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
  return merchantVendorInference.parse({
    status: "suggested",
    candidates,
  });
};

/** One confirmed Vendor identifies the label; conflicting history stays unresolved. */
export const suggestedMerchantVendorCandidatesSql = (keys: SQL): SQL => sql`
  SELECT candidates.* FROM (
    SELECT history.*, count(*) OVER (PARTITION BY "merchantKey") AS "candidateCount"
    FROM (${merchantVendorCandidatesSql(keys)}) history
  ) candidates
  WHERE "candidateCount" = 1`;

/** Shared history query for advisory labels and batched display-image fallbacks. */
function merchantVendorCandidatesSql(keys?: SQL): SQL {
  const settlementKinds = sql.join(
    purchaseSettlementKinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
  return sql`
    WITH transaction_vendor AS (
      SELECT
        ft.id AS "transactionId",
        btrim(regexp_replace(lower(ft.merchant), '\\s+', ' ', 'g')) AS "merchantKey",
        v.id::text AS "vendorId",
        v.shortcode AS "vendorShortcode",
        v.name AS "vendorName",
        max(COALESCE(ft."postedDate", ft."transactionDate")) AS "lastSeenDate"
      FROM "FinancialTransaction" ft
      JOIN "FinancialTransactionAllocation" fta
        ON fta."transactionId" = ft.id AND ${notDeleted("fta")}
      JOIN "Purchase" p
        ON p.id = fta."purchaseId" AND ${notDeleted("p")}
      JOIN "Vendor" v
        ON v.id = p."vendorId" AND ${notDeleted("v")}
      WHERE ${notDeleted("ft")}
        AND ft.status <> 'void'
        AND ft."ledgerTransferId" IS NULL
        AND ft.kind IN (${settlementKinds})
        AND ft.merchant IS NOT NULL
        AND btrim(regexp_replace(lower(ft.merchant), '\\s+', ' ', 'g')) <> ''
        ${keys ? sql`AND btrim(regexp_replace(lower(ft.merchant), '\\s+', ' ', 'g')) IN (${keys})` : sql``}
      GROUP BY ft.id, btrim(regexp_replace(lower(ft.merchant), '\\s+', ' ', 'g')), v.id, v.shortcode, v.name
      HAVING bool_or(fta."confirmsMerchant")
    )
    SELECT
      "merchantKey",
      "vendorId",
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
  `;
}

/** Batch the derived statement labels for the requested Vendor page. */
export async function vendorStatementLabels(
  db: Database | DrizzleTransaction,
  ids: readonly VendorId[],
): Promise<Map<VendorId, string[]>> {
  if (ids.length === 0) return new Map();
  const rows = await unwrapDb(db).execute<{
    vendorId: string;
    labels: string[];
  }>(sql`
    SELECT "vendorId", array_agg(DISTINCT "merchantKey" ORDER BY "merchantKey") AS labels
    FROM (${merchantVendorCandidatesSql()}) history
    WHERE "vendorId" IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
    GROUP BY "vendorId"
  `);
  return new Map(
    rows.rows.map((row) => [parseEntityId("vendor", row.vendorId), row.labels]),
  );
}

/** Independent order proof may settle an unknown label, but cannot contradict history. */
export const merchantVendorAllowsSettlementSql = (
  merchant: SQL,
  vendorId: VendorId,
): SQL => sql`
  NOT EXISTS (
    SELECT 1 FROM (${merchantVendorCandidatesSql(sql`btrim(regexp_replace(lower(${merchant}), '\\s+', ' ', 'g'))`)}) history
    WHERE "vendorId" <> ${vendorId}
  )`;

/**
 * Load advisory Vendor evidence for a whole page in one query.
 *
 * Several confirmed allocations to Purchases from the same Vendor remain one
 * vote per transaction. A split across Vendors retains each confirmed Vendor,
 * so that label stays ambiguous rather than silently losing its evidence.
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
  const queried = await unwrapDb(db).execute<CandidateRow>(
    merchantVendorCandidatesSql(keys),
  );

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

type VendorInferenceTransaction = Pick<
  RawFinancialTransactionOut,
  "id" | "kind" | "amount" | "status" | "merchant"
> & { allocations: readonly unknown[]; ledgerTransferId: string | null };

const eligibleFinancialTransaction = (
  transaction: VendorInferenceTransaction,
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

export async function enrichFinancialTransactionVendorRead<
  T extends VendorInferenceTransaction,
>(db: Database | DrizzleTransaction, transactions: readonly T[]) {
  const eligible = transactions.filter(eligibleFinancialTransaction);
  const inferences = await merchantVendorInferences(
    db,
    eligible.flatMap((transaction) =>
      transaction.merchant === null ? [] : [transaction.merchant],
    ),
  );
  const eligibleIds = new Set(eligible.map((transaction) => transaction.id));
  return transactions.map((transaction) => {
    const vendorInference =
      eligibleIds.has(transaction.id) && transaction.merchant !== null
        ? (inferences.get(normalizeMerchant(transaction.merchant)) ??
          noInference())
        : null;
    return {
      ...transaction,
      vendorInference,
      possibleVendorLabel: possibleVendorLabel(vendorInference),
    };
  });
}
