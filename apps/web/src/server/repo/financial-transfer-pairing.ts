import type {
  FinancialTransferPairSuggestionsOut,
  FundingPartyRef,
  SuggestFinancialTransferPairsInput,
} from "@cubby/schemas/household-contribution";
import {
  unsafeFinancialAccountShortcode,
  unsafeFinancialTransactionShortcode,
  unsafePersonShortcode,
} from "@cubby/schemas/identifiers";
import { and, asc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  financialAccount,
  financialTransaction,
  fundingSource,
  person,
} from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";

export type PairingRow = {
  id: string;
  shortcode: string;
  accountId: string;
  accountShortcode: string;
  amount: number;
  date: string | null;
  fundingParty: FundingPartyRef | null;
  /** False for a requested row that cannot itself be transfer evidence. */
  eligible?: boolean;
};

const cents = (value: number) => Math.round(value * 100);

const daysBetween = (a: string, b: string) =>
  Math.round(
    Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) /
      86_400_000,
  );

/**
 * Pure pairing policy shared by the DB read and its unit tests.
 *
 * A suggestion is deliberately only a candidate: equal-and-opposite evidence
 * can be two unrelated events, so this function never creates a transfer or
 * writes a FinancialTransaction kind. The reviewed ledger change owns that.
 */
export function buildFinancialTransferPairSuggestions(
  requested: readonly PairingRow[],
  candidates: readonly PairingRow[],
  input: Pick<
    SuggestFinancialTransferPairsInput,
    "maxCandidatesPerTransaction" | "maxDateDistanceDays"
  >,
): FinancialTransferPairSuggestionsOut["suggestions"] {
  return requested.map((transaction) => {
    const matches =
      transaction.date && transaction.eligible !== false
        ? candidates
            .filter((candidate) => {
              if (candidate.id === transaction.id || !candidate.date)
                return false;
              if (candidate.accountId === transaction.accountId) return false;
              if (cents(candidate.amount) !== -cents(transaction.amount))
                return false;
              return (
                daysBetween(transaction.date!, candidate.date) <=
                input.maxDateDistanceDays
              );
            })
            .map((candidate) => {
              const positive = transaction.amount > 0 ? transaction : candidate;
              const negative = transaction.amount > 0 ? candidate : transaction;
              return {
                transactionId: unsafeFinancialTransactionShortcode(
                  candidate.shortcode,
                ),
                amount: Math.abs(transaction.amount),
                dateDistanceDays: daysBetween(
                  transaction.date!,
                  candidate.date!,
                ),
                fromAccountId: unsafeFinancialAccountShortcode(
                  positive.accountShortcode,
                ),
                toAccountId: unsafeFinancialAccountShortcode(
                  negative.accountShortcode,
                ),
                from: positive.fundingParty,
                to: negative.fundingParty,
                reasons: [
                  "equal and opposite amount",
                  "posted within the requested date window",
                  "different financial accounts",
                ],
              };
            })
            .sort(
              (a, b) =>
                a.dateDistanceDays - b.dateDistanceDays ||
                a.transactionId.localeCompare(b.transactionId),
            )
        : [];
    const limited = matches.slice(0, input.maxCandidatesPerTransaction);
    return {
      transactionId: unsafeFinancialTransactionShortcode(transaction.shortcode),
      status:
        matches.length === 0
          ? "no_match"
          : matches.length === 1
            ? "proposed"
            : "ambiguous",
      candidates: limited,
    };
  });
}

const effectiveDate = sql<
  string | null
>`COALESCE(${financialTransaction.postedDate}, ${financialTransaction.transactionDate})`;

const noLiveAllocations = sql`NOT EXISTS (
  SELECT 1 FROM "FinancialTransactionAllocation" allocation
  WHERE allocation."transactionId" = ${financialTransaction.id}
    AND allocation."deletedAt" IS NULL
)`;

const noLiveTransferEvidence = sql`NOT EXISTS (
  SELECT 1 FROM "FundingTransferEvidence" evidence
  WHERE evidence."transactionId" = ${financialTransaction.id}
    AND evidence."deletedAt" IS NULL
)`;

const pairingColumns = {
  id: financialTransaction.id,
  shortcode: financialTransaction.shortcode,
  accountId: financialTransaction.accountId,
  accountShortcode: financialAccount.shortcode,
  amount: financialTransaction.amount,
  date: effectiveDate,
  sourceKind: fundingSource.kind,
  sourceFundKey: fundingSource.fundKey,
  personShortcode: person.shortcode,
  eligible: sql<boolean>`(${financialTransaction.status} = 'posted' AND ${noLiveAllocations} AND ${noLiveTransferEvidence})`,
} as const;

