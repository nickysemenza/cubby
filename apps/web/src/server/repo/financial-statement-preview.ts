import {
  type FinancialAccountCardNumber,
  type FinancialAccountIdentity,
  financialAccountCardNumbers,
  financialAccountIdentity,
  financialAccountSourceAliases,
} from "@cubby/schemas/financial-account";
import {
  type FinancialStatementImportPreviewInput,
  type FinancialStatementImportRow,
  type FinancialStatementImportPreviewOut,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, inArray, or, sql } from "drizzle-orm";
import { uniq, uniqBy } from "es-toolkit";

import type { Database } from "~/server/db";
import {
  financialAccount,
  financialTransaction,
  statementRow,
  statementImport,
} from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { settlementRefsFor } from "~/server/repo/entity-external-ids";
import {
  merchantVendorInferences,
  normalizeMerchant,
} from "~/server/repo/merchant-vendor-inference";
import { cents } from "~/server/repo/money";
import {
  statementRowExternalId,
  statementRowOccurrenceId,
} from "~/server/repo/statement-row-identity";

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
  const legacyIds = await Promise.all(
    input.rows.map((row) => statementRowExternalId(row)),
  );
  const sourceRefIds = await Promise.all(
    input.rows.map((row, index) =>
      row.importFingerprint && row.rowPosition !== undefined
        ? statementRowOccurrenceId(
            row.source,
            row.importFingerprint,
            row.rowPosition,
          )
        : legacyIds[index]!,
    ),
  );
  const dates = uniq(
    input.rows.flatMap((row) =>
      Array.from({ length: 7 }, (_, offset) => {
        const day = new Date(`${row.date}T00:00:00Z`);
        day.setUTCDate(day.getUTCDate() + offset - 3);
        return day.toISOString().slice(0, 10);
      }),
    ),
  );
  const providerPairs = input.rows.filter((row) => row.providerTransactionId);
  const observations = providerPairs.length
    ? await unwrapDb(db)
        .select({
          source: statementRow.source,
          providerTransactionId: statementRow.providerTransactionId,
          externalId: statementRow.externalId,
        })
        .from(statementRow)
        .where(
          and(
            notDeleted(statementRow),
            or(
              ...providerPairs.map((row) =>
                and(
                  sql`${statementRow.source} = ${row.source}`,
                  sql`${statementRow.providerTransactionId} = ${row.providerTransactionId}`,
                ),
              ),
            ),
          ),
        )
    : [];

  const fingerprints = uniq(
    input.rows.flatMap((row) =>
      row.importFingerprint ? [row.importFingerprint] : [],
    ),
  );
  const sameFileObservations = fingerprints.length
    ? await unwrapDb(db)
        .select({
          source: statementRow.source,
          externalId: statementRow.externalId,
          fingerprint: statementImport.fingerprint,
          rowPosition: statementRow.rowPosition,
        })
        .from(statementRow)
        .innerJoin(
          statementImport,
          sql`${statementRow.batchId} = ${statementImport.id}`,
        )
        .where(
          and(
            notDeleted(statementRow),
            notDeleted(statementImport),
            inArray(statementImport.fingerprint, fingerprints),
          ),
        )
    : [];
  // Transactions already holding one of these rows' settlement references,
  // probed on the live `(source, kind, externalId)` unique. The source comes
  // from the row rather than a literal, so a non-monarch export looks itself
  // up rather than nothing.
  const pairs = uniqBy(
    [
      ...input.rows.flatMap((row, index) => [
        { source: row.source, externalId: sourceRefIds[index]! },
        { source: row.source, externalId: legacyIds[index]! },
      ]),
      ...observations,
    ],
    (pair) => `${pair.source}\0${pair.externalId}`,
  );
  const sourceRefLookup =
    pairs.length === 0
      ? undefined
      : sql`EXISTS (
          SELECT 1 FROM "EntityExternalId" px
          WHERE px."entityId" = "FinancialTransaction"."id"
            AND px."kind" = 'settlement_ref' AND px."deletedAt" IS NULL
            AND (${sql.join(
              pairs.map(
                (pair) =>
                  sql`(px."source" = ${pair.source} AND px."externalId" = ${pair.externalId})`,
              ),
              sql` OR `,
            )})
        )`;
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
        transactionDate: financialTransaction.transactionDate,
        status: financialTransaction.status,
        merchant: financialTransaction.merchant,
        rawDescription: financialTransaction.rawDescription,
      })
      .from(financialTransaction)
      .where(
        and(
          notDeleted(financialTransaction),
          // A source ref is global evidence and must survive a later posted-date
          // correction; the date predicate handles the normal batch efficiently.
          or(
            inArray(financialTransaction.postedDate, dates),
            inArray(financialTransaction.transactionDate, dates),
            sourceRefLookup,
          ),
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
  const refsByTransaction = await settlementRefsFor(
    db,
    transactions.map((transaction) => transaction.id),
  );
  const parsedTransactions = transactions.map((transaction) => ({
    ...transaction,
    sourceRefs: refsByTransaction.get(transaction.id) ?? [],
  }));

  const accountFor = (row: FinancialStatementImportRow) => {
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
    return accountMatches.length === 1 ? accountMatches[0] : null;
  };
  const statusFor = (
    row: FinancialStatementImportRow,
    externalId: string,
    recorded: number,
    account: boolean,
    possible: number,
  ): FinancialStatementImportPreviewOut["rows"][number]["status"] =>
    (!row.importFingerprint && (fingerprintCounts.get(externalId) ?? 0) > 1) ||
    Boolean(
      row.providerTransactionId &&
      input.rows.filter(
        (other) =>
          other.source === row.source &&
          other.providerTransactionId === row.providerTransactionId,
      ).length > 1,
    )
      ? "indistinguishable_duplicate"
      : recorded > 0
        ? "already_recorded"
        : !account
          ? "unresolved_account"
          : possible > 0
            ? "possible_existing"
            : "ready_to_create";

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
    const account = accountFor(row);
    const exactOccurrence = parsedTransactions.filter((transaction) =>
      transaction.sourceRefs.some(
        (ref) =>
          ref.source === sourceRef.source &&
          ref.externalId === sourceRef.externalId,
      ),
    );
    const providerMatches =
      account && row.providerTransactionId
        ? parsedTransactions.filter(
            (transaction) =>
              transaction.accountId === account.id &&
              transaction.sourceRefs.some((ref) =>
                observations.some(
                  (observation) =>
                    observation.source === row.source &&
                    observation.providerTransactionId ===
                      row.providerTransactionId &&
                    observation.source === ref.source &&
                    observation.externalId === ref.externalId,
                ),
              ),
          )
        : [];
    const belongsToAnotherOccurrence = (
      transaction: (typeof parsedTransactions)[number],
    ) =>
      Boolean(
        row.importFingerprint &&
        transaction.sourceRefs.some((ref) =>
          sameFileObservations.some(
            (observation) =>
              observation.source === row.source &&
              observation.fingerprint === row.importFingerprint &&
              observation.rowPosition !== row.rowPosition &&
              observation.source === ref.source &&
              observation.externalId === ref.externalId,
          ),
        ),
      );
    const sameFacts = (transaction: (typeof parsedTransactions)[number]) =>
      cents(Number(transaction.amount)) === cents(normalizedAmount) &&
      transaction.status === "posted" &&
      transaction.postedDate === row.date;
    const alreadyRecorded = exactOccurrence.length
      ? exactOccurrence
      : providerMatches.length === 1 &&
          sameFacts(providerMatches[0]!) &&
          !belongsToAnotherOccurrence(providerMatches[0]!)
        ? providerMatches
        : [];
    const legacyMatches = parsedTransactions.filter(
      (transaction) =>
        account &&
        transaction.accountId === account.id &&
        transaction.sourceRefs.some(
          (ref) =>
            ref.source === row.source && ref.externalId === legacyIds[index],
        ),
    );
    const nearbyMatches = account
      ? parsedTransactions.filter((transaction) => {
          const sameAmount =
            cents(Number(transaction.amount)) === cents(normalizedAmount);
          if (
            transaction.accountId !== account.id ||
            (!sameAmount &&
              Math.sign(cents(Number(transaction.amount))) !==
                Math.sign(cents(normalizedAmount)))
          )
            return false;
          const date = transaction.postedDate ?? transaction.transactionDate;
          if (
            !date ||
            Math.abs(Date.parse(date) - Date.parse(row.date)) > 3 * 86400000
          )
            return false;
          return (
            // A settled tip or other amount correction without a provider ID
            // is a review candidate only with matching source description.
            (!row.importFingerprint && sameAmount) ||
            canonical(transaction.rawDescription ?? "") ===
              canonical(row.originalStatement) ||
            Boolean(
              row.merchant &&
              transaction.merchant &&
              normalizeMerchant(row.merchant) ===
                normalizeMerchant(transaction.merchant),
            )
          );
        })
      : [];
    const possibleExisting = (
      providerMatches.length
        ? providerMatches
        : uniqBy(
            [...legacyMatches, ...nearbyMatches],
            (transaction) => transaction.id,
          )
    ).filter((transaction) => !belongsToAnotherOccurrence(transaction));

    const existingTransactionIds = (
      alreadyRecorded.length ? alreadyRecorded : possibleExisting
    ).map((transaction) =>
      parseShortcodeFor("financialTransaction", transaction.shortcode),
    );
    const status = statusFor(
      row,
      externalId,
      alreadyRecorded.length,
      Boolean(account),
      possibleExisting.length,
    );

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
      existingTransactions: (alreadyRecorded.length
        ? alreadyRecorded
        : possibleExisting
      ).map((transaction) => ({
        id: parseShortcodeFor("financialTransaction", transaction.shortcode),
        amount: Number(transaction.amount),
        status: financialTransactionStatus.parse(transaction.status),
        postedDate: transaction.postedDate,
        transactionDate: transaction.transactionDate,
        merchant: transaction.merchant,
        rawDescription: transaction.rawDescription,
      })),
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
