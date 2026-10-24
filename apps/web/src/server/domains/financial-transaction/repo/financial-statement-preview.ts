import {
  type FinancialAccountCardNumber,
  type FinancialAccountIdentity,
  financialAccountCardNumbers,
  financialAccountIdentity,
  financialAccountSourceAliases,
} from "@cubby/schemas/financial-account";
import {
  type FinancialTransactionImportPreviewInput,
  type FinancialTransactionImportRow,
  type FinancialTransactionImportPreviewOut,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { cents } from "@cubby/shared";
import { and, inArray, or, sql } from "drizzle-orm";
import { chunk, uniq, uniqBy } from "es-toolkit";

import { shiftPlainDate } from "~/lib/household-date";
import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import {
  financialAccount,
  financialTransaction,
  sourceTransactionRecord,
  transactionImport,
  vendor,
} from "~/server/db/retained-tables";
import {
  sourceTransactionRecordExternalId,
  sourceTransactionRecordOccurrenceId,
} from "~/server/domains/transaction-import/repo/source-transaction-record-identity";
import {
  merchantVendorInferences,
  normalizeMerchant,
} from "~/server/domains/vendor/repo/merchant-vendor-inference";
import { settlementRefsFor } from "~/server/generic/entity-links/repo/entity-external-ids";

/**
 * Deliberately *not* the identity module's canonicalizer, despite being the
 * same two lines: this one only sniffs a descriptor for a network name or last
 * four, so it must stay free to change. Sharing it would let a
 * descriptor-matching tweak silently re-hash every stored source ref.
 */
const canonical = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const pairKey = (source: string, identity: string) =>
  JSON.stringify([source, identity]);

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
  row: FinancialTransactionImportPreviewInput["rows"][number],
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
    })
    .from(financialAccount)
    .leftJoin(
      vendor,
      and(
        sql`${vendor.id} = ${financialAccount.providerVendorId}`,
        notDeleted(vendor),
      ),
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
  for (const batch of chunk(missing, 512)) {
    const requested = sql`(VALUES ${sql.join(
      batch.map(
        (scope) =>
          sql`(${scope.fingerprint}::text, ${scope.source}::text, ${scope.externalId}::text)`,
      ),
      sql`, `,
    )}) AS requested(fingerprint, source, "externalId")`;
    const loaded = unwrapDb(db)
      .select({
        source: sourceTransactionRecord.source,
        externalId: sourceTransactionRecord.externalId,
        fingerprint: transactionImport.fingerprint,
        rowPosition: sourceTransactionRecord.rowPosition,
      })
      .from(sourceTransactionRecord)
      .innerJoin(
        requested,
        sql`requested.source = ${sourceTransactionRecord.source} AND requested."externalId" = ${sourceTransactionRecord.externalId}`,
      )
      .innerJoin(
        transactionImport,
        sql`${sourceTransactionRecord.batchId} = ${transactionImport.id} AND requested.fingerprint = ${transactionImport.fingerprint}`,
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
    for (const scope of batch) {
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
export async function previewFinancialTransactionImport(
  db: Database,
  input: FinancialTransactionImportPreviewInput,
  options: FinancialStatementPreviewOptions = {},
): Promise<FinancialTransactionImportPreviewOut> {
  const suggestionPolicy = options.candidatePolicy === "suggestion";
  const legacyIds = await Promise.all(
    input.rows.map((row) => sourceTransactionRecordExternalId(row)),
  );
  const sourceRefIds = await Promise.all(
    input.rows.map(
      (row, index) =>
        options.retainedRefs?.get(row.key) ??
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
  const observations = providerPairs.length
    ? await unwrapDb(db)
        .select({
          source: sourceTransactionRecord.source,
          providerTransactionId: sourceTransactionRecord.providerTransactionId,
          providerAccountId: sourceTransactionRecord.providerAccountId,
          externalId: sourceTransactionRecord.externalId,
        })
        .from(sourceTransactionRecord)
        .where(
          and(
            notDeleted(sourceTransactionRecord),
            or(
              ...providerPairs.map((row) =>
                and(
                  sql`${sourceTransactionRecord.source} = ${row.source}`,
                  sql`${sourceTransactionRecord.providerTransactionId} = ${row.providerTransactionId}`,
                ),
              ),
            ),
          ),
        )
    : [];

  // Global settlement references survive date corrections. A relation of exact
  // source/ref pairs avoids quadratic planning of a large correlated OR tree.
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
      : sql`${financialTransaction.id} IN (
          SELECT px."entityId"
          FROM (VALUES ${sql.join(
            pairs.map(
              (pair) => sql`(${pair.source}::text, ${pair.externalId}::text)`,
            ),
            sql`, `,
          )}) AS requested(source, "externalId")
          JOIN "EntityExternalId" px ON px.source = requested.source
            AND px."externalId" = requested."externalId"
          WHERE px.kind = 'settlement_ref' AND px."deletedAt" IS NULL
        )`;
  const [preparation, transactions] = await Promise.all([
    options.preparation ?? prepareFinancialStatementPreview(db),
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

  const parsedAccounts = preparation.accounts;
  for (const transaction of transactions)
    preparation.ids.set(transaction.shortcode, transaction.id);
  const refsByTransaction = await settlementRefsFor(
    db,
    transactions.map((transaction) => transaction.id),
  );
  const parsedTransactions = transactions.map((transaction) => ({
    ...transaction,
    sourceRefs: refsByTransaction.get(transaction.id) ?? [],
  }));
  // Preserve ledger order and every competitor while avoiding a full-ledger
  // scan for each input row. Reference identity stays source-scoped.
  const transactionsByAccount = new Map<string, typeof parsedTransactions>();
  const transactionsByRef = new Map<string, typeof parsedTransactions>();
  for (const transaction of parsedTransactions) {
    const accountRows = transactionsByAccount.get(transaction.accountId) ?? [];
    accountRows.push(transaction);
    transactionsByAccount.set(transaction.accountId, accountRows);
    for (const key of new Set(
      transaction.sourceRefs.map((ref) => pairKey(ref.source, ref.externalId)),
    )) {
      const refRows = transactionsByRef.get(key) ?? [];
      refRows.push(transaction);
      transactionsByRef.set(key, refRows);
    }
  }
  const observationsByProvider = new Map<string, typeof observations>();
  for (const observation of observations) {
    if (!observation.providerTransactionId) continue;
    const key = pairKey(observation.source, observation.providerTransactionId);
    const matching = observationsByProvider.get(key) ?? [];
    matching.push(observation);
    observationsByProvider.set(key, matching);
  }
  const providerObservations = (row: FinancialTransactionImportRow) =>
    row.providerTransactionId
      ? (observationsByProvider.get(
          pairKey(row.source, row.providerTransactionId),
        ) ?? [])
      : [];
  const providerInputKey = (row: FinancialTransactionImportRow) =>
    JSON.stringify([
      row.source,
      row.providerTransactionId,
      row.providerAccountId ?? canonical(row.account),
    ]);
  const providerInputCounts = new Map<string, number>();
  for (const row of providerPairs) {
    const key = providerInputKey(row);
    providerInputCounts.set(key, (providerInputCounts.get(key) ?? 0) + 1);
  }

  const accountFor = (row: FinancialTransactionImportRow) => {
    const hinted = options.accountHints?.get(row.key);
    if (hinted) {
      const stored = parsedAccounts.find((account) => account.id === hinted);
      if (stored) return stored;
    }
    if (row.providerAccountId) {
      const scoped = parsedAccounts.filter((account) =>
        account.sourceAliases.some(
          (alias) =>
            alias.source === row.source &&
            alias.externalAccountId === row.providerAccountId,
        ),
      );
      if (scoped.length) return scoped.length === 1 ? scoped[0] : undefined;
      // Descriptor fallback cannot overrule a known provider account scope.
      const conflictingAlias = parsedAccounts.some((account) =>
        account.sourceAliases.some(
          (alias) =>
            alias.source === row.source &&
            canonical(alias.alias) === canonical(row.account) &&
            alias.externalAccountId !== null &&
            alias.externalAccountId !== row.providerAccountId,
        ),
      );
      const conflictingRecord = providerObservations(row).some(
        (observation) =>
          observation.providerAccountId !== null &&
          observation.providerAccountId !== row.providerAccountId,
      );
      if (conflictingAlias || conflictingRecord) return undefined;
    }
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
    if (accountMatches.length > 0)
      return accountMatches.length === 1 ? accountMatches[0] : null;
    const settledAccount = options.settlementAccountHints?.get(row.key);
    return settledAccount
      ? (parsedAccounts.find((account) => account.id === settledAccount) ??
          null)
      : null;
  };
  const statusFor = (
    row: FinancialTransactionImportRow,
    externalId: string,
    recorded: number,
    account: boolean,
    possible: number,
  ): FinancialTransactionImportPreviewOut["rows"][number]["status"] =>
    // Rows keyed by the legacy ref (no fingerprint or no row position) share it
    // when identical, so creating both would drop one real charge.
    ((!row.importFingerprint || row.rowPosition === undefined) &&
      (fingerprintCounts.get(externalId) ?? 0) > 1) ||
    Boolean(
      row.providerTransactionId &&
      (providerInputCounts.get(providerInputKey(row)) ?? 0) > 1,
    )
      ? "indistinguishable_duplicate"
      : recorded > 0
        ? "already_recorded"
        : !account
          ? "unresolved_account"
          : possible > 0
            ? "possible_existing"
            : "ready_to_create";

  const candidateRows = input.rows.map((row, index) => {
    const sourceRef = { source: row.source, externalId: sourceRefIds[index]! };
    const normalizedAmount = -row.amount;
    const account = accountFor(row);
    const exactOccurrence = (
      transactionsByRef.get(pairKey(sourceRef.source, sourceRef.externalId)) ??
      []
    ).filter(
      (transaction) =>
        !row.providerAccountId ||
        (account && transaction.accountId === account.id),
    );
    const providerTransactionIds = new Set(
      providerObservations(row)
        .filter(
          (observation) =>
            row.providerAccountId === undefined ||
            row.providerAccountId === null ||
            observation.providerAccountId === row.providerAccountId,
        )
        .flatMap(
          (observation) =>
            transactionsByRef.get(
              pairKey(observation.source, observation.externalId),
            ) ?? [],
        )
        .map((transaction) => transaction.id),
    );
    const providerMatches =
      account && row.providerTransactionId
        ? (transactionsByAccount.get(account.id) ?? []).filter((transaction) =>
            providerTransactionIds.has(transaction.id),
          )
        : [];
    const legacyMatches = (
      transactionsByRef.get(pairKey(row.source, legacyIds[index]!)) ?? []
    ).filter((transaction) => account && transaction.accountId === account.id);
    const nearbyMatches = account
      ? (transactionsByAccount.get(account.id) ?? []).filter((transaction) => {
          const sameAmount =
            cents(Number(transaction.amount)) === cents(normalizedAmount);
          if (
            transaction.accountId !== account.id ||
            (!sameAmount &&
              Math.sign(cents(Number(transaction.amount))) !==
                Math.sign(cents(normalizedAmount)))
          )
            return false;
          const nearbyDate = [
            transaction.transactionDate,
            transaction.postedDate,
          ].some(
            (date) =>
              date !== null &&
              Math.abs(Date.parse(date) - Date.parse(row.date)) <= 3 * 86400000,
          );
          if (!nearbyDate) return false;
          if (suggestionPolicy && transaction.status === "void") return false;
          return (
            // A settled tip or other amount correction without a provider ID
            // is a review candidate only with matching source description.
            ((!row.importFingerprint || suggestionPolicy) && sameAmount) ||
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
    return {
      account,
      exactOccurrence,
      providerMatches,
      legacyMatches,
      nearbyMatches,
    };
  });
  const scopes = uniqBy(
    input.rows.flatMap((row, index) => {
      if (!row.importFingerprint) return [];
      const candidates = candidateRows[index]!;
      // Suggestion admission only consults occurrence positions for its
      // single-provider same-facts fallback; exact occurrences take precedence.
      const checked = suggestionPolicy
        ? candidates.exactOccurrence.length === 0 &&
          candidates.providerMatches.length === 1
          ? candidates.providerMatches
          : []
        : [
            ...candidates.providerMatches,
            ...candidates.legacyMatches,
            ...candidates.nearbyMatches,
          ];
      return checked.flatMap((transaction) =>
        transaction.sourceRefs
          .filter((ref) => ref.source === row.source)
          .map((ref) => ({
            fingerprint: row.importFingerprint!,
            source: ref.source,
            externalId: ref.externalId,
          })),
      );
    }),
    (scope) =>
      JSON.stringify([scope.fingerprint, scope.source, scope.externalId]),
  );
  const filePositions = await sameFilePositions(
    db,
    scopes,
    preparation.sameFiles,
  );
  const rows = input.rows.map((row, index) => {
    const externalId = sourceRefIds[index]!;
    const sourceRef = { source: row.source, externalId };
    const normalizedAmount = -row.amount;
    const kind = row.kind ?? (normalizedAmount > 0 ? "purchase" : "refund");
    const proposed: FinancialTransactionImportPreviewOut["rows"][number]["proposed"] =
      {
        sourceRef,
        amount: normalizedAmount,
        kind,
        status: row.providerStatus ?? "observed",
        transactionDate: row.providerStatus === "posted" ? null : row.date,
        postedDate: row.providerStatus === "posted" ? row.date : null,
        merchant: row.merchant,
        rawDescription: row.originalStatement,
        sourceCategory: row.category,
        notes: row.notes,
      };
    const {
      account,
      exactOccurrence,
      providerMatches,
      legacyMatches,
      nearbyMatches,
    } = candidateRows[index]!;
    const occurrencePositions = row.importFingerprint
      ? filePositions.get(row.importFingerprint)
      : undefined;
    const belongsToAnotherOccurrence = (
      transaction: (typeof parsedTransactions)[number],
    ) =>
      Boolean(
        occurrencePositions &&
        transaction.sourceRefs.some(
          (ref) =>
            ref.source === row.source &&
            [
              ...(occurrencePositions.get(
                pairKey(ref.source, ref.externalId),
              ) ?? []),
            ].some((position) => position !== row.rowPosition),
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
    const possibleExisting = (
      providerMatches.length
        ? providerMatches
        : uniqBy(
            [...legacyMatches, ...nearbyMatches],
            (transaction) => transaction.id,
          )
    ).filter(
      (transaction) =>
        // Historical collections can retain surplus or mispositioned membership.
        // Discovery must keep a claimed settlement visible for identity review.
        (suggestionPolicy || !belongsToAnotherOccurrence(transaction)) &&
        !(suggestionPolicy && transaction.status === "void"),
    );

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
    options.includeVendorInference === false
      ? []
      : eligibleRows.flatMap((row) =>
          row.proposed.merchant ? [row.proposed.merchant] : [],
        ),
  );
  const enrichedRows = rows.map((row) => ({
    ...row,
    vendorInference:
      options.includeVendorInference !== false &&
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