type DbPairingRow = {
  id: string;
  shortcode: string;
  accountId: string;
  accountShortcode: string;
  amount: number;
  date: string | null;
  sourceKind: "person" | "shared_fund" | null;
  sourceFundKey: string | null;
  personShortcode: string | null;
  eligible: boolean;
};

const toPairingRow = (row: DbPairingRow): PairingRow => {
  const fundingParty: FundingPartyRef | null =
    row.sourceKind === "person" && row.personShortcode
      ? { kind: "person", id: unsafePersonShortcode(row.personShortcode) }
      : row.sourceKind === "shared_fund" && row.sourceFundKey
        ? { kind: "fund", key: row.sourceFundKey }
        : null;
  return {
    id: row.id,
    shortcode: row.shortcode,
    accountId: row.accountId,
    accountShortcode: row.accountShortcode,
    amount: Number(row.amount),
    date: row.date,
    fundingParty,
    eligible: row.eligible,
  };
};

/**
 * Read-only candidate finder for two statement rows that may be the two legs
 * of a household transfer. Pairing remains a reviewed ledger write because
 * amount/date symmetry is useful evidence, never proof of intent.
 */
export async function suggestFinancialTransferPairs(
  db: Database,
  input: SuggestFinancialTransferPairsInput,
): Promise<FinancialTransferPairSuggestionsOut> {
  const requestedIds = await resolveAllOrThrow(
    db,
    "financialTransaction",
    input.transactionIds,
  );
  const selected = await unwrapDb(db)
    .select(pairingColumns)
    .from(financialTransaction)
    .innerJoin(
      financialAccount,
      eq(financialTransaction.accountId, financialAccount.id),
    )
    .leftJoin(
      fundingSource,
      and(
        eq(financialAccount.fundingSourceId, fundingSource.id),
        notDeleted(fundingSource),
      ),
    )
    .leftJoin(
      person,
      and(eq(fundingSource.personId, person.id), notDeleted(person)),
    )
    .where(
      and(
        inArray(financialTransaction.id, requestedIds),
        notDeleted(financialTransaction),
      ),
    )
    .orderBy(asc(financialTransaction.shortcode));

  const requested = selected.map(toPairingRow);
  const dated = requested.filter((row) => row.date !== null);
  if (dated.length === 0)
    return {
      suggestions: buildFinancialTransferPairSuggestions(requested, [], input),
    };

  const dates = dated.map((row) => row.date!).sort();
  const first = dates[0]!;
  const last = dates.at(-1)!;
  const dateStart = new Date(`${first}T00:00:00Z`);
  dateStart.setUTCDate(dateStart.getUTCDate() - input.maxDateDistanceDays);
  const dateEnd = new Date(`${last}T00:00:00Z`);
  dateEnd.setUTCDate(dateEnd.getUTCDate() + input.maxDateDistanceDays);
  const isoDate = (value: Date) => value.toISOString().slice(0, 10);
  const requestedAmounts = [
    ...new Set(dated.map((row) => Math.abs(cents(row.amount)))),
  ];

  const candidates = await unwrapDb(db)
    .select(pairingColumns)
    .from(financialTransaction)
    .innerJoin(
      financialAccount,
      eq(financialTransaction.accountId, financialAccount.id),
    )
    .leftJoin(
      fundingSource,
      and(
        eq(financialAccount.fundingSourceId, fundingSource.id),
        notDeleted(fundingSource),
      ),
    )
    .leftJoin(
      person,
      and(eq(fundingSource.personId, person.id), notDeleted(person)),
    )
    .where(
      and(
        notDeleted(financialTransaction),
        eq(financialTransaction.status, "posted"),
        gte(effectiveDate, isoDate(dateStart)),
        lte(effectiveDate, isoDate(dateEnd)),
        noLiveAllocations,
        noLiveTransferEvidence,
        or(
          ...requestedAmounts.map(
            (amount) =>
              sql`round(abs(${financialTransaction.amount})::numeric * 100)::bigint = ${amount}`,
          ),
        ),
      ),
    )
    .orderBy(asc(effectiveDate), asc(financialTransaction.shortcode));

  return {
    suggestions: buildFinancialTransferPairSuggestions(
      requested,
      candidates.map(toPairingRow),
      input,
    ),
  };
}
