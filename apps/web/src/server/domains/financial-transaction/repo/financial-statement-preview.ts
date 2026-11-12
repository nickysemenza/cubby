import {
  financialAccountCardNumbers,
  financialAccountIdentity,
  financialAccountSourceAliases,
} from "@cubby/schemas/financial-account";
import {
  type FinancialTransactionImportPreviewInput,
  type RawFinancialTransactionImportPreviewOut as FinancialTransactionImportPreviewOut,
} from "@cubby/schemas/financial-transaction";
import { sourceOccurrenceIdentityKind } from "@cubby/schemas/source-occurrence-fields";
import { sourceOccurrenceReviewState } from "@cubby/schemas/source-occurrence-fields";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { uniq, uniqBy } from "es-toolkit";

import { shiftPlainDate } from "~/lib/household-date";
import { minorToDollarsSql } from "~/server/db/computed/money";
import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { requestedRows } from "~/server/db/helpers/requested";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import {
  financialAccount,
  financialTransaction,
  sourceTransactionRecord,
  transactionImport,
  transactionImportRecord,
  vendor,
} from "~/server/db/retained-tables";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { financialSourceRefsFor } from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import {
  sourceObservationColumns,
  sourceObservationIdentities,
} from "~/server/domains/transaction-import/repo/source-observation-state";
import {
  sourceTransactionRecordExternalId,
  sourceTransactionRecordOccurrenceId,
} from "~/server/domains/transaction-import/repo/source-transaction-record-identity";
import { merchantVendorInferences } from "~/server/domains/vendor/repo/merchant-vendor-inference";

import {
  financialRowAccounts,
  projectFinancialCandidates,
  projectFinancialRows,
  finishFinancialPreview,
} from "./financial-statement-projection";

const pairKey = (source: string, identity: string) =>
  JSON.stringify([source, identity]);

export type FinancialStatementPreviewOptions = {
  /**
   * `suggestion` widens nearby candidacy to any same-account, same-cents
   * transaction within three days whatever its descriptor, and never offers a
   * void transaction. Statement suggestions use it at generation and again at
   * apply, so both sides agree on what a candidate is.
   */
  candidatePolicy?: "import" | "suggestion";
  /** Skip advisory Vendor enrichment when an internal caller consumes only identity/overlap facts. */
  includeVendorInference?: boolean;
  /** Server-owned retained observations, never supplied by a client. */
  retainedRefs?: ReadonlyMap<string, string>;
  /** Server-only: a stored SourceTransactionRecord account outranks alias/last4 resolution, keyed by row key. */
  accountHints?: ReadonlyMap<string, string>;
  /** Server-only accepted settlement account; fallback only after source resolution finds no account. */
  settlementAccountHints?: ReadonlyMap<string, string>;
  /** One synchronous preparation scope; never retain across model latency or another page. */
  preparation?: FinancialStatementPreviewPreparation;
};

/** Account metadata and exact file-observation scopes shared within one advisory build. Transactions stay fresh. */
export async function prepareFinancialStatementPreview(db: Database) {
  const accounts = await unwrapDb(db)
    .select({
      id: financialAccount.id,
      shortcode: financialAccount.shortcode,
      name: financialAccount.name,
      identity: financialAccount.identity,
      sourceAliases: financialAccount.sourceAliases,
      cardNumbers: financialAccount.cardNumbers,
      ledgerPartyId: financialAccount.ledgerPartyId,
      vendorName: vendor.name,
      vendorAliases: vendor.aliases,
    })
    .from(financialAccount)
    .leftJoin(
      vendor,
      and(eq(vendor.id, financialAccount.providerVendorId), notDeleted(vendor)),
    )
    .where(notDeleted(financialAccount));
  return {
    sameFiles: new Map<
      string,
      Map<string, Promise<ReadonlySet<number | null>>>
    >(),
    accounts: accounts.map((account) => ({
      ...account,
      identity: financialAccountIdentity.parse(account.identity),
      sourceAliases: financialAccountSourceAliases.parse(account.sourceAliases),
      cardNumbers: financialAccountCardNumbers.parse(account.cardNumbers),
    })),
    ids: new Map<string, string>(
      accounts.map((account) => [account.shortcode, account.id]),
    ),
  };
}
type FinancialStatementPreviewPreparation = Awaited<
  ReturnType<typeof prepareFinancialStatementPreview>
