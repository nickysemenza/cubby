import {
  type FinancialAccountCardNumber,
  type FinancialAccountIdentity,
  financialAccountCardNumbers,
  financialAccountIdentity,
  financialAccountSourceAliases,
} from "@cubby/schemas/financial-account";
import {
  type FinancialStatementImportPreviewInput,
  type FinancialStatementImportPreviewOut,
  financialTransactionSourceRefs,
} from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, inArray, or, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database } from "~/server/db";
import { financialAccount, financialTransaction } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import {
  merchantVendorInferences,
  normalizeMerchant,
} from "~/server/repo/merchant-vendor-inference";
import { cents } from "~/server/repo/money";
import { statementRowExternalId } from "~/server/repo/statement-row-identity";

/**
 * Deliberately *not* the identity module's canonicalizer, despite being the
 * same two lines: this one only sniffs a descriptor for a network name or last
 * four, so it must stay free to change. Sharing it would let a
 * descriptor-matching tweak silently re-hash every stored source ref.
 */
const canonical = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

const networkFromDescriptor = (descriptor: string) => {
  const normalized = canonical(descriptor);
  if (normalized.includes("visa")) return "visa" as const;
  if (normalized.includes("mastercard")) return "mastercard" as const;
  if (normalized.includes("amex") || normalized.includes("american express"))
    return "amex" as const;
  if (normalized.includes("discover")) return "discover" as const;
  return null;
};

const last4FromDescriptor = (descriptor: string) => {
  const match = descriptor.match(/(\d{4})(?!.*\d)/);
  return match?.[1] ?? null;
};

const provisionalAccountFor = (
  row: FinancialStatementImportPreviewInput["rows"][number],
) => {
  const last4 = last4FromDescriptor(row.account);
  const network = networkFromDescriptor(row.account);
  const identity: FinancialAccountIdentity =
    last4 || network
      ? { kind: "credit_card", issuer: null, network: network ?? "other" }
      : { kind: "other", institution: null };
  // A statement labels the account with its current card, so the digits it
  // carries are the primary card as of today, not a dated historical one.
  const cardNumbers: FinancialAccountCardNumber[] = last4
    ? [{ last4, kind: "primary", validFrom: null, validTo: null, note: null }]
    : [];
  return {
    name: row.account.trim(),
    identity,
    cardNumbers,
    provisional: true as const,
    sourceAliases: [
      {
        source: row.source,
        alias: row.account.trim(),
        externalAccountId: null,
      },
    ],
  };
};

/**
 * Preview only: client-parsed rows become a decision worklist. It intentionally
 * does not create accounts/transactions or infer any Purchase link.
 */
