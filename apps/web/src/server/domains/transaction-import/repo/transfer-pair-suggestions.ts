import { suggestionStatus } from "@cubby/schemas/ai";
import {
  financialTransactionCreateInput,
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import { financialTransactionProviderStatus } from "@cubby/schemas/financial-transaction-fields";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { sourceOccurrenceReviewState } from "@cubby/schemas/source-occurrence-fields";
import { sourceTransactionRecordDisposition } from "@cubby/schemas/source-transaction-record-fields";
import {
  suggestionFamily,
  suggestionSubjects,
  type SuggestionProducer,
} from "@cubby/schemas/suggestion";
import { transferPairSuggestionRow } from "@cubby/schemas/suggestion-list";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import {
  transferPairJudgment,
  type TransferPairJudgment,
  type TransferPairLeg,
} from "@cubby/schemas/transfer-pair-suggestion";
import { cents } from "@cubby/shared";
import { sql, type SQL, eq } from "drizzle-orm";
import { chunk, uniq } from "es-toolkit";
import { z } from "zod";

import { shiftPlainDate } from "~/lib/household-date";
import { type Database } from "~/server/db";
import { advisoryLockKey, advisoryXactLock } from "~/server/db/advisory-lock";
import { minorToDollarsSql } from "~/server/db/computed/money";
import { sourceOccurrenceHasUnresolvedHistory } from "~/server/db/computed/source-occurrence-history-sql";
import {
  unwrapDb,
  databaseForTransaction,
  getDb,
  withTransaction,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { textArrayParam } from "~/server/db/helpers/query";
import { requestedRows } from "~/server/db/helpers/requested";
import { transactionImportRecord } from "~/server/db/retained-tables";
import { suggestionTable } from "~/server/db/schema";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import {
  lockFinancialTransactionSources,
  financialSourceRefsFor,
} from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import {
  prepareFinancialStatementPreview,
  previewFinancialTransactionImport,
} from "~/server/domains/financial-transaction/repo/financial-statement-preview";
import { createFinancialTransaction } from "~/server/domains/financial-transaction/repo/financial-transaction";
import { acceptFinancialTransferPair } from "~/server/domains/financial-transaction/repo/financial-transfer-accept";
import { transferEvidenceStatuses } from "~/server/domains/ledger-transfer/repo/ledger-transfer";
import {
  chargeId,
  type ChargeRef,
} from "~/server/domains/transaction-import/policy/charge-identity";
import { isLoanPayment } from "~/server/domains/transaction-import/policy/statement-transaction-kind";
import {
  POOL_WINDOW_DAYS,
  MONEY_MOVES,
  Account,
  LegFacts,
  Pair,
  isSeed,
  categorySignals,
  labelTransferPair,
  fingerprintTransferPair,
  transferPairEvidenceFingerprint,
  poolOf,
  candidatesOf,
  buildPair,
} from "~/server/domains/transaction-import/policy/transfer-pair";
import {
  sourceObservationFacts,
  sourceObservationFactsFrom,
} from "~/server/domains/transaction-import/repo/source-observation-state";
import { updateSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { hasStatementOccurrence } from "~/server/domains/transaction-import/repo/statement-charge";
import { previewRowFor } from "~/server/domains/transaction-import/repo/statement-input";
import { transferPoolAmountSql } from "~/server/domains/transaction-import/repo/transfer-pair-input";
import { type EntityKernelContext } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import { type SuggestionFamilyDeclaration } from "~/server/generic/suggestions/repo/suggestion-family-declaration";
import { outcomes } from "~/server/generic/suggestions/repo/suggestion-outcomes";
import {
  suggestionIdScope,
  verbs,
  outcome,
  keyBase,
  cleanAcceptance,
  transferPairRows,
  TRANSFER_WEAK_BLOCKERS,
} from "~/server/generic/suggestions/repo/suggestion-presentation";
import {
  revisionSuppresses,
  type SuggestionFamily,
  type SuggestionRow,
} from "~/server/generic/suggestions/repo/suggestion-publication";
import {
  entities,
  leg,
  declareAffectedRecords,
} from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import {
  type SuggestionStateRow,
  transitionSuggestionState,
  transitionSuggestionStates,
} from "~/server/generic/suggestions/repo/suggestion-state";
import { canonicalJson } from "~/server/lib/canonical-json";
import { assertWorkflowEffect } from "~/server/workflows/runs/execution";

const PREVIEW_CHUNK = 500;

const refused = (message: string) =>
  createAppError("CONSTRAINT_VIOLATION", message);

// ------------------------------------------------------------------ reads

/** Live accounts; one whose owner is soft-deleted is no leg's account. */
async function loadAccounts(db: Database) {
  const rows = await unwrapDb(db).execute<{
    id: string;
    shortcode: string;
    name: string;
    kind: string;
    ownerUuid: string | null;
    ownerCode: string | null;
    ownerName: string | null;
    ownerDeleted: boolean;
  }>(
    sql`
    SELECT fa.id, fa.shortcode, fa.name, fa.identity->>${"kind"} AS kind,
      lp.id AS "ownerUuid", lp.shortcode AS "ownerCode", lp.name AS "ownerName",
      (fa."ledgerPartyId" IS NOT NULL AND (lp.id IS NULL OR lp."deletedAt" IS NOT NULL)) AS "ownerDeleted"
    FROM "FinancialAccount" fa
    -- includes-deleted: a deleted owner is read to exclude its accounts.
    LEFT JOIN "LedgerParty" lp ON lp.id = fa."ledgerPartyId"
    WHERE ${notDeleted("fa")}
  `,
    "objects",
  );
  const accounts = rows
    .filter((row) => !row.ownerDeleted)
    .map((row): Account => ({
      id: String(row.id),
      shortcode: row.shortcode,
      name: row.name,
      kind: row.kind,
      owner:
        row.ownerUuid && row.ownerCode && row.ownerName
          ? {
              uuid: String(row.ownerUuid),
              id: row.ownerCode,
              name: row.ownerName,
            }
          : null,
    }));
  return {
    byId: new Map(accounts.map((account) => [account.id, account])),
    byCode: new Map(accounts.map((account) => [account.shortcode, account])),
    cashOf: (ownerUuid: string) =>
      accounts.filter(
        (account) =>
          account.kind === "cash" && account.owner?.uuid === ownerUuid,
      ),
  };
}
type Accounts = Awaited<ReturnType<typeof loadAccounts>>;

type LegFilter = {
  /** Only legs a money-move or cash-withdrawal signal retrieves. */
  seedOnly?: boolean;
  since?: string | null;
  amountsCents?: readonly number[];
  from?: string;
  to?: string;
  codes?: readonly string[];
  charges?: readonly ChargeRef[];
};

const amountIn = (column: SQL, amounts: readonly number[]) =>
  sql`${transferPoolAmountSql(column)} = ANY(${textArrayParam(amounts.map(String))}::bigint[])`;

/**
 * Supported observed transactions no LedgerTransfer, Purchase allocation or booked
 * Expense claims: the recorded legs an accept writer would take.
 */
async function loadTransactionLegs(
  db: Database,
  accounts: Accounts,
  filter: LegFilter,
): Promise<LegFacts[]> {
  if (filter.amountsCents?.length === 0 || filter.codes?.length === 0)
    return [];
  if (filter.charges) return [];
  const day = sql`COALESCE(ft."postedDate", ft."transactionDate")`;
  const conditions = [
    ...(filter.seedOnly
      ? [
          sql`(ft.kind = ANY(${textArrayParam([...MONEY_MOVES])}) OR ft."sourceCategory" IS NOT NULL)`,
        ]
      : []),
    ...(filter.since ? [sql`${day} >= ${filter.since}::date`] : []),
    ...(filter.from ? [sql`${day} >= ${filter.from}::date`] : []),
    ...(filter.to ? [sql`${day} <= ${filter.to}::date`] : []),
    ...(filter.amountsCents
      ? [
          amountIn(
            sql`(${minorToDollarsSql(sql`ft."amountMinor"`, "numeric")})`,
            filter.amountsCents,
          ),
        ]
      : []),
    ...(filter.codes
      ? [sql`ft.shortcode = ANY(${textArrayParam(filter.codes)})`]
      : []),
  ];
  const rows = await unwrapDb(db).execute<{
    id: string;
    shortcode: string;
    accountId: string;
    amount: string | number;
    date: string;
    kind: string;
    merchant: string | null;
    rawDescription: string | null;
    sourceCategory: string | null;
    notes: string | null;
  }>(
    sql`
    SELECT ft.id, ft.shortcode, ft."accountId", (${minorToDollarsSql(sql`ft."amountMinor"`, "numeric")})::float8 AS amount, ${day}::text AS date,
      ft.kind, ft.merchant, ft."rawDescription", ft."sourceCategory", ft.notes
    FROM "FinancialTransaction" ft
    WHERE ${notDeleted("ft")} AND ft.status = ANY(${textArrayParam(transferEvidenceStatuses)})
      AND ft."ledgerTransferId" IS NULL AND ${day} IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "FinancialTransactionAllocation" fta
        WHERE fta."transactionId" = ft.id AND ${notDeleted("fta")}
      )
      AND NOT EXISTS (
        SELECT 1 FROM "Expense" e
        WHERE e."bookingTransactionCode" = ft.shortcode AND ${notDeleted("e")}
      )
      ${conditions.length ? sql`AND ${sql.join(conditions, sql` AND `)}` : sql``}
  `,
    "objects",
  );
  const live = rows.flatMap((row) => {
    const account = accounts.byId.get(String(row.accountId));
    const amount = Number(row.amount);
    return account && amount !== 0 ? [{ row, account, amount }] : [];
  });
  const refs = await financialSourceRefsFor(
    db,
    live.map(({ row }) => String(row.id)),
  );
  return live.flatMap(({ row, account, amount }) => {
    const recordedKind = financialTransactionKind.parse(row.kind);
    const signals = categorySignals(row.sourceCategory, amount);
    const leg: LegFacts = {
      key: `ftx:${row.shortcode}`,
      origin: "transaction",
      account,
      transactionCode: parseShortcodeFor("financialTransaction", row.shortcode),
      charge: null,
      imports: new Set(),
      amount,
      date: row.date,
      merchant: row.merchant,
      description: row.rawDescription,
      notes: row.notes,
      recordedKind,
      providerCategory: row.sourceCategory,
      ...signals,
      refs: refs.get(String(row.id)) ?? [],
      transactionOverlaps: [],
      seed: false,
    };
    leg.seed = isSeed(leg);
    return filter.seedOnly && !leg.seed ? [] : [leg];
  });
}

const observationRow = z.object({
  occurrenceId: z.string().nullable(),
  reviewState: z.string().nullable(),
  id: z.string(),
  source: z.string(),
  externalId: z.string(),
  chargeKey: z.string(),
  legacyReference: z.string().nullable(),
  current: z.boolean(),
  withdrawnAt: z.string().nullable(),
  rowPosition: z.coerce.number().nullable(),
  providerTransactionId: z.string().nullable(),
  providerAccountId: z.string().nullable(),
  accountDescriptor: z.string(),
  statementDate: z.string(),
  providerAmount: z.coerce.number(),
  merchant: z.string().nullable(),
  rawDescription: z.string(),
  sourceCategory: z.string().nullable(),
  providerStatus: financialTransactionProviderStatus.nullable(),
  providerNotes: z.string().nullable(),
  accountId: z.string().nullable(),
  importFingerprint: z.string(),
  importIds: z.array(z.string()),
});
type ObservationRow = z.infer<typeof observationRow>;

/**
 * Current unmatched statement charges whose account resolves as the
 * statement family resolves it. Charge identity is the source's own; two
 * sources' observations of one movement stay two charges, which the overlap
 * rule holds back until statement review converges them.
 */
async function loadStatementLegs(
  db: Database,
  accounts: Accounts,
  filter: LegFilter,
  preparation?: Awaited<ReturnType<typeof prepareFinancialStatementPreview>>,
): Promise<LegFacts[]> {
  if (
    filter.amountsCents?.length === 0 ||
    filter.charges?.length === 0 ||
    filter.codes
  )
    return [];
  const requestedCharges = requestedRows(
    filter.charges ?? [],
    { source: "text", chargeKey: "text" },
    "requested_charge",
  );
  const conditions = [
    ...(filter.since
      ? [sql`seen."statementDate" >= ${filter.since}::date`]
      : []),
    ...(filter.from ? [sql`seen."statementDate" >= ${filter.from}::date`] : []),
    ...(filter.to ? [sql`seen."statementDate" <= ${filter.to}::date`] : []),
    ...(filter.amountsCents
      ? [
          amountIn(
            minorToDollarsSql(sql`seen."amountMinor"`, "numeric"),
            filter.amountsCents,
          ),
        ]
      : []),
    ...(filter.charges
      ? [
          sql`EXISTS (SELECT 1 FROM ${requestedCharges.from} WHERE ${requestedCharges.col("source")}=seen.source AND ${requestedCharges.col("chargeKey")}=owner.shortcode)`,
        ]
      : []),
  ];
  // Scope selects whole occurrences; every live observation remains in the cohort.
  const rows = await unwrapDb(db).execute<z.input<typeof observationRow>>(
    sql`
    WITH candidate_occurrences AS MATERIALIZED (
      SELECT DISTINCT owner.id
      FROM "SourceTransactionRecord" seen
      JOIN "SourceOccurrence" owner ON owner.id=seen."occurrenceId"
      WHERE ${notDeleted("seen")} AND ${notDeleted("owner")}
        ${conditions.length ? sql`AND ${sql.join(conditions, sql` AND `)}` : sql``}
    ), eligible_occurrences AS MATERIALIZED (
      SELECT candidate_owner.id, candidate_owner."reviewState"
      FROM candidate_occurrences candidate JOIN "SourceOccurrence" candidate_owner ON candidate_owner.id=candidate.id
      WHERE candidate_owner.disposition <> ${sqlEnumConstant(sourceTransactionRecordDisposition, sourceTransactionRecordDisposition.enum.ignored)} AND candidate_owner."supersededByOccurrenceId" IS NULL
        AND candidate_owner."replacementObservationId" IS NULL AND candidate_owner."acceptedTransactionId" IS NULL
        AND candidate_owner."reviewState" = ${sqlEnumConstant(sourceOccurrenceReviewState, sourceOccurrenceReviewState.enum.ready)}
        AND NOT ${sourceOccurrenceHasUnresolvedHistory(sql`candidate_owner.id`, sql`candidate_owner."acceptedTransactionId"`)}
    ), import_memberships AS MATERIALIZED (
      SELECT m."statementRowId", array_agg(m."importId"::text) AS "importIds"
      FROM ${transactionImportRecord} m
      JOIN "SourceTransactionRecord" observed ON observed.id=m."statementRowId" AND ${notDeleted("observed")}
      JOIN eligible_occurrences owner ON owner.id=observed."occurrenceId"
      GROUP BY m."statementRowId"
    )
    SELECT r."occurrenceId", owner."reviewState", r.id::text AS id, r.source, r."externalId", r."chargeKey",
      r."legacyReference", r.current, r."withdrawnAt"::text AS "withdrawnAt",
      r."rowPosition", r."providerTransactionId", r."providerAccountId", r."accountDescriptor",
      r."statementDate"::text AS "statementDate", r."providerAmount", r.merchant,
      r."rawDescription", r."sourceCategory", r."providerStatus", r."providerNotes",
      r."accountId"::text AS "accountId", si.fingerprint AS "importFingerprint",
      COALESCE(m."importIds", ARRAY[]::text[]) AS "importIds"
    FROM eligible_occurrences owner
    JOIN ${sourceObservationFacts} r ON r."occurrenceId"=owner.id AND ${notDeleted("r")}
    JOIN "TransactionImport" si ON si.id=r."batchId"
    LEFT JOIN import_memberships m ON m."statementRowId"=r.id
    ORDER BY r."createdAt" DESC, r.id
  `,
    "objects",
  );
  const byCharge = new Map<string, ObservationRow[]>();
  for (const raw of rows) {
    const row = observationRow.parse(raw);
    const key = chargeId(row);
    byCharge.set(key, [...(byCharge.get(key) ?? []), row]);
  }
  const charges = [...byCharge.values()].flatMap((observations) => {
    const canonical = observations.find((row) => row.current);
    if (
      !canonical ||
      !hasStatementOccurrence(canonical) ||
      canonical.withdrawnAt !== null ||
      canonical.providerAmount === 0
    )
      return [];
    const amount = -canonical.providerAmount;
    const signals = categorySignals(canonical.sourceCategory, amount);
    // An unresolved account may turn out to be a loan; this retrieves the
    // entry without using its descriptor as proof of a transfer pair.
    const seed =
      isSeed({ recordedKind: null, ...signals }) ||
      (canonical.rawDescription ?? canonical.merchant)?.trim().toUpperCase() ===
        "PAYMENT";
    if (filter.seedOnly && !seed) return [];
    const charge = { source: canonical.source, chargeKey: canonical.chargeKey };
    return [{ charge, canonical, observations, seed }];
  });

  const legs: LegFacts[] = [];
  for (const page of chunk(charges, PREVIEW_CHUNK)) {
    const preview = await previewFinancialTransactionImport(
      db,
      {
        rows: page.map(({ charge, canonical }) =>
          previewRowFor(charge, canonical),
        ),
      },
      {
        candidatePolicy: "suggestion",
        includeVendorInference: false,
        preparation,
        accountHints: new Map(
          page.flatMap(({ charge, observations }) => {
            const stored = observations.find((row) => row.accountId)?.accountId;
            return stored ? [[chargeId(charge), stored] as const] : [];
          }),
        ),
      },
    );
    const byKey = new Map(preview.rows.map((row) => [row.key, row]));
    for (const entry of page) {
      const row = byKey.get(chargeId(entry.charge));
      if (
        !row?.accountId ||
        row.status === "unresolved_account" ||
        row.status === "indistinguishable_duplicate" ||
        row.status === "already_recorded"
      )
        continue;
      const account = accounts.byCode.get(row.accountId);
      if (!account) continue;
      const { canonical, observations, charge } = entry;
      // Legs use the effective movement, so a loan payment opposes its bank leg.
      const amount = row.proposed.amount;
      const loanPayment = isLoanPayment(account, canonical);
      legs.push({
        key: `stmt:${chargeId(charge)}`,
        origin: "statement",
        account,
        transactionCode: null,
        charge,
        imports: new Set(observations.flatMap((obs) => obs.importIds)),
        amount,
        date: canonical.statementDate,
        merchant: canonical.merchant,
        description: canonical.rawDescription,
        notes: canonical.providerNotes,
        recordedKind: null,
        providerCategory: canonical.sourceCategory,
        ...categorySignals(canonical.sourceCategory, amount),
        ...(loanPayment
          ? { ruleKind: financialTransactionKind.enum.account_transfer }
          : {}),
        // One proven occurrence handle addresses acceptance; aliases stay retained evidence.
        refs: [{ source: canonical.source, externalId: canonical.chargeKey }],
        transactionOverlaps: row.existingTransactions.map((existing) => ({
          transactionId: existing.id,
          charge: null,
          date:
            existing.postedDate ??
            existing.transactionDate ??
            canonical.statementDate,
          description: existing.rawDescription ?? existing.merchant,
        })),
        seed: entry.seed,
      });
    }
  }
  return legs;
}

type Seeds = { kind: "legs"; keys: readonly string[]; seedOnly?: boolean };

const parseLegKey = (key: string) => {
  if (key.startsWith("ftx:")) return { code: key.slice(4) };
  if (key.startsWith("stmt:")) {
    const rest = key.slice(5);
    const split = rest.indexOf(":");
    return split > 0
      ? {
          charge: {
            source: rest.slice(0, split),
            chargeKey: rest.slice(split + 1),
          },
        }
      : null;
  }
  return null;
};

/** Source charges a pair action can write, using the owning leg-key parser. */

/** Page-local advisory reads only. Exact pool scopes preserve each seed's
 * duplicate/competitor semantics; acceptance always rebuilds fresh evidence. */
function transferPreparation(
  db: Database,
  accounts: Accounts,
  preview: Awaited<ReturnType<typeof prepareFinancialStatementPreview>>,
  seedLegs: ReadonlyMap<string, LegFacts | null>,
) {
  const pools = new Map<string, Promise<ReturnType<typeof poolOf>>>();
  return {
    preview,
    transactionSeeds(codes: readonly string[], seedOnly?: boolean) {
      if (!seedOnly || !codes.every((code) => seedLegs.has(code)))
        return undefined;
      return codes.flatMap((code) => {
        const leg = seedLegs.get(code);
        return leg ? [leg] : [];
      });
    },
    pool(filter: Pick<LegFilter, "amountsCents" | "from" | "to">) {
      const key = canonicalJson({
        amountsCents: filter.amountsCents ? [...filter.amountsCents] : null,
        from: filter.from ?? null,
        to: filter.to ?? null,
      });
      const existing = pools.get(key);
      if (existing) return existing;
      const loaded = (async () =>
        poolOf([
          ...(await loadTransactionLegs(db, accounts, filter)),
          ...(await loadStatementLegs(db, accounts, filter, preview)),
        ]))();
      pools.set(key, loaded);
      return loaded;
    },
  };
}

async function discover(
  db: Database,
  seeds: Seeds,
  loadedAccounts?: Accounts,
  preparation?: ReturnType<typeof transferPreparation>,
): Promise<Pair[]> {
  const accounts = loadedAccounts ?? (await loadAccounts(db));
  const parsed = seeds.keys.map(parseLegKey);
  const codes = parsed.flatMap((leg) => (leg?.code ? [leg.code] : []));
  const charges = parsed.flatMap((leg) => (leg?.charge ? [leg.charge] : []));
  const seedLegs = [
    ...(codes.length
      ? (preparation?.transactionSeeds(codes, seeds.seedOnly) ??
        (await loadTransactionLegs(db, accounts, {
          codes,
          seedOnly: seeds.seedOnly,
        })))
      : []),
    ...(charges.length
      ? await loadStatementLegs(
          db,
          accounts,
          {
            charges,
            seedOnly: seeds.seedOnly,
          },
          preparation?.preview,
        )
      : []),
  ];
  if (!seedLegs.length) return [];
  const dates = seedLegs.map((leg) => leg.date).sort();
  const poolFilter = {
    amountsCents: uniq(seedLegs.map((leg) => Math.abs(cents(leg.amount)))),
    from: shiftPlainDate(dates[0]!, -POOL_WINDOW_DAYS),
    to: shiftPlainDate(dates.at(-1)!, POOL_WINDOW_DAYS),
  };
  const pool = preparation
    ? await preparation.pool(poolFilter)
    : poolOf([
        ...(await loadTransactionLegs(db, accounts, poolFilter)),
        ...(await loadStatementLegs(db, accounts, poolFilter)),
      ]);
  const poolByKey = new Map(pool.legs.map((leg) => [leg.key, leg]));
  const pairs = new Map<string, Pair>();
  for (const seed of seedLegs) {
    const leg = poolByKey.get(seed.key) ?? seed;
    const candidates = candidatesOf(pool, leg);
    for (const candidate of candidates) {
      const [outflow, inflow] =
        leg.amount > 0 ? [leg, candidate] : [candidate, leg];
      const pair = buildPair(pool, outflow, inflow);
      pairs.set(pair.judgment.key, pair);
    }
    // An ATM withdrawal with no recorded cash leg: offer one on the owner's
    // only cash account, for review.
    const owner = leg.account.owner;
    if (
      leg.cashWithdrawal &&
      leg.account.kind !== "cash" &&
      owner &&
      !candidates.some((candidate) => candidate.account.kind === "cash")
    ) {
      const cash = accounts.cashOf(owner.uuid);
      if (cash.length === 1) {
        const pair = buildPair(pool, leg, { cash: cash[0]! });
        pairs.set(pair.judgment.key, pair);
      }
    }
  }
  return [...pairs.values()].sort((a, b) =>
    a.judgment.key.localeCompare(b.judgment.key),
  );
}

/** One pair's current rule judgment, or null when it is no longer a candidate. */
async function buildTransferPair(
  db: Database,
  key: string,
): Promise<Pair | null> {
  const legKeys = key.split("~");
  const cash = legKeys[1]?.startsWith("cash:");
  const pairs = await discover(db, {
    kind: "legs",
    keys: cash ? legKeys.slice(0, 1) : legKeys,
  });
  return pairs.find((pair) => pair.judgment.key === key) ?? null;
}

// ------------------------------------------------------------- publication

/** `Suggestion.data` of a transfer-pair suggestion. */
const transferPairStateData = z.object({
  pairKey: z.string(),
  outflowAccountId: z.uuid(),
  inflowAccountId: z.uuid(),
  legKeys: z.array(z.string()),
  /** Settlement refs of the statement legs, `source:externalId`. */
  refs: z.array(z.string()),
  clean: z.boolean(),
  /** The earlier leg's date. */
  date: z.string(),
  lastDate: z.string(),
  amount: z.number(),
  evidenceFingerprint: z.string(),
  needsLabel: z.boolean(),
  /** Model publication committed; dependent statement publications still need to finish. */
  statementRefreshPending: z.boolean().default(false),
});
type TransferPairStateData = z.infer<typeof transferPairStateData>;

/** Labels can resolve weak movement only; structural blockers stay for review. */
const transferPairNeedsLabels = (judgment: TransferPairJudgment) =>
  judgment.apply.available &&
  judgment.blockers.length === 1 &&
  judgment.blockers[0] === "weak_movement" &&
  judgment.inflow.origin !== "cash" &&
  (judgment.outflow.movementLabel === null ||
    judgment.inflow.movementLabel === null);

const isRule = (producer: SuggestionProducer) => producer.kind === "rule";

/** Acquire shared leg locks before any review-state or settlement-ref locks. */
async function lockTransferPairLegs(db: Database, pairKey: string) {
  for (const key of [...new Set(pairKey.split("~"))].sort())
    await advisoryXactLock(getDb(db), "transfer-pair-leg", key);
}

/**
 * The `transfer_pair` Suggestion family: one slot per pair key. Unchanged
 * evidence is reconfirmed under the current Run, keeping labels a rule
 * re-run would drop.
 */
export const transferPairSuggestions: SuggestionFamilyDeclaration<"transfer_pair"> &
  SuggestionFamily<Pair, SuggestionRow, "unavailable"> = {
  family: suggestionFamily.enum.transfer_pair,
  applicationKind: "transfer_pair",
  applicationError:
    "Transfer-pair application requires a transfer-pair Suggestion.",
  financial: true,
  suppressionKey: (subject) => ({
    scope: "transfer_pair",
    candidateKey: subject.pairKey,
    error: "Suppression differs from the transfer pair",
  }),
  pairKey: (row) => row.evidence.key,
  slot: ({ judgment }) => ({
    lock: advisoryLockKey("transfer-pair", judgment.key),
    fields: { pairKey: judgment.key },
  }),
  fingerprint: ({ judgment }) => fingerprintTransferPair(judgment),
  evidenceFingerprint: ({ judgment }) =>
    transferPairEvidenceFingerprint(judgment),
  suppresses: revisionSuppresses,
  // A pair whose legs cannot be paired would leave a pending row only dismissal clears.
  unapplicable: ({ judgment }) =>
    judgment.apply.available ? null : "unavailable",
  onUnchanged: { reconfirm: "transfer_pair_reconfirmed" },
  publication: (pair, prior, producer, fingerprints) => {
    const { judgment } = pair;
    const { fingerprint, evidenceFingerprint } = fingerprints;
    const data: TransferPairStateData = {
      pairKey: judgment.key,
      outflowAccountId: pair.outflowAccountId,
      inflowAccountId: pair.inflowAccountId,
      legKeys: [judgment.outflow.key, judgment.inflow.key],
      refs: [judgment.outflow, judgment.inflow].flatMap((leg) =>
        leg.origin === "statement"
          ? leg.refs.map((ref) => `${ref.source}:${ref.externalId}`)
          : [],
      ),
      clean: judgment.clean,
      date: judgment.date,
      lastDate:
        judgment.outflow.date > judgment.inflow.date
          ? judgment.outflow.date
          : judgment.inflow.date,
      amount: judgment.amount,
      evidenceFingerprint,
      needsLabel: isRule(producer) && transferPairNeedsLabels(judgment),
      statementRefreshPending:
        !isRule(producer) &&
        [judgment.outflow, judgment.inflow].some((leg) => leg.charge !== null),
    };
    return {
      input: {
        publicationKey: `transfer_pair:${judgment.key}:${fingerprint}:${prior.length}`,
        family: "transfer_pair",
        subject: {
          kind: "transfer_pair",
          entity: "financialAccount",
          recordId: pair.outflowAccountId,
          pairKey: judgment.key,
        },
        judgment,
        fingerprint,
        producer,
        evidence: { legs: data.legKeys },
      },
      projection: {
        model: producer.model ?? "rule",
        confidence: judgment.clean ? 1 : 0,
        runId: producer.runId,
        data,
      },
    };
  },
  // Rule pairs awaiting movement labels, or committed model publications
  // awaiting their statement refresh.
  labelBacklog: sql`((s.judgment#>>'{outflow,charge,chargeKey}' IS NULL OR s.judgment#>>'{outflow,charge,chargeKey}' LIKE 'SOC-%') AND (s.judgment#>>'{inflow,charge,chargeKey}' IS NULL OR s.judgment#>>'{inflow,charge,chargeKey}' LIKE 'SOC-%')) AND ((s.active AND s.status = ${suggestionStatus.enum.pending} AND (s.data->>'needsLabel')::boolean)
    OR coalesce((s.data->>'statementRefreshPending')::boolean, false))`,
  facts: (query) => {
    const { status, runId } = query.filters;
    const legs = ["outflow", "inflow"] as const;
    const legArray = (value: (end: (typeof legs)[number]) => SQL) =>
      sql`array_remove(ARRAY[${sql.join(legs.map(value), sql`, `)}], NULL)`;
    return {
      columns: {
        clean: sql`coalesce((s.judgment->>'clean')::boolean, false)`,
        strength: sql`CASE WHEN s.judgment->'blockers' ?| ARRAY[${sql.join(
          TRANSFER_WEAK_BLOCKERS.map((blocker) => sql`${blocker}`),
          sql`, `,
        )}]::text[] THEN ${"weak"}
          WHEN s.judgment->'blockers' ? ${"date_gap"} THEN ${"medium"} ELSE ${"strong"} END`,
        createdAt: sql`to_char(s."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        date: sql`s.judgment->>${"date"}`,
        amount: sql`s.judgment->>${"amount"}`,
        dateGapDays: sql`s.judgment->>${"dateGapDays"}`,
        account: legArray((end) => sql`s.judgment->${end}->>${"accountId"}`),
        owner: legArray((end) => sql`s.judgment->${end}->${"owner"}->>${"id"}`),
        merchant: sql`ARRAY[concat_ws(' ', ${sql.join(
          [
            ...legs.map((end) => sql`s.judgment->${end}->>${"merchant"}`),
            ...legs.map((end) => sql`s.judgment->${end}->>${"description"}`),
          ],
          sql`, `,
        )})]`,
      },
      from: sql`"Suggestion" s`,
      where: sql`s.family = ${suggestionFamily.enum.transfer_pair} AND s.status = ${status}
        ${status === suggestionStatus.enum.pending ? sql`AND s.active` : sql``}
        AND ${suggestionIdScope(query.suggestionIds, sql`s.id`)}
        ${runId ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${runId})` : sql``}`,
    };
  },
  keys: async (db, query) =>
    (await transferPairRows(db, query)).map((row) => ({
      family: "transfer_pair",
      suggestionId: row.id,
      status: query.filters.status,
      fingerprint: row.fingerprint,
      clean: row.evidence.clean,
      strength: row.evidence.blockers.some((reason) =>
        TRANSFER_WEAK_BLOCKERS.includes(reason),
      )
        ? "weak"
        : row.evidence.blockers.includes("date_gap")
          ? "medium"
          : "strong",
      impact: [outcome("Transfer paired")],
      createdAt: row.createdAt,
      matchedRules: [],
      automaticRule: null,
      columns: {
        date: row.evidence.date,
        amount: row.evidence.amount,
        dateGapDays: row.evidence.dateGapDays,
        account: [
          row.evidence.outflow.accountId,
          row.evidence.inflow.accountId,
        ],
        owner: [
          row.evidence.outflow.owner?.id ?? null,
          row.evidence.inflow.owner?.id ?? null,
        ],
        merchant: [
          row.evidence.outflow.merchant,
          row.evidence.inflow.merchant,
          row.evidence.outflow.description,
          row.evidence.inflow.description,
        ]
          .filter(Boolean)
          .join(" "),
      },
    })),
  rows: async (db, keys) => {
    if (!keys.length) return new Map();
    const rows = await transferPairRows(
      db,
      {
        filters: { status: keys[0]?.status ?? "pending" },
      },
      keys.map((key) => key.suggestionId),
    );
    const byId = new Map(keys.map((key) => [key.suggestionId, key]));
    return new Map(
      rows.flatMap((row) => {
        const key = byId.get(row.id);
        if (!key) return [];
        return [
          [
            row.id,
            transferPairSuggestionRow.parse({
              ...keyBase(key),
              family: "transfer_pair",
              record: {
                entity: "financialAccount",
                id: row.evidence.outflow.accountId,
              },
              other: {
                entity: "financialAccount",
                id: row.evidence.inflow.accountId,
              },
              summary: [
                { kind: "amount", amount: row.evidence.outflow.amount },
                { kind: "date", date: row.evidence.date },
                {
                  kind: "text",
                  text:
                    row.evidence.outflow.description ??
                    row.evidence.outflow.accountName,
                },
              ],
              actions: row.evidence.apply.available
                ? verbs("accept", "reject", "dismiss")
                : verbs("reject", "dismiss"),
              evidence: row.evidence,
            }),
          ],
        ];
      }),
    );
  },
  outcomes: outcomes("transfer_pair"),
  acceptAsIs: (row) =>
    row.evidence.clean
      ? {
          ...cleanAcceptance(row),
          application: { kind: "transfer_pair" },
        }
      : null,
  ...suggestionReviewFamilies.transfer_pair,
  ...declareAffectedRecords({
    roles: ["outflow", "inflow", "account", "transaction", "owner"],
    forward: () => sql`${leg("outflow")} || ${leg("inflow")}`,
    references: (["outflow", "inflow"] as const).flatMap((end) => [
      {
        kind: "value" as const,
        at: { column: "judgment" as const, path: [end, "accountId"] },
        entity: entities.financialAccount,
      },
      {
        kind: "value" as const,
        subject: true,
        at: { column: "judgment" as const, path: [end, "transactionId"] },
        entity: entities.financialTransaction,
      },
      {
        kind: "value" as const,
        at: { column: "judgment" as const, path: [end, "owner", "id"] },
        entity: entities.ledgerParty,
      },
    ]),
  }),
  actionable: sql`true`,
  lockForApply: async (db, prediction) => {
    const subject = suggestionSubjects.transfer_pair.parse(prediction.subject);
    await lockTransferPairLegs(db, subject.pairKey);
  },
  apply: async (db, context, state, input) => {
    if (
      input.verdict !== "correct" ||
      input.correction.present ||
      input.application?.kind !== "transfer_pair"
    )
      throw new Error(
        "Transfer pairing requires member acceptance of the current pair.",
      );
    await applyTransferPairSuggestion(db, context, state);
  },
};

type StoredPair = {
  id: string;
  fingerprint: string | null;
  data: TransferPairStateData;
  judgment: TransferPairJudgment;
};

/** Active pairs; `pending` also requires a pending status. */
async function storedPairs(
  db: Database,
  where: SQL,
  status: "pending" | "any" = "pending",
): Promise<StoredPair[]> {
  const rows = await unwrapDb(db).execute<{
    id: string;
    fingerprint: string | null;
    data: unknown;
    judgment: unknown;
  }>(
    sql`
    SELECT s.id::text AS id, s.fingerprint, s.data, s.judgment
    FROM "Suggestion" s
    WHERE s.family = ${suggestionFamily.enum.transfer_pair} AND s.active
      ${status === "pending" ? sql`AND s.status = ${suggestionStatus.enum.pending}` : sql``}
      AND ${where}
    ORDER BY s.data->>'pairKey'
  `,
    "objects",
  );
  return rows.map((row) => ({
    id: row.id,
    fingerprint: row.fingerprint,
    data: transferPairStateData.parse(row.data),
    judgment: transferPairJudgment.parse(row.judgment),
  }));
}

/**
 * Each charge's published pair, fresh only while today's rule evidence still
 * matches the stored evidence. A charge in several pending pairs has
 * competitors, so it is never clean. Never builds statement proposals.
 */

// ------------------------------------------------------------------ apply

/**
 * Create the missing legs and link the pair through `acceptFinancialTransferPair`,
 * in one transaction. `reviewed: false` (Accept clean, or a statement create
 * delegating here) refuses any pair that is not clean today; a cross-owner or
 * cash pair is never clean, so it needs a member's own review. Every refusal
 * rolls back the created legs.
 */
/** A source observation establishes posting only when it explicitly says so. */
async function currentStatementStatus(db: Database, leg: TransferPairLeg) {
  if (leg.origin === "cash") return financialTransactionStatus.enum.posted;
  if (!leg.charge)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A new transfer leg requires retained source identity.",
    );
  const rows = await unwrapDb(db).execute<{ providerStatus: unknown }>(
    sql`
    SELECT "providerStatus" FROM ${sourceObservationFactsFrom} WHERE source=${leg.charge.source}
      AND "chargeKey"=${leg.charge.chargeKey} AND current AND "withdrawnAt" IS NULL AND ${notDeleted("SourceTransactionRecord")}
  `,
    "objects",
  );
  if (rows.length !== 1)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "The transfer's current source observation changed. Review again.",
    );
  return (
    financialTransactionProviderStatus
      .nullable()
      .parse(rows[0]!.providerStatus) ??
    financialTransactionStatus.enum.observed
  );
}

async function applyTransferPair(
  db: Database,
  context: EntityKernelContext,
  input: {
    key: string;
    expectedFingerprint: string;
    reviewed?: boolean;
    /** The suggestion being applied, which its own handler marks applied. */
    stateId?: string;
  },
) {
  const actor = context.actorContext;
  return withTransaction(db, async (tx) => {
    const txDb = databaseForTransaction(tx);
    await assertWorkflowEffect(txDb);
    const legKeys = input.key.split("~");
    // Leg locks serialize every apply naming a leg, so a racing or replayed
    // accept rereads after the winner commits and finds the leg taken.
    await lockTransferPairLegs(txDb, input.key);
    const initial = await buildTransferPair(txDb, input.key);
    if (initial) {
      const legs = [initial.judgment.outflow, initial.judgment.inflow];
      await lockFinancialEvidenceKeys(
        tx,
        "source",
        legs.flatMap((leg) => (leg.charge ? [leg.charge.source] : [])),
      );
      await lockFinancialTransactionSources(
        tx,
        legs.flatMap((leg) => (leg.transactionId ? [leg.transactionId] : [])),
        legs.flatMap((leg) => leg.refs),
      );
    }
    const current = await buildTransferPair(txDb, input.key);
    if (!current)
      throw refused(
        "This transfer pair is no longer a candidate: a leg was paired, matched or removed. Refresh suggestions and review again.",
      );
    const raw = current.judgment;
    const { assertStatementSourceIdentity } =
      await import("~/server/domains/transaction-import/repo/statement-source-identity");
    await assertStatementSourceIdentity(
      txDb,
      [raw.outflow, raw.inflow].flatMap((leg) =>
        leg.charge ? [leg.charge] : [],
      ),
      [raw.outflow, raw.inflow].flatMap((leg) =>
        !leg.transactionId && leg.charge ? [leg.charge] : [],
      ),
    );
    // Any status: the suggestion's own handler marks it applied first.
    const published = (
      await storedPairs(txDb, sql`s.data->>'pairKey' = ${input.key}`, "any")
    ).find((pair) => pair.fingerprint === input.expectedFingerprint);
    let judgment: TransferPairJudgment;
    if (published) {
      if (
        (await transferPairEvidenceFingerprint(raw)) !==
        published.data.evidenceFingerprint
      )
        throw refused(
          "The transfer evidence changed since this pair was suggested. Refresh suggestions and review again.",
        );
      judgment = labelTransferPair(raw, {
        outflow: published.judgment.outflow.movementLabel,
        inflow: published.judgment.inflow.movementLabel,
      });
    } else if (
      (await fingerprintTransferPair(raw)) === input.expectedFingerprint
    )
      judgment = raw;
    else
      throw refused(
        "The transfer evidence changed since this pair was suggested. Refresh suggestions and review again.",
      );
    if (!judgment.apply.available) throw refused(judgment.apply.reason!);
    if (!input.reviewed && !judgment.clean)
      throw refused(
        `This pair needs review before it can be accepted: ${judgment.reasons.join(" ")}`,
      );

    const create = async (leg: TransferPairLeg) => {
      if (leg.transactionId) return leg.transactionId;
      const status = await currentStatementStatus(txDb, leg);
      if (leg.charge)
        await updateSourceTransactionRecords(
          txDb,
          {
            selector: {
              source: leg.charge.source,
              externalIds: leg.refs
                .filter((ref) => ref.source === leg.charge!.source)
                .map((ref) => ref.externalId),
            },
            data: { accountId: leg.accountId },
          },
          actor,
        );
      const { output } = await createFinancialTransaction(
        txDb,
        financialTransactionCreateInput.parse({
          accountId: leg.accountId,
          purchaseId: null,
          kind: leg.kind,
          status,
          amount: leg.amount,
          transactionDate:
            status !== "posted" || leg.origin === "cash" ? leg.date : null,
          postedDate: status === "posted" ? leg.date : null,
          merchant: leg.merchant,
          rawDescription: leg.description,
          sourceCategory: leg.signals.providerCategory,
          sourceRefs: leg.refs,
          notes: null,
        }),
        actor,
      );
      if (!output)
        throw new Error(
          "Created transfer leg was not readable in its transaction",
        );
      return output.id;
    };
    const outflowTransactionId = await create(judgment.outflow);
    const inflowTransactionId = await create(judgment.inflow);
    const accepted = await acceptFinancialTransferPair(
      txDb,
      { outflowTransactionId, inflowTransactionId },
      actor,
    );
    if (!accepted.canProceed) throw refused(accepted.reason);
    // Every other pending pair naming either leg lost it.
    await transitionSuggestionStates(
      tx,
      sql`${suggestionTable.family} = ${suggestionFamily.enum.transfer_pair} AND ${suggestionTable.active} AND ${suggestionTable.status} = ${suggestionStatus.enum.pending}
        AND ${suggestionTable.data}->'legKeys' ?| ARRAY[${sql.join(
          legKeys.map((key) => sql`${key}`),
          sql`, `,
        )}]::text[]
        ${input.stateId ? sql`AND ${suggestionTable.id} <> ${input.stateId}::uuid` : sql``}`,
      { active: false, status: "superseded" },
    );
    return {
      transferId: accepted.transferId,
      outflowTransactionId,
      inflowTransactionId,
      internalMove: accepted.internalMove,
    };
  });
}

/** The `transfer_pair` family's review apply: the member accepts the published pair. */
async function applyTransferPairSuggestion(
  db: Database,
  context: EntityKernelContext,
  state: SuggestionStateRow,
) {
  return withTransactionDatabase(db, async (tx) => {
    await assertWorkflowEffect(tx);
    const [prediction] = await getDb(tx)
      .select({
        subject: suggestionTable.subject,
        judgment: suggestionTable.judgment,
      })
      .from(suggestionTable)
      .where(eq(suggestionTable.id, state.id))
      .limit(1);
    const subject = suggestionSubjects.transfer_pair.parse(prediction?.subject);
    const published = transferPairJudgment.parse(prediction?.judgment);
    if (state.status !== "pending" || !state.fingerprint)
      throw refused("This transfer pair suggestion is no longer pending.");
    await transitionSuggestionState(tx, state.id, { status: "applied" });
    await applyTransferPair(tx, context, {
      key: subject.pairKey,
      expectedFingerprint: state.fingerprint,
      // Accepting a clean pair still holds it to today's clean rule.
      reviewed: !published.clean,
      stateId: state.id,
    });
  });
}