>;

// Previews read identity facts only; the state view's history folds would
// turn these keyed lookups into whole-table scans.
const observationIdentities = sql`${sourceObservationIdentities} "SourceTransactionRecord"`;

type FileObservationScope = {
  fingerprint: string;
  source: string;
  externalId: string;
};

async function sameFilePositions(
  db: Database,
  scopes: readonly FileObservationScope[],
  cache: FinancialStatementPreviewPreparation["sameFiles"],
) {
  const missing = scopes.filter(
    (scope) =>
      !cache
        .get(scope.fingerprint)
        ?.has(pairKey(scope.source, scope.externalId)),
  );
  // Install every pending scope before awaiting, so overlapping previews share
  // both observations and known misses without sharing duplicate admission.
  if (missing.length) {
    const requested = requestedRows(
      missing,
      { fingerprint: "text", source: "text", externalId: "text" },
      "requested",
    );
    const loaded = unwrapDb(db)
      .select({
        source: sourceObservationColumns.source,
        externalId: sourceObservationColumns.chargeKey,
        fingerprint: transactionImport.fingerprint,
        rowPosition: transactionImportRecord.rowPosition,
      })
      .from(observationIdentities)
      .innerJoin(
        requested.from,
        sql`requested.source = ${sourceObservationColumns.source} AND requested."externalId" = ${sourceObservationColumns.chargeKey}`,
      )
      .innerJoin(
        transactionImportRecord,
        eq(transactionImportRecord.statementRowId, sourceTransactionRecord.id),
      )
      .innerJoin(
        transactionImport,
        sql`${transactionImportRecord.importId} = ${transactionImport.id} AND requested.fingerprint = ${transactionImport.fingerprint}`,
      )
      .where(
        and(notDeleted(sourceTransactionRecord), notDeleted(transactionImport)),
      )
      .execute()
      .then((observations) => {
        const indexed = new Map<string, Map<string, Set<number | null>>>();
        for (const observation of observations) {
          const file =
            indexed.get(observation.fingerprint) ??
            new Map<string, Set<number | null>>();
          const key = pairKey(observation.source, observation.externalId);
          const positions = file.get(key) ?? new Set<number | null>();
          positions.add(observation.rowPosition);
          file.set(key, positions);
          indexed.set(observation.fingerprint, file);
        }
        return indexed;
      });
    for (const scope of missing) {
      const file =
        cache.get(scope.fingerprint) ??
        new Map<string, Promise<ReadonlySet<number | null>>>();
      const key = pairKey(scope.source, scope.externalId);
      file.set(
        key,
        loaded.then(
          (indexed) =>
            indexed.get(scope.fingerprint)?.get(key) ??
            new Set<number | null>(),
        ),
      );
      cache.set(scope.fingerprint, file);
    }
  }
  const result = new Map<string, Map<string, ReadonlySet<number | null>>>();
  await Promise.all(
    scopes.map(async (scope) => {
      const key = pairKey(scope.source, scope.externalId);
      const positions = await cache.get(scope.fingerprint)!.get(key)!;
      const file =
        result.get(scope.fingerprint) ??
        new Map<string, ReadonlySet<number | null>>();
      file.set(key, positions);
      result.set(scope.fingerprint, file);
    }),
  );
  return result;
}

/**
 * Preview only: client-parsed rows become a decision worklist. It intentionally
 * does not create accounts/transactions or infer any Purchase link.
 */
