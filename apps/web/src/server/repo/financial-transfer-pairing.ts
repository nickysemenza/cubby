import type {
  FinancialTransferPairSuggestionsOut,
  LedgerPartyRefOut,
  SuggestFinancialTransferPairsInput,
} from "@cubby/schemas/household-contribution";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  financialAccount,
  financialTransaction,
  ledgerParty,
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
  party: LedgerPartyRefOut | null;
  /** False for a requested row that cannot itself become transfer evidence. */
  eligible?: boolean;
};

const cents = (value: number) => Math.round(value * 100);

const daysBetween = (a: string, b: string) =>
  Math.round(
    Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) /
      86_400_000,
  );

/**
 * Read-only candidate policy. Equal and opposite statement rows are evidence,
 * not proof of intent, so callers must create the LedgerTransfer separately.
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
                transactionId: parseShortcodeFor(
                  "financialTransaction",
                  candidate.shortcode,
                ),
                amount: Math.abs(transaction.amount),
                dateDistanceDays: daysBetween(
                  transaction.date!,
                  candidate.date!,
                ),
                fromAccountId: parseShortcodeFor(
                  "financialAccount",
                  positive.accountShortcode,
                ),
                toAccountId: parseShortcodeFor(
                  "financialAccount",
                  negative.accountShortcode,
                ),
                from: positive.party,
                to: negative.party,
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
    return {
      transactionId: parseShortcodeFor(
        "financialTransaction",
        transaction.shortcode,
      ),
      status:
        matches.length === 0
          ? "no_match"
          : matches.length === 1
            ? "proposed"
            : "ambiguous",
      candidates: matches.slice(0, input.maxCandidatesPerTransaction),
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

const pairingColumns = {
  id: financialTransaction.id,
  shortcode: financialTransaction.shortcode,
  accountId: financialTransaction.accountId,
  accountShortcode: financialAccount.shortcode,
  amount: financialTransaction.amount,
  date: effectiveDate,
  partyShortcode: ledgerParty.shortcode,
  partyName: ledgerParty.name,
  partyKind: ledgerParty.kind,
  eligible: sql<boolean>`(${financialTransaction.status} = 'posted' AND ${noLiveAllocations} AND ${financialTransaction.ledgerTransferId} IS NULL)`,
} as const;

type DbPairingRow = {
  id: string;
  shortcode: string;
  accountId: string;
  accountShortcode: string;
  amount: number;
  date: string | null;
  partyShortcode: string | null;
  partyName: string | null;
  partyKind: LedgerPartyRefOut["kind"] | null;
  eligible: boolean;
};

const toPairingRow = (row: DbPairingRow): PairingRow => ({
  id: row.id,
  shortcode: row.shortcode,
  accountId: row.accountId,
  accountShortcode: row.accountShortcode,
  amount: Number(row.amount),
  date: row.date,
  party:
    row.partyShortcode && row.partyName && row.partyKind
      ? {
          id: parseShortcodeFor("ledgerParty", row.partyShortcode),
          name: row.partyName,
          kind: row.partyKind,
        }
      : null,
  eligible: row.eligible,
});

/** Finds, but never writes, compatible FinancialTransaction evidence legs. */
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
      ledgerParty,
      and(
        eq(financialAccount.ledgerPartyId, ledgerParty.id),
        notDeleted(ledgerParty),
      ),
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
  if (dated.length === 0) {
    const suggestions = buildFinancialTransferPairSuggestions(
      requested,
      [],
      input,
    );
    return { status: pairingStatus(suggestions), suggestions };
  }

  const dates = dated.map((row) => row.date!).sort();
  const dateStart = new Date(`${dates[0]}T00:00:00Z`);
  dateStart.setUTCDate(dateStart.getUTCDate() - input.maxDateDistanceDays);
  const dateEnd = new Date(`${dates.at(-1)}T00:00:00Z`);
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
      ledgerParty,
      and(
        eq(financialAccount.ledgerPartyId, ledgerParty.id),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        notDeleted(financialTransaction),
        eq(financialTransaction.status, "posted"),
        isNull(financialTransaction.ledgerTransferId),
        gte(effectiveDate, isoDate(dateStart)),
        lte(effectiveDate, isoDate(dateEnd)),
        noLiveAllocations,
        or(
          ...requestedAmounts.map(
            (amount) =>
              sql`round(abs(${financialTransaction.amount})::numeric * 100)::bigint = ${amount}`,
          ),
        ),
      ),
    )
    .orderBy(asc(effectiveDate), asc(financialTransaction.shortcode));

  const suggestions = buildFinancialTransferPairSuggestions(
    requested,
    candidates.map(toPairingRow),
    input,
  );
  return { status: pairingStatus(suggestions), suggestions };
}

const pairingStatus = (
  suggestions: FinancialTransferPairSuggestionsOut["suggestions"],
): FinancialTransferPairSuggestionsOut["status"] =>
  suggestions.some((suggestion) => suggestion.candidates.length > 1)
    ? "ambiguous"
    : suggestions.some((suggestion) => suggestion.candidates.length === 1)
      ? "proposed"
      : "no_match";