export async function previewFinancialStatementImport(
  db: Database,
  input: FinancialStatementImportPreviewInput,
): Promise<FinancialStatementImportPreviewOut> {
  const sourceRefIds = await Promise.all(
    input.rows.map((row) => statementRowExternalId(row)),
  );
  const dates = uniq(input.rows.map((row) => row.date));
  // Containment rather than a `jsonb_array_elements` subquery, so the GIN index
  // on sourceRefs serves the probe instead of a per-ref sequential scan. One
  // clause per pair: a multi-element containment operand means "contains all of
  // these", not "any of these". The source comes from the row rather than a
  // literal, so a non-monarch export looks itself up rather than nothing.
  const sourceRefLookup = or(
    ...uniq(
      input.rows.map((row, index) =>
        JSON.stringify([
          { source: row.source, externalId: sourceRefIds[index]! },
        ]),
      ),
    ).map(
      (operand) => sql`${financialTransaction.sourceRefs} @> ${operand}::jsonb`,
    ),
  );
  const [accounts, transactions] = await Promise.all([
    unwrapDb(db)
      .select({
        id: financialAccount.id,
        shortcode: financialAccount.shortcode,
        name: financialAccount.name,
        identity: financialAccount.identity,
        sourceAliases: financialAccount.sourceAliases,
        cardNumbers: financialAccount.cardNumbers,
      })
      .from(financialAccount)
      .where(notDeleted(financialAccount)),
    unwrapDb(db)
      .select({
        id: financialTransaction.id,
        shortcode: financialTransaction.shortcode,
        accountId: financialTransaction.accountId,
        amount: financialTransaction.amount,
        postedDate: financialTransaction.postedDate,
        rawDescription: financialTransaction.rawDescription,
        sourceRefs: financialTransaction.sourceRefs,
      })
      .from(financialTransaction)
      .where(
        and(
          notDeleted(financialTransaction),
          // A source ref is global evidence and must survive a later posted-date
          // correction; the date predicate handles the normal batch efficiently.
          or(inArray(financialTransaction.postedDate, dates), sourceRefLookup),
        ),
      ),
  ]);

  const fingerprintCounts = new Map<string, number>();
  for (const ref of sourceRefIds)
    fingerprintCounts.set(ref, (fingerprintCounts.get(ref) ?? 0) + 1);

  const parsedAccounts = accounts.map((account) => ({
    ...account,
    identity: financialAccountIdentity.parse(account.identity),
    sourceAliases: financialAccountSourceAliases.parse(account.sourceAliases),
    cardNumbers: financialAccountCardNumbers.parse(account.cardNumbers),
  }));
  const parsedTransactions = transactions.map((transaction) => ({
    ...transaction,
    sourceRefs:
      financialTransactionSourceRefs.safeParse(transaction.sourceRefs).data ??
      [],
  }));

  const rows = input.rows.map((row, index) => {
    const externalId = sourceRefIds[index]!;
    const sourceRef = { source: row.source, externalId };
    const normalizedAmount = -row.amount;
    const kind = row.kind ?? (normalizedAmount > 0 ? "purchase" : "refund");
    const proposed = {
      sourceRef,
      amount: normalizedAmount,
      kind,
      status: "posted" as const,
      transactionDate: null,
      postedDate: row.date,
      merchant: row.merchant,
      rawDescription: row.originalStatement,
      sourceCategory: row.category,
      notes: row.notes,
    };
    const descriptor = canonical(row.account);
    const aliasMatches = parsedAccounts.filter((account) =>
      account.sourceAliases.some(
        (alias) =>
          alias.source === row.source && canonical(alias.alias) === descriptor,
      ),
    );
    const last4 = last4FromDescriptor(row.account);
    const network = networkFromDescriptor(row.account);
    const identityMatches =
      aliasMatches.length === 0 && last4
        ? parsedAccounts.filter((account) => {
            // Any card the account has carried, not just the current one: a
            // provider that froze an older label still names this account.
            const identity = account.identity;
            return (
              identity.kind === "credit_card" &&
              account.cardNumbers.some((card) => card.last4 === last4) &&
              (network === null || identity.network === network)
            );
          })
        : [];
    const accountMatches =
      aliasMatches.length > 0 ? aliasMatches : identityMatches;
    const account = accountMatches.length === 1 ? accountMatches[0] : null;
    const alreadyRecorded = parsedTransactions.filter((transaction) =>
      transaction.sourceRefs.some(
        (ref) =>
          ref.source === sourceRef.source &&
          ref.externalId === sourceRef.externalId,
      ),
    );
    const possibleExisting = account
      ? parsedTransactions.filter(
          (transaction) =>
            transaction.accountId === account.id &&
            cents(Number(transaction.amount)) === cents(normalizedAmount) &&
            transaction.postedDate === row.date,
        )
      : [];
    const existingTransactionIds = (
      alreadyRecorded.length ? alreadyRecorded : possibleExisting
    ).map((transaction) =>
      parseShortcodeFor("financialTransaction", transaction.shortcode),
    );
    const status: FinancialStatementImportPreviewOut["rows"][number]["status"] =
      (fingerprintCounts.get(externalId) ?? 0) > 1
        ? "indistinguishable_duplicate"
        : alreadyRecorded.length > 0
          ? "already_recorded"
          : !account
            ? "unresolved_account"
            : possibleExisting.length > 0
              ? "possible_existing"
              : "ready_to_create";

    return {
      key: row.key,
      status,
      accountId: account
        ? parseShortcodeFor("financialAccount", account.shortcode)
        : null,
      accountName: account?.name ?? null,
      provisionalAccount: account ? null : provisionalAccountFor(row),
      proposed,
      existingTransactionIds,
    };
  });

  const eligibleRows = rows.filter(
    (row) =>
      row.proposed.merchant &&
      (row.status === "ready_to_create" || row.status === "unresolved_account"),
  );
  const inferences = await merchantVendorInferences(
    db,
    eligibleRows.flatMap((row) =>
      row.proposed.merchant ? [row.proposed.merchant] : [],
    ),
  );
  const enrichedRows = rows.map((row) => ({
    ...row,
    vendorInference:
      row.proposed.merchant &&
      (row.status === "ready_to_create" || row.status === "unresolved_account")
        ? (inferences.get(normalizeMerchant(row.proposed.merchant)) ?? {
            status: "none" as const,
            candidates: [],
          })
        : null,
  }));
  const count = (status: (typeof rows)[number]["status"]) =>
    rows.filter((row) => row.status === status).length;
  return {
    rows: enrichedRows,
    summary: {
      rowsIn: rows.length,
      alreadyRecorded: count("already_recorded"),
      readyToCreate: count("ready_to_create"),
      possibleExisting: count("possible_existing"),
      unresolvedAccount: count("unresolved_account"),
      indistinguishableDuplicate: count("indistinguishable_duplicate"),
    },
  };
}