async function loadFinancialPreview(
  db: Database,
  input: FinancialTransactionImportPreviewInput,
  options: FinancialStatementPreviewOptions = {},
) {
  const legacyIds = await Promise.all(
    input.rows.map((row) => sourceTransactionRecordExternalId(row)),
  );
  const retainedRows = requestedRows(
    input.rows.map((row) => ({
      key: row.key,
      source: row.source,
      fingerprint: row.importFingerprint ?? null,
      position: row.rowPosition ?? null,
      provider: row.providerTransactionId ?? null,
      account: row.providerAccountId ?? null,
    })),
    {
      key: "text",
      source: "text",
      fingerprint: "text",
      position: "int",
      provider: "text",
      account: "text",
    },
    "requested",
  );
  const retainedOccurrences = input.rows.length
    ? await unwrapDb(db).execute<{ key: string; shortcode: string }>(sql`
    SELECT requested.key, owner.shortcode FROM ${retainedRows.from}
    JOIN "TransactionImport" collection ON collection.source = requested.source AND collection.fingerprint = requested.fingerprint
    JOIN ${transactionImportRecord} membership ON membership."importId"=collection.id AND membership."rowPosition"=requested.position
    JOIN "SourceTransactionRecord" observation ON observation.id=membership."statementRowId"
    JOIN "SourceOccurrence" owner ON owner.id = observation."occurrenceId"
    WHERE ${notDeleted("owner")} AND ${notDeleted("observation")} AND owner."reviewState" = ${sqlEnumConstant(sourceOccurrenceReviewState, sourceOccurrenceReviewState.enum.ready)}
    UNION
    SELECT requested.key, owner.shortcode FROM ${retainedRows.from}
    JOIN "SourceOccurrence" owner ON owner.source = requested.source AND owner."identityKind" = ${sqlEnumConstant(sourceOccurrenceIdentityKind, sourceOccurrenceIdentityKind.enum.provider)}
      AND owner."identityScope" = 'provider:' || requested.source AND owner."providerIdentity" = requested.provider
    WHERE ${notDeleted("owner")} AND owner."reviewState" = ${sqlEnumConstant(sourceOccurrenceReviewState, sourceOccurrenceReviewState.enum.ready)}`)
    : null;
  const occurrenceCandidates = new Map<string, Set<string>>();
  for (const candidate of retainedOccurrences?.rows ?? []) {
    const codes = occurrenceCandidates.get(candidate.key) ?? new Set<string>();
    codes.add(candidate.shortcode);
    occurrenceCandidates.set(candidate.key, codes);
  }
  const sourceRefIds = await Promise.all(
    input.rows.map(
      (row, index) =>
        options.retainedRefs?.get(row.key) ??
        (occurrenceCandidates.get(row.key)?.size === 1
          ? [...occurrenceCandidates.get(row.key)!][0]
          : undefined) ??
        (row.importFingerprint && row.rowPosition !== undefined
          ? sourceTransactionRecordOccurrenceId(
              row.source,
              row.importFingerprint,
              row.rowPosition,
            )
          : legacyIds[index]!),
    ),
  );
  const dates = uniq(
    input.rows.flatMap((row) =>
      Array.from({ length: 7 }, (_, offset) =>
        shiftPlainDate(row.date, offset - 3),
      ),
    ),
  );
  const providerPairs = input.rows.filter((row) => row.providerTransactionId);
  const requestedProviders = requestedRows(
    uniqBy(
      providerPairs.map((row) => ({
        source: row.source,
        provider: row.providerTransactionId ?? null,
      })),
      (row) => pairKey(row.source, row.provider!),
    ),
    { source: "text", provider: "text" },
    "requested_provider",
  );
  const observations = providerPairs.length
    ? await unwrapDb(db)
        .select({
          source: sourceObservationColumns.source,
          providerTransactionId: sourceObservationColumns.providerTransactionId,
          providerAccountId: sourceObservationColumns.providerAccountId,
          externalId: sourceObservationColumns.chargeKey,
        })
        .from(observationIdentities)
        .innerJoin(
          requestedProviders.from,
          sql`requested_provider.source = ${sourceObservationColumns.source}
            AND requested_provider.provider = ${sourceObservationColumns.providerTransactionId}`,
        )
        .where(
          and(
            notDeleted(sourceTransactionRecord),
            sql`EXISTS (SELECT 1 FROM "SourceOccurrence" owner
              WHERE owner.id = ${sourceObservationColumns.occurrenceId} AND owner."identityKind" = ${sqlEnumConstant(sourceOccurrenceIdentityKind, sourceOccurrenceIdentityKind.enum.provider)}
                AND owner."reviewState" = ${sqlEnumConstant(sourceOccurrenceReviewState, sourceOccurrenceReviewState.enum.ready)} AND ${notDeleted("owner")})`,
          ),
        )
    : [];

  // Explicit occurrence ownership supplies exact matches; historical aliases only widen candidates.
  const pairs = uniqBy(
    [
      ...input.rows.map((row, index) => ({
        source: row.source,
        externalId: sourceRefIds[index]!,
      })),
      ...observations,
    ],
    (pair) => `${pair.source}\0${pair.externalId}`,
  );
  const requestedPairs = requestedRows(
    pairs.map((pair) => ({ source: pair.source, code: pair.externalId })),
    { source: "text", code: "text" },
    "requested",
  );
  const requestedAliases = requestedRows(
    input.rows.flatMap((row, index) =>
      [sourceRefIds[index]!, legacyIds[index]!].map((value) => ({
        source: row.source,
        value,
      })),
    ),
    { source: "text", value: "text" },
    "requested",
  );
  const sourceRefLookup =
    pairs.length === 0
      ? undefined
      : sql`${financialTransaction.id} IN (
    SELECT owner."acceptedTransactionId" FROM "SourceOccurrence" owner
    JOIN ${requestedPairs.from}
      ON owner.source = requested.source AND owner.shortcode = requested.code
    WHERE owner."acceptedTransactionId" IS NOT NULL
    UNION
    SELECT alias."historicalTransactionId" FROM "FinancialEvidenceAlias" alias
    JOIN ${requestedAliases.from}
      ON alias.source = requested.source AND alias.value = requested.value
    WHERE alias."historicalTransactionId" IS NOT NULL
  )`;
  const preparation =
    options.preparation ?? (await prepareFinancialStatementPreview(db));
  // A date-window candidate must share its row's resolved account, so the
  // date arm reads only those accounts' (account, date) index ranges.
  const { accountFor } = financialRowAccounts(
    options,
    preparation.accounts,
    observations,
  );
  const rowAccounts = uniq(
    input.rows.flatMap((row) => {
      const account = accountFor(row);
      return account ? [account.id] : [];
    }),
  );
  const transactions = await unwrapDb(db)
    .select({
      id: financialTransaction.id,
      shortcode: financialTransaction.shortcode,
      accountId: financialTransaction.accountId,
      amount: minorToDollarsSql(financialTransaction.amount, "numeric").mapWith(
        Number,
      ),
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
          rowAccounts.length
            ? and(
                inArray(financialTransaction.accountId, rowAccounts),
                or(
                  inArray(financialTransaction.postedDate, dates),
                  inArray(financialTransaction.transactionDate, dates),
                ),
              )
            : sql`false`,
          sourceRefLookup,
        ),
      ),
    );

  for (const transaction of transactions)
    preparation.ids.set(transaction.shortcode, transaction.id);
  const refsByTransaction = await financialSourceRefsFor(
    db,
    transactions.map((transaction) => transaction.id),
  );
  return {
    sourceRefIds,
    legacyIds,
    observations,
    preparation,
    transactions,
    refsByTransaction,
  };
}

export type FinancialPreviewLoaded = Awaited<
  ReturnType<typeof loadFinancialPreview>
>;

export async function previewFinancialTransactionImport(
  db: Database,
  input: FinancialTransactionImportPreviewInput,
  options: FinancialStatementPreviewOptions = {},
): Promise<FinancialTransactionImportPreviewOut> {
  const loaded = await loadFinancialPreview(db, input, options);
  const candidates = projectFinancialCandidates(input, options, loaded);
  const filePositions = await sameFilePositions(
    db,
    candidates.scopes,
    loaded.preparation.sameFiles,
  );
  const rows = projectFinancialRows(
    input,
    options,
    loaded,
    candidates,
    filePositions,
  );
  const eligibleRows = rows.filter(
    (row) =>
      row.proposed.merchant &&
      (row.status === "ready_to_create" || row.status === "unresolved_account"),
  );
  const inferences = await merchantVendorInferences(
    db,
    options.includeVendorInference === false
      ? []
      : eligibleRows.flatMap((row) =>
          row.proposed.merchant ? [row.proposed.merchant] : [],
        ),
  );
  return finishFinancialPreview(rows, options, inferences);
}
