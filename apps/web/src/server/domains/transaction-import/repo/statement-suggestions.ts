import { suggestionStatus } from "@cubby/schemas/ai";
import { financialAccountSourceAliases } from "@cubby/schemas/financial-account";
import { financialBookingInput } from "@cubby/schemas/financial-booking";
import {
  FINANCIAL_STATEMENT_IMPORT_MAX_ROWS,
  type FinancialTransactionImportRow,
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import {
  financialTransactionSourceRef,
  financialTransactionProviderStatus,
} from "@cubby/schemas/financial-transaction-fields";
import { type RunId } from "@cubby/schemas/identifiers";
import { type RunStepError } from "@cubby/schemas/run-step";
import { sourceOccurrenceReviewState } from "@cubby/schemas/source-occurrence-fields";
import { sourceTransactionRecordProviderStatus } from "@cubby/schemas/source-transaction-record";
import { sourceTransactionRecordDisposition } from "@cubby/schemas/source-transaction-record-fields";
import {
  type StatementCounterparty,
  type StatementKindVotes,
  type StatementTransactionCandidate,
  statementTransactionAction,
  type StatementTransactionJudgment,
  STATEMENT_LABEL_REVISION,
  statementLabelCheckpoint,
  type StatementLabelCheckpoint,
  statementApplicationOrder,
} from "@cubby/schemas/statement-suggestion";
import {
  suggestionJudgments,
  suggestionSubjects,
  suggestionProjectionTargets,
  suggestionFamily,
  suggestionProducer,
  type SuggestionProducer,
  feedbackEvent,
  feedbackVerdict,
} from "@cubby/schemas/suggestion";
import { statementSuggestionRow } from "@cubby/schemas/suggestion-list";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { cents } from "@cubby/shared";
import { JOB_PAGE_LIMITS } from "@cubby/shared/job-page-limits";
import { sha256Hex } from "@cubby/shared/sha256";
import { createLogger } from "@cubby/worker-tracing";
import { sql, and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";

import { forEachConcurrently } from "~/lib/concurrency-limiter";
import { plainDateDaysBetween } from "~/lib/household-date";
import { type Database } from "~/server/db";
import {
  getDb,
  runAfterCommit,
  unwrapDb,
  withTransactionDatabase,
  withSnapshotWriteDatabase,
} from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { suggestionTable } from "~/server/db/schema";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { financialSourceReferenceRows } from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import {
  previewFinancialTransactionImport,
  prepareFinancialStatementPreview,
} from "~/server/domains/financial-transaction/repo/financial-statement-preview";
import { type FinancialTransactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import {
  findTransferPairsForCharges,
  transferPairSourceCharges,
} from "~/server/domains/financial-transaction/repo/transfer-pair-suggestions";
import {
  sourceObservations,
  sourceObservationIdentities,
} from "~/server/domains/transaction-import/repo/source-observation-state";
import { PROVIDER_IDENTITY_REVIEW } from "~/server/domains/transaction-import/repo/source-transaction-record-identity";
import {
  chargeKeyOf,
  chargeStateOf,
  hasStatementOccurrence,
  OCCURRENCE_IDENTITY_REVIEW,
  pendingSuggestion,
  sourceSuggestionAutomaticEligible,
  suggestionField,
  suggestionRefKey,
} from "~/server/domains/transaction-import/repo/statement-charge";
import {
  statementLabelInputs,
  statementLabelSubject,
  statementCandidateSubject,
} from "~/server/domains/transaction-import/repo/statement-label-input";
import {
  readStatementSuggestions,
  statementSuggestionFacts,
  statementSuggestionKeys,
  statementSuggestionStatusCounts,
} from "~/server/domains/transaction-import/repo/statement-suggestion-read";
import {
  kindAgreed,
  decideStatementKind,
  type OwnAccount,
  ownAccountNamed,
  statementTransactionKind,
} from "~/server/domains/transaction-import/repo/statement-transaction-kind";
import { transactionImportMembers } from "~/server/domains/transaction-import/repo/transaction-import-membership";
import { createAppError } from "~/server/errors/app-error";
import { type PageWork, peakWorkers } from "~/server/generic/jobs/page-work";
import {
  automaticRuleStamp,
  importOnlyStatementRuleStamps,
  matchStatementRules,
} from "~/server/generic/suggestions/repo/automatic-policy";
import {
  publishSuggestion as publishStoredSuggestion,
  publishSuggestions,
  matchedRulesOf,
} from "~/server/generic/suggestions/repo/suggestion";
import { type SuggestionFamilyDeclaration } from "~/server/generic/suggestions/repo/suggestion-family-declaration";
import {
  stamps,
  verbs,
  keyBase,
  statementImpact,
  statementStrength,
  otherTransaction,
  statementAcceptApplication,
  statementScope,
} from "~/server/generic/suggestions/repo/suggestion-presentation";
import {
  countSuggestionLabelBacklog,
  inSuggestionBatches,
  lockSuggestionSlots,
  publishSuggestion,
  publishSuggestionBatches,
  retireSupersededSuggestions,
  type SuggestionFamily,
  type SuggestionOutcome,
  type SuggestionRow,
  unchangedSuggestions,
} from "~/server/generic/suggestions/repo/suggestion-publication";
import {
  statementRecords,
  statementReferenceMatch,
  declareAffectedRecords,
} from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import { transitionSuggestionStates } from "~/server/generic/suggestions/repo/suggestion-state";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";
import {
  assertWorkflowEffect,
  isWorkflowInterrupted,
} from "~/server/workflows/runs/execution";
import { runFailureText } from "~/server/workflows/runs/lifecycle";

import {
  statementHoldAccounts as holdAccounts,
  statementInputCharges,
  statementInputChargeKeys,
  scopedStatementChargeKeys,
  statementPendingInputTransactions,
  type StatementSuggestionScope,
} from "./statement-input";
import {
  prepareStatementSpending,
  prepareStatementSpendingPage,
} from "./statement-spending";

const STATE = "Suggestion";
const log = createLogger("statement-suggestions");
const pendingStatementState = sql`${suggestionTable.family} = ${suggestionFamily.enum.statement_transaction} AND ${suggestionTable.active} AND ${suggestionTable.status} = ${suggestionStatus.enum.pending}`;
const stateData = z.record(z.string(), z.json());

/** Matching revision and Automatic attach rule revision; clean-only changes use the policy below. */
export const STATEMENT_SUGGESTION_REVISION = "2026-10-21.1";
/**
 * Bump when only bulk-acceptability changes. Labels ride on top of the
 * evidence fingerprint, so a stricter clean rule would otherwise leave
 * labelled judgments looking current; this republishes them without
 * renaming the revision, which the automatic attach rule's measured windows
 * are keyed by.
 */
const STATEMENT_CLEAN_POLICY = "2026-10-29.3";
const STATEMENT_SUGGESTION_PAGE = FINANCIAL_STATEMENT_IMPORT_MAX_ROWS;
/** A hold's posted twin lands within this window, and a vanished hold is judged after it. */
const PENDING_POST_WINDOW_DAYS = 7;
const SIBLING_WINDOW_DAYS = 3;
/** Merchant history votes only once this many member-made transactions agree. */
const HISTORY_MIN_TRANSACTIONS = 2;

/**
 * Charges published at once, by generation and label pages alike. Each publish holds a pooled
 * connection for its transaction, and the Hyperdrive pools the app's requests
 * share are capped at 12, so a Sweep keeps most of them free.
 */
export const STATEMENT_PUBLISH_CONCURRENCY = 4;

export type ChargeRef = { source: string; chargeKey: string };
export const chargeId = (charge: ChargeRef) =>
  `${charge.source}:${charge.chargeKey}`;

export function statementChargeFromWorkRef(ref: string): ChargeRef | null {
  const match = /^charge:([^:]+):(.+)$/.exec(ref);
  return match?.[1] && match[2]
    ? { source: match[1], chargeKey: match[2] }
    : null;
}

type Observation = {
  occurrenceId: string | null;
  occurrenceVersion: number | null;
  reviewState: string | null;
  id: string;
  source: string;
  externalId: string;
  chargeKey: string;
  rowPosition: number | null;
  providerTransactionId: string | null;
  providerAccountId: string | null;
  accountDescriptor: string;
  statementDate: string;
  providerAmount: number;
  amount: number;
  merchant: string | null;
  rawDescription: string;
  sourceCategory: string | null;
  providerStatus: "posted" | "pending" | null;
  providerNotes: string | null;
  withdrawnAt: string | null;
  accountId: string | null;
  createdAt: string;
  importFingerprint: string;
};

export type ChargeProposal = {
  charge: ChargeRef;
  canonical: Observation;
  observations: Observation[];
  judgment: StatementTransactionJudgment;
  /** Publication fingerprint: the evidence plus any model labels. */
  fingerprint: string;
  /** The ledger and transaction evidence alone, recomputed at apply. */
  evidenceFingerprint: string;
  providerScopeFingerprint?: string;
  /** Every retained source leg the proposed action can write. */
  providerScopeCharges?: readonly ChargeRef[];
  refs: string[];
};

const plainDateOf = (value: unknown) =>
  value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
    : String(value).slice(0, 10);

const tuples = (charges: readonly ChargeRef[]) =>
  sql.join(
    charges.map((charge) => sql`(${charge.source}, ${charge.chargeKey})`),
    sql`, `,
  );

export type { StatementSuggestionScope } from "./statement-input";

/** Unmatched charges in `(source, chargeKey)` order after the cursor. */
async function nextUnmatchedCharges(
  db: Database,
  input: {
    after: ChargeRef | null;
    limit: number;
    scope: StatementSuggestionScope;
  },
): Promise<ChargeRef[]> {
  const result: ChargeRef[] = [];
  let after = input.after;
  for (;;) {
    const { rows: keys } = await unwrapDb(db).execute<ChargeRef>(
      statementInputChargeKeys(input.scope, after, input.limit),
    );
    if (!keys.length) return result;
    const { rows } = await unwrapDb(db).execute<ChargeRef>(sql`
      SELECT cs.source,cs."chargeKey" FROM (${statementInputCharges(input.scope, keys)}) cs
      ORDER BY cs.source,cs."chargeKey"`);
    result.push(
      ...rows.map((row) => ({ source: row.source, chargeKey: row.chargeKey })),
    );
    if (result.length >= input.limit) return result.slice(0, input.limit);
    if (keys.length < input.limit) return result;
    after = keys.at(-1)!;
  }
}

/**
 * Charge work within the import/date bounds: unmatched charges and matched,
 * unallocated spending, plus pending booking work that may now be complete.
 */
export async function countUnmatchedCharges(
  db: Database,
  scope: StatementSuggestionScope,
) {
  // Counting has no cursor: aggregate eligibility once rather than rebuilding
  // its joins for every raw identity chunk. Generation still bounds each page.
  const { rows } = await unwrapDb(db).execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM (${statementInputCharges(scope)}) inputs
  `);
  return rows[0]?.count ?? 0;
}

async function loadObservations(
  db: Database,
  charges: readonly ChargeRef[],
): Promise<Observation[]> {
  if (!charges.length) return [];
  const { rows } = await unwrapDb(db).execute<
    Record<string, string | number | Date | null>
  >(sql`
    SELECT r.id, r."occurrenceId", r."occurrenceVersion", r."reviewState", r.source, r."externalId", ${chargeKeyOf("r")} AS "chargeKey",
      r."rowPosition", r."providerTransactionId", r."providerAccountId", r."accountDescriptor",
      r."statementDate", r."providerAmount", r.amount, r.merchant,
      r."rawDescription", r."sourceCategory", r."providerStatus",
      r."providerNotes", r."withdrawnAt", r."accountId", r."createdAt", si.fingerprint AS "importFingerprint"
    FROM ${sourceObservations} r
    JOIN "TransactionImport" si ON si.id = r."batchId"
    WHERE ${notDeleted("r")}
      AND (r.source, ${chargeKeyOf("r")}) IN (${tuples(charges)})
    ORDER BY r.current DESC, r."lastObservedAt" DESC, r."createdAt" DESC, r.id
  `);
  return rows.map((row) => ({
    occurrenceId: row.occurrenceId === null ? null : String(row.occurrenceId),
    occurrenceVersion:
      row.occurrenceVersion === null ? null : Number(row.occurrenceVersion),
    reviewState: row.reviewState === null ? null : String(row.reviewState),
    id: String(row.id),
    source: String(row.source),
    externalId: String(row.externalId),
    chargeKey: String(row.chargeKey),
    rowPosition: row.rowPosition === null ? null : Number(row.rowPosition),
    providerTransactionId:
      row.providerTransactionId === null
        ? null
        : String(row.providerTransactionId),
    providerAccountId:
      row.providerAccountId === null ? null : String(row.providerAccountId),
    accountDescriptor: String(row.accountDescriptor),
    statementDate: plainDateOf(row.statementDate),
    providerAmount: Number(row.providerAmount),
    amount: Number(row.amount),
    merchant: row.merchant === null ? null : String(row.merchant),
    rawDescription: String(row.rawDescription),
    sourceCategory:
      row.sourceCategory === null ? null : String(row.sourceCategory),
    providerStatus:
      row.providerStatus === null
        ? null
        : financialTransactionProviderStatus.parse(row.providerStatus),
    providerNotes:
      row.providerNotes === null ? null : String(row.providerNotes),
    withdrawnAt: row.withdrawnAt === null ? null : String(row.withdrawnAt),
    accountId: row.accountId === null ? null : String(row.accountId),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
    importFingerprint: String(row.importFingerprint),
  }));
}

/** The newest observation with a physical position names the charge's settlement ref. */
const canonicalObservation = (observations: Observation[]) => observations[0]!;

const previewRowFor = (
  charge: ChargeRef,
  row: Observation,
): FinancialTransactionImportRow => ({
  key: chargeId(charge),
  source: row.source,
  account: row.accountDescriptor,
  date: row.statementDate,
  amount: row.providerAmount,
  merchant: row.merchant,
  originalStatement: row.rawDescription,
  category: row.sourceCategory,
  notes: row.providerNotes,
  importFingerprint: row.importFingerprint,
  ...(row.rowPosition === null ? {} : { rowPosition: row.rowPosition }),
  providerTransactionId: row.providerTransactionId,
  providerAccountId: row.providerAccountId,
  ...(row.providerStatus ? { providerStatus: row.providerStatus } : {}),
});

type PendingTransaction = {
  id: string;
  accountId: string;
  amount: number;
  status: "pending";
  postedDate: string | null;
  transactionDate: string | null;
  merchant: string | null;
  rawDescription: string | null;
  pendingRowIds: string[];
};

/**
 * Pending transactions whose every live settlement ref names a statement row
 * the provider reported as pending: holds this ledger itself recorded.
 */
async function statementPendingTransactions(
  db: Database,
  accountIds: readonly string[],
  input?: Parameters<typeof statementPendingInputTransactions>[1],
): Promise<PendingTransaction[]> {
  if (!accountIds.length) return [];
  const { rows } = await unwrapDb(db).execute<
    Record<string, string | number | Date | null | string[]>
  >(statementPendingInputTransactions(accountIds, input));
  return rows.map((row) => ({
    id: String(row.id),
    accountId: String(row.accountId),
    amount: Number(row.amount),
    status: "pending",
    postedDate: row.postedDate === null ? null : plainDateOf(row.postedDate),
    transactionDate:
      row.transactionDate === null ? null : plainDateOf(row.transactionDate),
    merchant: row.merchant === null ? null : String(row.merchant),
    rawDescription:
      row.rawDescription === null ? null : String(row.rawDescription),
    pendingRowIds: z.array(z.string()).parse(row.pendingRowIds).sort(),
  }));
}

/**
 * A posted amount may exceed its hold by a tip or incidentals: up to the
 * larger of 25% or $20, never below it, same direction, within the window.
 */
export function pendingPostedMatch(
  pending: { amount: number; date: string | null },
  posted: { amount: number; date: string },
): boolean {
  if (!pending.date) return false;
  if (Math.sign(pending.amount) !== Math.sign(posted.amount)) return false;
  const held = Math.abs(cents(pending.amount));
  const settled = Math.abs(cents(posted.amount));
  const allowance = Math.max(Math.round(held * 0.25), 2000);
  return (
    settled >= held &&
    settled <= held + allowance &&
    Math.abs(plainDateDaysBetween(pending.date, posted.date)) <=
      PENDING_POST_WINDOW_DAYS
  );
}

async function siblingsFor(
  db: Database,
  proposals: readonly { charge: ChargeRef; observations: Observation[] }[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!proposals.length) return result;
  const values = sql.join(
    proposals.map(({ charge, observations }) => {
      const row = observations[0]!;
      return sql`(${chargeId(charge)}, ${charge.source}, ${charge.chargeKey}, ${row.accountDescriptor}, ${row.providerAmount}::numeric, ${row.statementDate}::date, ${`{${observations.map((o) => o.id).join(",")}}`}::uuid[])`;
    }),
    sql`, `,
  );
  // Each stage is materialized and scoped to this page's candidates, so the
  // charge-state aggregate and membership union never scan the whole ledger.
  const { rows } = await unwrapDb(db).execute<{
    key: string;
    siblings: string[];
  }>(sql`
    WITH p AS MATERIALIZED (
      SELECT * FROM (VALUES ${values}) AS v(key, source, "chargeKey", descriptor, amount, day, "rowIds")
    ),
    o AS MATERIALIZED (
      SELECT p.key, p."rowIds", o.id, o.source, o."batchId", o."rowPosition", o."providerTransactionId", ${chargeKeyOf("o")} AS "chargeKey"
      FROM p JOIN ${sourceObservations} o ON o.source = p.source
        AND normalize(o."accountDescriptor", NFKC) = normalize(p.descriptor, NFKC)
        AND o."providerAmount" = p.amount
        AND o."statementDate" BETWEEN p.day - ${SIBLING_WINDOW_DAYS}::int AND p.day + ${SIBLING_WINDOW_DAYS}::int
        AND ${notDeleted("o")}
        AND ${chargeKeyOf("o")} <> p."chargeKey"
    ),
    cs AS MATERIALIZED ${chargeStateOf(
      sql`(r.source, ${chargeKeyOf("r")}) IN (SELECT source, "chargeKey" FROM o)`,
    )},
    members AS MATERIALIZED (
      SELECT m."importId", m."statementRowId" FROM ${transactionImportMembers} m
      WHERE m."statementRowId" IN (SELECT id FROM o UNION SELECT unnest("rowIds") FROM p)
    )
    SELECT o.key, array_agg(DISTINCT o."chargeKey" ORDER BY o."chargeKey") AS siblings
    FROM o
    JOIN cs ON cs.source = o.source AND cs."chargeKey" = o."chargeKey"
      AND NOT cs.ignored AND NOT cs.superseded AND cs.shortcode IS NULL
    -- Historical membership can include unpositioned surplus rows. Independence
    -- needs attested provider identities or distinct positions in their original
    -- shared collection; membership alone cannot clear a possible overlap.
    WHERE NOT EXISTS (
      SELECT 1 FROM members mo
      JOIN members mp ON mp."importId" = mo."importId"
      JOIN ${sourceObservations} own ON own.id = mp."statementRowId"
      WHERE mo."statementRowId" = o.id AND mp."statementRowId" = ANY(o."rowIds")
        AND ${notDeleted("own")}
        AND ((o."providerTransactionId" IS NOT NULL AND own."providerTransactionId" IS NOT NULL)
          OR (o."batchId" = mo."importId" AND own."batchId" = mp."importId"
            AND o."rowPosition" IS NOT NULL AND own."rowPosition" IS NOT NULL
            AND o."rowPosition" <> own."rowPosition"))
    )
    GROUP BY o.key
  `);
  for (const row of rows) result.set(row.key, row.siblings.map(String));
  return result;
}

/**
 * Candidates per charge that already hold a settlement ref of another live
 * charge from the same source. Siblings only count unmatched charges, so once
 * one of two same-amount charges is attached, this is what still tells the
 * other one apart from a re-export of the same money.
 */
async function claimedCandidates(
  db: Database,
  pairs: readonly { charge: ChargeRef; transactionId: string }[],
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (!pairs.length) return result;
  const values = sql.join(
    pairs.map(
      ({ charge, transactionId }) =>
        sql`(${chargeId(charge)}, ${charge.source}, ${charge.chargeKey}, ${transactionId}::uuid)`,
    ),
    sql`, `,
  );
  const { rows } = await unwrapDb(db).execute<{
    key: string;
    transactionId: string;
  }>(sql`
    WITH p AS MATERIALIZED (
      SELECT * FROM (VALUES ${values}) AS v(key, source, "chargeKey", "transactionId")
    ),
    owners AS MATERIALIZED (
      SELECT p.key, p."transactionId" FROM p
      JOIN "SourceOccurrence" owner ON owner."acceptedTransactionId" = p."transactionId"
        AND owner.source = p.source AND owner.shortcode <> p."chargeKey"
        AND owner.disposition <> ${sqlEnumConstant(sourceTransactionRecordDisposition, sourceTransactionRecordDisposition.enum.ignored)} AND owner."supersededByOccurrenceId" IS NULL
      UNION
      SELECT p.key, p."transactionId" FROM p
      JOIN "FinancialEvidenceAlias" unresolved ON unresolved."historicalTransactionId" = p."transactionId"
        AND unresolved.source = p.source
      LEFT JOIN "SourceOccurrence" retained ON retained.id=unresolved."occurrenceId"
      WHERE retained.id IS NULL OR retained."acceptedTransactionId" IS DISTINCT FROM unresolved."historicalTransactionId"
    ) SELECT DISTINCT key, "transactionId" FROM owners
  `);
  for (const row of rows) {
    const set = result.get(row.key) ?? new Set<string>();
    set.add(String(row.transactionId));
    result.set(row.key, set);
  }
  return result;
}

type MerchantHistory = {
  kind: StatementKindVotes["history"];
  counterparty: StatementCounterparty["history"];
};

/**
 * Earlier live transactions on the same account, normalized merchant and
 * direction that a member created or chose. Direction keeps a card benefit
 * credit (an inflow adjustment) apart from the purchases it offsets. A transaction a clean suggestion created when
 * accepted as is records the rule's own vote, so it is left out: otherwise a
 * category rule would agree with itself after one bulk acceptance.
 */
async function merchantHistory(
  db: Database,
  charges: readonly {
    key: string;
    accountId: string;
    merchant: string | null;
    date: string;
    /** Cubby convention: positive is money out of the account. */
    amount: number;
  }[],
): Promise<Map<string, MerchantHistory>> {
  const result = new Map<string, MerchantHistory>();
  const asked = charges.filter((charge) => charge.merchant?.trim());
  if (!asked.length) return result;
  const values = sql.join(
    asked.map(
      (charge) =>
        sql`(${charge.key}, ${charge.accountId}::uuid, ${charge.merchant}, ${charge.date}::date, ${Math.sign(charge.amount)}::int)`,
    ),
    sql`, `,
  );
  const merchantKey = (column: SQL) =>
    sql`btrim(regexp_replace(lower(${column}), '\\s+', ' ', 'g'))`;
  const { rows } = await unwrapDb(db).execute<{
    key: string;
    kinds: string[];
    count: number;
    reimbursed: boolean;
    purchased: boolean;
  }>(sql`
    WITH p AS MATERIALIZED (
      SELECT v.key, v.account, ${merchantKey(sql`v.merchant`)} AS merchant, v.day, v.direction
      FROM (VALUES ${values}) AS v(key, account, merchant, day, direction)
    ),
    -- Transactions clean creates on these accounts made when accepted as is,
    -- derived once from retained accept decisions and their historical evidence. Ref keys split at the first ':', the
    -- separator suggestionRefKey writes after the source.
    ruled AS MATERIALIZED (
      SELECT DISTINCT fx.owner AS id
      FROM "Suggestion" s
      CROSS JOIN LATERAL jsonb_array_elements(s.decisions) f(event)
      CROSS JOIN LATERAL jsonb_array_elements_text(s.data->'refs') ref(key)
      JOIN ${financialSourceReferenceRows} fx ON fx.source = split_part(ref.key, ':', 1)
        AND fx."externalId" = substr(ref.key, length(split_part(ref.key, ':', 1)) + 2)
      WHERE s.family = ${suggestionFamily.enum.statement_transaction}
        AND (s.judgment->>'clean')::boolean
        AND s.judgment->>'recommended' = ${statementTransactionAction.enum.create}
        AND s.status = ${suggestionStatus.enum.applied}
        AND (${suggestionField("accountId")})::uuid IN (SELECT account FROM p)
        AND f.event->>'intent' = ${feedbackEvent.shape.intent.unwrap().enum.apply}
        AND f.event->>'verdict' = ${feedbackVerdict.enum.correct}
        AND f.event @> ${JSON.stringify({ correction: { present: false } })}::jsonb
    )
    SELECT p.key, array_agg(DISTINCT ft.kind) AS kinds, count(*)::int AS count,
      bool_or(EXISTS (
        SELECT 1 FROM "Expense" e
        WHERE e."bookingTransactionCode" = ft.shortcode AND ${notDeleted("e")}
          AND e."economicRole" = ${financialBookingInput.shape.economicRole.unwrap().enum.reimbursement}
      )) AS reimbursed,
      bool_or(EXISTS (
        SELECT 1 FROM "FinancialTransactionAllocation" fta
        JOIN "Purchase" pu ON pu.id = fta."purchaseId" AND ${notDeleted("pu")}
          AND pu."vendorId" IS NOT NULL
        WHERE fta."transactionId" = ft.id AND ${notDeleted("fta")}
      )) AS purchased
    FROM p
    JOIN "FinancialTransaction" ft ON ft."accountId" = p.account
      AND ${notDeleted("ft")} AND ft.status <> ${financialTransactionStatus.enum.void}
      AND ft.merchant IS NOT NULL AND ${merchantKey(sql`ft.merchant`)} = p.merchant
      AND COALESCE(ft."postedDate", ft."transactionDate") < p.day
      AND sign((ft."amountMinor"::numeric / 100))::int = p.direction
    WHERE ft.id NOT IN (SELECT id FROM ruled)
    GROUP BY p.key
  `);
  for (const row of rows) {
    if (Number(row.count) < HISTORY_MIN_TRANSACTIONS) continue;
    const kinds = z.array(financialTransactionKind).parse(row.kinds);
    result.set(row.key, {
      kind: kinds.length === 1 ? kinds[0]! : "mixed",
      counterparty: row.reimbursed
        ? "person"
        : row.purchased
          ? "business"
          : null,
    });
  }
  return result;
}

const diffFor = (
  candidate: {
    amount: number;
    status: string;
    postedDate: string | null;
  },
  row: {
    amount: number;
    status: "observed" | "posted" | "pending";
    date: string;
  },
) => {
  const fields: StatementTransactionCandidate["diff"] = [];
  if (cents(candidate.amount) !== cents(row.amount)) fields.push("amount");
  if (row.status === "posted" && candidate.postedDate !== row.date)
    fields.push("postedDate");
  if (candidate.status !== row.status) fields.push("status");
  return fields;
};

/**
 * Current proposals for these charges, computed from the ledger and the
 * transactions as they stand. Generation publishes them; apply recomputes them
 * and refuses when the fingerprint moved.
 */
function sourceCorrectionReason(
  priorTransaction:
    | Pick<
        FinancialTransactionDollars,
        "amount" | "status" | "transactionDate" | "postedDate"
      >
    | undefined,
  canonical: Pick<
    Observation,
    "amount" | "withdrawnAt" | "providerStatus" | "statementDate"
  >,
): string | null {
  return priorTransaction?.status === "void" && canonical.withdrawnAt === null
    ? "The source charge reappeared after its booking was retired. Review its FinancialTransaction and Expenses individually."
    : priorTransaction &&
        canonical.withdrawnAt !== null &&
        priorTransaction.status !== "void"
      ? "The provider withdrew this charge. Automatic correction is unavailable or paused; review its FinancialTransaction and Expenses individually."
      : priorTransaction &&
          canonical.withdrawnAt === null &&
          cents(Number(priorTransaction.amount)) !== cents(canonical.amount)
        ? "The provider amount changed. Automatic correction is unavailable or paused; review its FinancialTransaction, allocations and Expenses individually."
        : priorTransaction &&
            canonical.withdrawnAt === null &&
            sourceLifecycleDiffers(priorTransaction, canonical)
          ? "The source status or date changed. Automatic correction is unavailable; review its FinancialTransaction and dated booking individually."
          : null;
}

function sourceLifecycleDiffers(
  transaction: Pick<
    FinancialTransactionDollars,
    "status" | "transactionDate" | "postedDate"
  >,
  observation: Pick<Observation, "providerStatus" | "statementDate">,
) {
  if (observation.providerStatus === "posted")
    return (
      transaction.status !== "posted" ||
      transaction.postedDate !== observation.statementDate
    );
  return (
    observation.providerStatus === "pending" &&
    transaction.status !== "posted" &&
    (transaction.status !== "pending" ||
      transaction.transactionDate !== observation.statementDate)
  );
}

/** Shared live account resolution, including stored and accepted settlement hints. */
async function prepareChargePreviews(
  db: Database,
  charges: readonly ChargeRef[],
  sharedPreparation?: Awaited<
    ReturnType<typeof prepareFinancialStatementPreview>
  >,
) {
  const observations = await loadObservations(db, charges);
  const byCharge = new Map<string, Observation[]>();
  for (const row of observations) {
    const key = chargeId(row);
    byCharge.set(key, [...(byCharge.get(key) ?? []), row]);
  }
  const grouped = charges.flatMap((charge) => {
    const rows = byCharge.get(chargeId(charge));
    return rows?.length
      ? [{ charge, observations: rows, canonical: canonicalObservation(rows) }]
      : [];
  });
  if (!grouped.length) return null;
  const { rows: matchedCharges } = await unwrapDb(db).execute<{
    source: string;
    chargeKey: string;
    shortcode: string;
  }>(sql`
    SELECT cs.source, cs."chargeKey", cs.shortcode FROM ${chargeStateOf(sql`(r.source, ${chargeKeyOf("r")}) IN (${tuples(charges)})`)} cs
    WHERE cs.shortcode IS NOT NULL
      AND NOT cs.ignored AND NOT cs.superseded
  `);
  const matchedByCharge = new Map(
    matchedCharges.map((row) => [chargeId(row), row.shortcode]),
  );
  const { rows: acceptedRows } = matchedByCharge.size
    ? await unwrapDb(db).execute<{
        shortcode: string;
        accountId: string;
        amount: number;
        status: FinancialTransactionDollars["status"];
        transactionDate: string | null;
        postedDate: string | null;
      }>(sql`
    SELECT ft.shortcode, ft."accountId", (ft."amountMinor"::numeric / 100)::float8 AS amount, ft.status, ft."transactionDate"::text AS "transactionDate", ft."postedDate"::text AS "postedDate" FROM "FinancialTransaction" ft
    WHERE ${notDeleted("ft")} AND ft.shortcode IN (${sql.join(
      [...matchedByCharge.values()].map((code) => sql`${code}`),
      sql`,`,
    )})
  `)
    : { rows: [] };
  const accepted = new Map(acceptedRows.map((row) => [row.shortcode, row]));
  const preparation =
    sharedPreparation ?? (await prepareFinancialStatementPreview(db));
  const pairsByCharge = await findTransferPairsForCharges(db, charges);
  const providerScopeCharges = new Map(
    [...pairsByCharge].map(([key, pair]) => [
      key,
      transferPairSourceCharges(pair.key),
    ]),
  );
  const providerFacts = await providerActionIdentityFacts(
    db,
    grouped.map((input) => ({
      ...input,
      providerScopeCharges: providerScopeCharges.get(chargeId(input.charge)),
    })),
    preparation.accounts,
  );
  const preview = await previewFinancialTransactionImport(
    db,
    {
      rows: grouped.map(({ charge, canonical }) =>
        previewRowFor(charge, canonical),
      ),
    },
    {
      candidatePolicy: "suggestion",
      includeVendorInference: false,
      preparation,
      retainedRefs: new Map(
        grouped.map(({ charge, canonical }) => [
          chargeId(charge),
          canonical.chargeKey,
        ]),
      ),
      settlementAccountHints: new Map(
        grouped.flatMap(({ charge }) => {
          const code = matchedByCharge.get(chargeId(charge));
          const settled = code ? accepted.get(code) : undefined;
          return settled
            ? [[chargeId(charge), settled.accountId] as const]
            : [];
        }),
      ),
      accountHints: new Map(
        grouped.flatMap(({ charge, observations: rows }) => {
          const stored = rows.find((row) => row.accountId)?.accountId;
          return stored ? [[chargeId(charge), stored] as const] : [];
        }),
      ),
    },
  );
  return {
    grouped,
    matchedByCharge,
    matchedCharges,
    accepted,
    preparation,
    preview,
    providerFacts,
    pairsByCharge,
    providerScopeCharges,
  };
}

/** Bounded provider history, including tombstones and reviewed successors. A
 * replacement relation is not proof that two retained provider keys are one event.
 */
async function providerIdentityFacts(
  db: Database,
  inputs: readonly { charge: ChargeRef; canonical: Observation }[],
  _accounts?: readonly {
    id: string;
    sourceAliases: ReturnType<typeof financialAccountSourceAliases.parse>;
  }[],
) {
  const result = new Map<
    string,
    { fingerprint: string; unresolved: boolean }
  >();
  const ids = inputs.flatMap(({ canonical }) =>
    canonical.occurrenceId ? [canonical.occurrenceId] : [],
  );
  const owners = ids.length
    ? (
        await unwrapDb(db).execute<{
          id: string;
          version: number;
          reviewState: string;
          currentObservationId: string | null;
          acceptedTransactionId: string | null;
        }>(sql`
    -- includes-deleted: reserved identities and financial judgments remain binding after tombstoning.
    SELECT owner.id,owner.version,owner."reviewState",owner."currentObservationId",owner."acceptedTransactionId" FROM "SourceOccurrence" owner
    WHERE owner.id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`)
      ).rows
    : [];
  for (const { charge, canonical } of inputs) {
    const owner = owners.find((owner) => owner.id === canonical.occurrenceId);
    result.set(chargeId(charge), {
      unresolved: !owner || owner.reviewState !== "ready",
      fingerprint: await sha256Hex(
        // Presentation suppression no longer owns eligibility; keep its former false hash slot so unchanged paid advice and dismissals retain their evidence revision.
        canonicalJson(
          jsonSnapshot.parse(owner ? { ...owner, suppressed: false } : null),
        ),
      ),
    });
  }
  return result;
}

async function providerIdentityInputs(
  db: Database,
  charges: readonly ChargeRef[],
) {
  const canonical = new Map<string, Observation>();
  for (const observation of await loadObservations(db, charges))
    if (!canonical.has(chargeId(observation)))
      canonical.set(chargeId(observation), observation);
  return charges.flatMap((charge) => {
    const row = canonical.get(chargeId(charge));
    return row ? [{ charge, canonical: row }] : [];
  });
}

/** Bind the provider evidence of every source leg, including an opposite transfer leg. */
async function providerActionIdentityFacts(
  db: Database,
  inputs: readonly Pick<
    ChargeProposal,
    "charge" | "canonical" | "providerScopeCharges"
  >[],
  accounts?: Parameters<typeof providerIdentityFacts>[2],
) {
  if (!inputs.some((input) => input.providerScopeCharges?.length))
    return providerIdentityFacts(db, inputs, accounts);
  const charges = new Map(
    inputs
      .flatMap((input) => [input.charge, ...(input.providerScopeCharges ?? [])])
      .map((charge) => [chargeId(charge), charge]),
  );
  const current = await providerIdentityInputs(db, [...charges.values()]);
  const present = new Set(current.map((input) => chargeId(input.charge)));
  const facts = await providerIdentityFacts(db, current, accounts);
  const result = new Map(facts);
  for (const input of inputs) {
    if (!input.providerScopeCharges?.length) continue;
    const legs = [
      ...new Set([input.charge, ...input.providerScopeCharges].map(chargeId)),
    ].sort();
    result.set(chargeId(input.charge), {
      unresolved: legs.some(
        (key) => !present.has(key) || facts.get(key)?.unresolved,
      ),
      fingerprint: await sha256Hex(
        canonicalJson(
          legs.map((key) => [key, facts.get(key)?.fingerprint ?? null]),
        ),
      ),
    });
  }
  return result;
}

/** The transfer writer also checks its complete source set inside its transaction. */
export async function assertStatementSourceIdentity(
  db: Database,
  charges: readonly ChargeRef[],
  creatingCharges: readonly ChargeRef[],
) {
  if (!charges.length) return;
  const unique = [
    ...new Map(charges.map((charge) => [chargeId(charge), charge])).values(),
  ];
  const inputs = await providerIdentityInputs(db, unique);
  const facts = await providerIdentityFacts(db, inputs);
  if (
    inputs.length !== unique.length ||
    [...facts.values()].some((fact) => fact.unresolved)
  )
    throw createAppError("CONSTRAINT_VIOLATION", PROVIDER_IDENTITY_REVIEW);
  const creating = new Set(creatingCharges.map(chargeId));
  if (
    inputs.some(
      ({ charge, canonical }) =>
        creating.has(chargeId(charge)) && !hasStatementOccurrence(canonical),
    )
  )
    throw createAppError("CONSTRAINT_VIOLATION", OCCURRENCE_IDENTITY_REVIEW);
}

async function assertProviderIdentityPublication(
  db: Database,
  proposals: readonly ChargeProposal[],
) {
  const facts = await providerActionIdentityFacts(db, proposals);
  for (const proposal of proposals) {
    const current = facts.get(chargeId(proposal.charge));
    if (
      current?.unresolved &&
      (proposal.judgment.clean ||
        proposal.judgment.reviewReason !== PROVIDER_IDENTITY_REVIEW)
    )
      throw new Error(
        "Unresolved provider identity requires statement review before publication.",
      );
    if (current?.fingerprint !== proposal.providerScopeFingerprint)
      throw new Error(
        "Provider identity evidence changed before statement publication; refresh suggestions.",
      );
  }
}

export async function buildChargeProposals(
  db: Database,
  charges: readonly ChargeRef[],
): Promise<ChargeProposal[]> {
  const prepared = await prepareChargePreviews(db, charges);
  if (!prepared) return [];
  const {
    grouped,
    matchedByCharge,
    matchedCharges,
    accepted,
    preparation,
    preview,
    providerFacts,
    pairsByCharge,
    providerScopeCharges,
  } = prepared;
  const previewByKey = new Map(preview.rows.map((row) => [row.key, row]));
  const ids = preparation.ids;
  const matchedCodes = matchedCharges
    .map((row) => row.shortcode)
    .filter((code) => !ids.has(code));
  if (matchedCodes.length) {
    const { rows } = await unwrapDb(db).execute<{
      id: string;
      shortcode: string;
    }>(sql`
      SELECT id, shortcode FROM "FinancialTransaction" WHERE shortcode IN (${sql.join(
        matchedCodes.map((code) => sql`${code}`),
        sql`, `,
      )})
    `);
    for (const row of rows) ids.set(row.shortcode, String(row.id));
  }
  const accountIds = [
    ...new Set(
      preview.rows.flatMap((row) =>
        row.accountId && ids.get(row.accountId)
          ? [ids.get(row.accountId)!]
          : [],
      ),
    ),
  ];
  const accounts: OwnAccount[] = preparation.accounts.map((account) => ({
    id: account.id,
    kind: account.identity.kind,
    names: [account.vendorName, ...(account.vendorAliases ?? [])].filter(
      (name): name is string => Boolean(name),
    ),
    ledgerPartyId: account.ledgerPartyId,
  }));
  const [pendingTransactions, siblings, claimed, history] = await Promise.all([
    statementPendingTransactions(db, accountIds),
    siblingsFor(db, grouped),
    claimedCandidates(
      db,
      grouped.flatMap(({ charge }) =>
        (
          previewByKey.get(chargeId(charge))?.existingTransactions ?? []
        ).flatMap((existing) => {
          const transactionId = ids.get(existing.id);
          return transactionId ? [{ charge, transactionId }] : [];
        }),
      ),
    ),
    merchantHistory(
      db,
      grouped.flatMap(({ charge, canonical }) => {
        const row = previewByKey.get(chargeId(charge));
        const accountId = row?.accountId ? ids.get(row.accountId) : null;
        return row && accountId
          ? [
              {
                key: chargeId(charge),
                accountId,
                merchant: canonical.merchant,
                date: canonical.statementDate,
                amount: row.proposed.amount,
              },
            ]
          : [];
      }),
    ),
  ]);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const pending: Array<{
    charge: ChargeRef;
    canonical: Observation;
    rows: Observation[];
    judgment: StatementTransactionJudgment;
  }> = [];
  for (const { charge, observations: rows, canonical } of grouped) {
    const row = previewByKey.get(chargeId(charge));
    if (
      !row ||
      !row.accountId ||
      row.status === "unresolved_account" ||
      row.status === "indistinguishable_duplicate"
    )
      continue;
    const accountId = ids.get(row.accountId);
    if (!accountId) continue;
    const matchedCode = matchedByCharge.get(chargeId(charge));
    if (
      !matchedCode &&
      (canonical.withdrawnAt !== null || canonical.providerAmount === 0)
    )
      continue;
    const priorTransaction = matchedCode
      ? accepted.get(matchedCode)
      : undefined;
    const reviewReason = providerFacts.get(chargeId(charge))?.unresolved
      ? PROVIDER_IDENTITY_REVIEW
      : !matchedCode && !hasStatementOccurrence(canonical)
        ? OCCURRENCE_IDENTITY_REVIEW
        : priorTransaction && priorTransaction.accountId !== accountId
          ? "The source account conflicts with the accepted transaction account; review the account evidence."
          : sourceCorrectionReason(priorTransaction, canonical);
    const effectiveStatus = canonical.providerStatus ?? "observed";
    const statementAmount = row.proposed.amount;
    const candidates: StatementTransactionCandidate[] =
      row.existingTransactions.flatMap((existing) => {
        const transactionId = ids.get(existing.id);
        return transactionId
          ? [
              {
                transactionId,
                amount: existing.amount,
                status: existing.status,
                postedDate: existing.postedDate,
                transactionDate: existing.transactionDate,
                merchant: existing.merchant,
                rawDescription: existing.rawDescription,
                diff: diffFor(existing, {
                  amount: statementAmount,
                  status: effectiveStatus,
                  date: canonical.statementDate,
                }),
                label: null,
                claimed:
                  claimed.get(chargeId(charge))?.has(transactionId) ?? false,
              },
            ]
          : [];
      });
    // A posted row may settle a hold this ledger recorded, at a different
    // amount or date than the nearby rule admits.
    const holds =
      effectiveStatus === "posted"
        ? pendingTransactions.filter(
            (pending) =>
              pending.accountId === accountId &&
              pendingPostedMatch(
                {
                  amount: pending.amount,
                  date: pending.transactionDate ?? pending.postedDate,
                },
                { amount: statementAmount, date: canonical.statementDate },
              ),
          )
        : [];
    for (const hold of holds) {
      const listed = candidates.find((c) => c.transactionId === hold.id);
      // The hold carries its own pending rows' refs; that is what supersede settles.
      if (listed) listed.claimed = false;
      else
        candidates.push({
          transactionId: hold.id,
          amount: hold.amount,
          status: "pending",
          postedDate: hold.postedDate,
          transactionDate: hold.transactionDate,
          merchant: hold.merchant,
          rawDescription: hold.rawDescription,
          diff: diffFor(
            {
              amount: hold.amount,
              status: "pending",
              postedDate: hold.postedDate,
            },
            {
              amount: statementAmount,
              status: "posted",
              date: canonical.statementDate,
            },
          ),
          label: null,
          claimed: false,
        });
    }
    candidates.sort(
      (a, b) =>
        Number(cents(a.amount) !== cents(statementAmount)) -
          Number(cents(b.amount) !== cents(statementAmount)) ||
        a.transactionId.localeCompare(b.transactionId),
    );
    const hold = holds.find((pending) =>
      candidates.some((c) => c.transactionId === pending.id),
    );
    const rule = statementTransactionKind({
      sourceCategory: canonical.sourceCategory,
      amount: statementAmount,
    });
    const account = accountById.get(accountId);
    const transfer = account
      ? ownAccountNamed(canonical.rawDescription, account, accounts)
      : null;
    const past = history.get(chargeId(charge));
    const decision = decideStatementKind({
      amount: statementAmount,
      votes: {
        // A descriptor naming an own account outranks the provider category.
        rule: transfer
          ? "account_transfer"
          : rule.kindSource === "rule"
            ? rule.kind
            : null,
        label: null,
        history: past?.kind ?? null,
      },
      counterparty: {
        label: null,
        history: past?.counterparty ?? null,
        storedValue: account?.kind === "stored_value",
      },
      transfer,
    });
    const chargeSiblings = siblings.get(chargeId(charge)) ?? [];
    const recommended = matchedCode
      ? "book"
      : hold
        ? "supersede"
        : candidates.length
          ? "attach"
          : "create";
    const judgment: StatementTransactionJudgment = {
      recommended,
      reviewReason,
      accountId,
      statementDate: canonical.statementDate,
      providerStatus: canonical.providerStatus,
      create: {
        kind: decision.kind,
        kindSource: decision.kindSource,
        votes: decision.votes,
        counterparty: decision.counterparty,
        status: effectiveStatus,
        amount: statementAmount,
        transactionDate:
          effectiveStatus !== "posted" ? canonical.statementDate : null,
        postedDate:
          effectiveStatus === "posted" ? canonical.statementDate : null,
        merchant: canonical.merchant,
        rawDescription: canonical.rawDescription,
        sourceCategory: canonical.sourceCategory,
        notes: canonical.providerNotes,
        sourceRef: row.proposed.sourceRef,
      },
      candidates,
      supersede: hold
        ? {
            pendingTransactionId: hold.id,
            pendingRowIds: hold.pendingRowIds,
            postedRowId: canonical.id,
          }
        : null,
      void: null,
      siblings: chargeSiblings,
      transfer,
      transferPair: pairsByCharge.get(chargeId(charge)) ?? null,
      clean: false,
      ...(matchedCode && { matchedTransactionId: ids.get(matchedCode) }),
    };
    pending.push({ charge, canonical, rows, judgment });
  }
  await prepareStatementSpendingPage(
    db,
    pending.map((proposal) => proposal.judgment),
  );
  const proposals: ChargeProposal[] = [];
  for (const { charge, canonical, rows, judgment } of pending) {
    if (
      !judgment.reviewReason &&
      judgment.recommended === "book" &&
      judgment.spending?.status === "deferred"
    )
      continue;
    judgment.clean = isClean(
      judgment,
      judgment.create?.amount ?? canonical.amount,
    );
    proposals.push(
      await finishProposal(
        charge,
        canonical,
        rows,
        judgment,
        providerFacts.get(chargeId(charge))?.fingerprint,
        providerScopeCharges.get(chargeId(charge)),
      ),
    );
  }
  return proposals;
}

/** Bulk acceptance never changes an amount or relies on a kind sources dispute. */
export function isClean(
  judgment: StatementTransactionJudgment,
  statementAmount: number,
): boolean {
  if (judgment.reviewReason || judgment.siblings.length) return false;
  if (
    judgment.create !== null &&
    ["purchase", "refund", "fee"].includes(judgment.create.kind) &&
    judgment.spending?.status !== "ready" &&
    judgment.spending?.status !== "already_booked"
  )
    return false;
  if (judgment.recommended === "book")
    return (
      judgment.spending?.status === "ready" &&
      judgment.create !== null &&
      kindAgreed(judgment.create, judgment.transfer, judgment.transferPair)
    );
  if (judgment.recommended === "create")
    return (
      judgment.candidates.length === 0 &&
      judgment.create !== null &&
      kindAgreed(judgment.create, judgment.transfer, judgment.transferPair)
    );
  if (judgment.candidates.length !== 1) return false;
  const [only] = judgment.candidates;
  if (cents(only!.amount) !== cents(statementAmount)) return false;
  if (judgment.recommended === "supersede") return true;
  return (
    judgment.recommended === "attach" &&
    !only!.claimed &&
    only!.label?.same === "same" &&
    only!.label.confidence === "high"
  );
}

async function finishProposal(
  charge: ChargeRef,
  canonical: Observation,
  observations: Observation[],
  judgment: StatementTransactionJudgment,
  providerScopeFingerprint?: string,
  providerScopeCharges?: readonly ChargeRef[],
): Promise<ChargeProposal> {
  suggestionJudgments.statement_transaction.parse(judgment);
  const fingerprint = await sha256Hex(
    canonicalJson({
      revision: STATEMENT_SUGGESTION_REVISION,
      cleanPolicy: STATEMENT_CLEAN_POLICY,
      ...(providerScopeFingerprint ? { providerScopeFingerprint } : {}),
      judgment,
      observations: observations
        .map((row) => [
          row.id,
          row.externalId,
          row.accountDescriptor,
          row.statementDate,
          cents(row.providerAmount),
          row.rawDescription,
          row.providerStatus,
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    }),
  );
  const refs = [
    ...new Set([
      suggestionRefKey(charge.source, charge.chargeKey),
      ...observations.map((row) =>
        suggestionRefKey(row.source, row.externalId),
      ),
    ]),
  ].sort();
  return {
    charge,
    canonical,
    observations,
    judgment,
    fingerprint,
    evidenceFingerprint: fingerprint,
    providerScopeFingerprint,
    providerScopeCharges,
    refs,
  };
}

/** Model labels ride on the evidence fingerprint rather than replacing it. */
export async function labelledProposal(
  proposal: ChargeProposal,
  judgment: StatementTransactionJudgment,
): Promise<ChargeProposal> {
  suggestionJudgments.statement_transaction.parse(judgment);
  return {
    ...proposal,
    judgment,
    fingerprint: await sha256Hex(
      canonicalJson(
        jsonSnapshot.parse({
          evidence: proposal.evidenceFingerprint,
          spending: judgment.spending,
          candidates: judgment.candidates.map((c) => [
            c.transactionId,
            c.label,
          ]),
          kind: judgment.create
            ? [
                judgment.create.kind,
                judgment.create.kindSource,
                judgment.create.votes,
                judgment.create.counterparty,
              ]
            : null,
        }),
      ),
    ),
  };
}

/**
 * Vanished holds: a transaction this ledger recorded from pending rows, with no
 * posted twin, that a later export of the same account no longer contains
 * although it covers dates a full window past the hold.
 */
export async function buildHoldVoidProposals(
  db: Database,
  accountIds?: readonly string[],
): Promise<ChargeProposal[]> {
  const accounts =
    accountIds ??
    (
      await unwrapDb(db).execute<{ id: string }>(sql`
        SELECT DISTINCT ft."accountId" AS id FROM "FinancialTransaction" ft
        WHERE ${notDeleted("ft")} AND ft.status = ${financialTransactionStatus.enum.pending}
      `)
    ).rows.map((row) => String(row.id));
  const holds = await statementPendingTransactions(db, accounts);
  return buildHoldVoidProposalsForHolds(db, holds);
}

async function buildHoldVoidProposalsForHolds(
  db: Database,
  holds: readonly PendingTransaction[],
  onFailure?: (hold: PendingTransaction, error: unknown) => void,
) {
  const proposals: Array<
    Pick<ChargeProposal, "charge" | "canonical" | "observations" | "judgment">
  > = [];
  for (const hold of holds) {
    try {
      const date = hold.transactionDate ?? hold.postedDate;
      if (!date) continue;
      const rows = await loadObservationsById(db, hold.pendingRowIds);
      if (!rows.length) continue;
      const canonical = rows[0]!;
      const coverage = await laterCoveringImport(db, {
        source: canonical.source,
        accountDescriptor: canonical.accountDescriptor,
        after: rows
          .map((row) => row.createdAt)
          .sort()
          .at(-1)!,
        coveredThrough: date,
        rowIds: hold.pendingRowIds,
      });
      if (!coverage) continue;
      const posted = await postedTwinExists(db, hold, date);
      if (posted) continue;
      const charge = {
        source: canonical.source,
        chargeKey: canonical.chargeKey,
      };
      proposals.push({
        charge,
        canonical,
        observations: rows,
        judgment: {
          recommended: "void",
          reviewReason: null,
          accountId: hold.accountId,
          statementDate: canonical.statementDate,
          providerStatus: "pending",
          create: null,
          candidates: [],
          supersede: null,
          void: { transactionId: hold.id, coverageImportId: coverage },
          siblings: [],
          transfer: null,
          transferPair: null,
          clean: false,
        },
      });
    } catch (error) {
      if (!onFailure || isWorkflowInterrupted(error)) throw error;
      onFailure(hold, error);
    }
  }
  const facts = await providerIdentityFacts(db, proposals);
  return Promise.all(
    proposals.map((proposal) => {
      const scope = facts.get(chargeId(proposal.charge));
      return finishProposal(
        proposal.charge,
        proposal.canonical,
        proposal.observations,
        {
          ...proposal.judgment,
          reviewReason: scope?.unresolved
            ? PROVIDER_IDENTITY_REVIEW
            : proposal.judgment.reviewReason,
        },
        scope?.fingerprint,
      );
    }),
  );
}

async function loadObservationsById(db: Database, rowIds: readonly string[]) {
  if (!rowIds.length) return [];
  const { rows } = await unwrapDb(db).execute<ChargeRef>(sql`
    SELECT DISTINCT r.source, ${chargeKeyOf("r")} AS "chargeKey" FROM ${sourceObservations} r
    WHERE r.id IN (${sql.join(
      rowIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) AND ${notDeleted("r")}
  `);
  const all = await loadObservations(db, rows);
  return all.filter((row) => rowIds.includes(row.id));
}

/** Only explicit persisted withdrawal proof establishes a vanished hold. */
async function laterCoveringImport(
  db: Database,
  input: {
    source: string;
    accountDescriptor: string;
    after: string;
    coveredThrough: string;
    rowIds: readonly string[];
  },
): Promise<string | null> {
  const { rows } = await unwrapDb(db).execute<{ id: string }>(sql`
    SELECT DISTINCT si.id FROM "TransactionImport" si
    JOIN ${sourceObservations} head ON head."withdrawalImportId" = si.id
    JOIN ${sourceObservations} held ON held.source=head.source AND held."chargeKey"=head."chargeKey"
    WHERE ${notDeleted("si")} AND si.source=${input.source} AND si."completedAt" IS NOT NULL
      AND si.coverage->>${"visibility"}=${"all"} AND head.current AND head."withdrawnAt" IS NOT NULL
      AND ${notDeleted("head")} AND ${notDeleted("held")}
      AND held.id IN (${sql.join(
        input.rowIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    LIMIT 1
  `);
  return rows[0] ? String(rows[0].id) : null;
}

async function postedTwinExists(
  db: Database,
  hold: PendingTransaction,
  date: string,
): Promise<boolean> {
  const { rows } = await unwrapDb(db).execute<{
    amount: string;
    statementDate: unknown;
  }>(sql`
    SELECT r.amount, r."statementDate" FROM ${sourceObservations} r
    WHERE ${notDeleted("r")}
      AND r."providerStatus" IS DISTINCT FROM ${sourceTransactionRecordProviderStatus.enum.pending}
      AND r."statementDate" BETWEEN ${date}::date - ${PENDING_POST_WINDOW_DAYS}::int
        AND ${date}::date + ${PENDING_POST_WINDOW_DAYS}::int
      AND sign(r.amount) = sign(${hold.amount}::numeric)
      AND r."accountDescriptor" IN (
        SELECT held."accountDescriptor" FROM ${sourceObservations} held
        WHERE held.id IN (${sql.join(
          hold.pendingRowIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      )
  `);
  return rows.some((row) =>
    pendingPostedMatch(
      { amount: hold.amount, date },
      { amount: Number(row.amount), date: plainDateOf(row.statementDate) },
    ),
  );
}

type PublishOutcome = "published" | "unchanged" | "suppressed" | "settled";

const isSettledBooking = (judgment: StatementTransactionJudgment) =>
  !judgment.reviewReason &&
  judgment.recommended === "book" &&
  judgment.spending?.status === "already_booked";

/** Complete a previously committed publication's missed retirement check, even without a new proposal. */
async function retireSettledChargeAdvice(db: Database, charge: ChargeRef) {
  return transitionSuggestionStates(
    db,
    sql`${pendingStatementState} AND ${suggestionField("source", STATE)}=${charge.source} AND ${suggestionField("chargeKey", STATE)}=${charge.chargeKey}
            AND ${suggestionField("recommended", STATE)} <> ${statementTransactionAction.enum.void}
            AND EXISTS (
              SELECT 1 FROM ${chargeStateOf(
                sql`r.source = ${charge.source} AND ${chargeKeyOf("r")} = ${charge.chargeKey}`,
              )} cs
              WHERE cs.ignored OR cs.superseded OR
                (cs.shortcode IS NOT NULL AND ${suggestionField("recommended", STATE)} <> ${statementTransactionAction.enum.book})
            )`,
    { active: false, status: "superseded" },
  );
}

type ReusablePublication = Pick<
  typeof suggestionTable.$inferSelect,
  "active" | "fingerprint"
> & {
  producer: SuggestionProducer | null;
  evidenceFingerprint: string | null;
  judgment: unknown;
};

/** Paid labels survive only while the actual model inputs and policy still agree. */
function reusableRuleLabels<
  Row extends ReusablePublication & {
    needsLabel: string | null;
    status: string;
  },
>(prior: readonly Row[], proposal: ChargeProposal) {
  if (!proposal.judgment.create || proposal.judgment.reviewReason)
    return undefined;
  const inputs = canonicalJson(statementLabelInputs(proposal.judgment));
  return prior.find((row) => {
    if (
      row.needsLabel !== "false" ||
      row.producer?.kind !== "model" ||
      row.producer.revision !== STATEMENT_LABEL_REVISION ||
      !["pending", "superseded"].includes(row.status)
    )
      return false;
    const previous = suggestionJudgments.statement_transaction.parse(
      row.judgment,
    );
    return canonicalJson(statementLabelInputs(previous)) === inputs;
  });
}

const countLabels = (value: StatementTransactionJudgment) =>
  value.candidates.filter((entry) => entry.label !== null).length +
  (value.create
    ? Number(value.create.votes.label !== null) +
      Number(value.create.counterparty.label !== null)
    : 0);

function chargePublication(
  proposal: ChargeProposal,
  producer: SuggestionProducer,
  priorCount: number,
  applicationOrder: z.infer<typeof statementApplicationOrder> | null = null,
  checkpoint: StatementLabelCheckpoint | undefined = undefined,
) {
  const { charge, judgment } = proposal;
  return {
    input: {
      publicationKey: `statement_transaction:${chargeId(charge)}:${proposal.fingerprint}:${priorCount}`,
      family: "statement_transaction",
      subject: {
        kind: "statement_transaction",
        entity: "sourceTransactionRecord",
        recordId: proposal.canonical.id,
        source: charge.source,
        chargeKey: charge.chargeKey,
      },
      judgment,
      fingerprint: proposal.fingerprint,
      producer,
      evidence: {
        observations: proposal.observations.map((row) => row.id),
      },
    },
    projection: {
      model: producer.model ?? "rule",
      confidence: judgment.clean ? 1 : 0,
      data: {
        source: charge.source,
        chargeKey: charge.chargeKey,
        accountId: judgment.accountId,
        month: judgment.statementDate.slice(0, 7),
        statementDate: judgment.statementDate,
        amount: judgment.create?.amount ?? proposal.canonical.amount,
        recommended: judgment.recommended,
        reviewReason: judgment.reviewReason,
        clean: judgment.clean,
        refs: proposal.refs,
        headRef: proposal.canonical.externalId,
        evidenceFingerprint: proposal.evidenceFingerprint,
        // Rule output awaits the decision model's labels: candidate
        // identity, and the kind and counterparty of every create.
        needsLabel:
          producer.kind === "rule" &&
          judgment.create !== null &&
          !judgment.reviewReason,
        applicationPending: producer.kind === "model",
        ...(applicationOrder && { applicationOrder }),
        ...(checkpoint && { labelCheckpoint: checkpoint }),
        ...automaticRuleStamp(
          judgment.reviewReason ? [] : matchStatementRules(judgment),
        ),
      },
    },
  } satisfies {
    input: Parameters<typeof publishStoredSuggestion>[1];
    projection: Parameters<typeof publishStoredSuggestion>[2];
  };
}

/** A statement slot's locked row in the family's own shape. */
type ChargePublicationHistory = SuggestionRow & {
  producer: SuggestionProducer | null;
  needsLabel: string | null;
  checkpoint: unknown;
  applicationPending: string | null;
  applicationOrder: unknown;
};

/** Retained paid publications follow observations and their aliases across slot changes. */
async function priorStatementPublications(
  db: Database,
  proposals: readonly ChargeProposal[],
) {
  const roots = proposals.flatMap((proposal) =>
    proposal.observations.map(
      (row) => sql`(${chargeId(proposal.charge)}, ${row.id}::uuid)`,
    ),
  );
  const result = new Map<string, ChargePublicationHistory[]>();
  if (!roots.length) return result;
  const { rows } = await getDb(db).execute<
    SuggestionRow & { owner: string }
  >(sql`
    WITH roots(owner, observation) AS (VALUES ${sql.join(roots, sql`, `)})
    SELECT DISTINCT roots.owner, s.id::text AS id, s.status, s.active, s.fingerprint, s.suppression, s.data,
      s.data->>'evidenceFingerprint' AS "evidenceFingerprint", to_char(s."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "createdAt", s.producer, s.judgment
    FROM roots JOIN "Suggestion" s ON s.family=${suggestionFamily.enum.statement_transaction}
      AND (s."recordId"=roots.observation OR EXISTS (
        SELECT 1 FROM "FinancialEvidenceAlias" evidence
        WHERE evidence."observationId"=roots.observation AND ${notDeleted("evidence")} AND evidence.source=s.data->>${financialTransactionSourceRef.keyof().enum.source} AND evidence.value=s.data->>'chargeKey'))
    ORDER BY "createdAt" DESC, id DESC`);
  for (const row of rows) {
    const data = z.record(z.string(), z.json()).parse(row.data);
    const value: ChargePublicationHistory = {
      ...row,
      data,
      producer: suggestionProducer.nullable().parse(row.producer),
      needsLabel: jsonText(data.needsLabel),
      checkpoint: data.labelCheckpoint ?? null,
      applicationPending: jsonText(data.applicationPending),
      applicationOrder: data.applicationOrder ?? null,
    };
    const history = result.get(row.owner) ?? [];
    history.push(value);
    result.set(row.owner, history);
  }
  return result;
}

/** Keep the immutable old publication and labels, replacing only its active queue slot. */
async function retireRetainedStatementAdvice(
  db: Database,
  proposal: ChargeProposal,
) {
  if (!proposal.observations.length) return;
  await transitionSuggestionStates(
    db,
    sql`${suggestionTable.family}=${suggestionFamily.enum.statement_transaction}
    AND ${suggestionTable.active} AND ${suggestionTable.status}=${suggestionStatus.enum.pending}
    AND ${inArray(
      suggestionTable.recordId,
      proposal.observations.map((row) => row.id),
    )}
    AND ${suggestionTable.data}->>${financialTransactionSourceRef.keyof().enum.source}=${proposal.charge.source}
    AND ${suggestionTable.data}->>'chargeKey' IS DISTINCT FROM ${proposal.charge.chargeKey}`,
    { active: false, status: "superseded" },
  );
}

/** The text `->>` reads from a JSON scalar. */
const jsonText = (value: unknown) =>
  value === undefined || value === null
    ? null
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

type ChargeState = ChargeRef & {
  ignored: boolean;
  superseded: boolean;
  shortcode: string | null;
};

/** Current charge states, read after the slot locks. */
async function currentChargeStates(
  db: Database,
  charges: readonly ChargeRef[],
) {
  const { rows } = await getDb(db).execute<ChargeState>(
    sql`SELECT cs.* FROM ${chargeStateOf(
      sql`(r.source, r."chargeKey") IN (${tuples(charges)})`,
    )} cs`,
  );
  return new Map(rows.map((state) => [chargeId(state), state]));
}

const chargeSettled = (
  state: ChargeState,
  judgment: StatementTransactionJudgment,
) =>
  state.ignored ||
  state.superseded ||
  (state.shortcode !== null && judgment.recommended !== "book");

/** The latest saved checkpoint whose label subject still matches the judgment. */
const savedRuleCheckpoint = (
  rows: readonly ChargePublicationHistory[],
  judgment: StatementTransactionJudgment,
) =>
  rows
    .flatMap((row) => {
      const saved = statementLabelCheckpoint.nullable().parse(row.checkpoint);
      return saved ? [saved] : [];
    })
    .find(
      (saved) =>
        saved.revision === STATEMENT_LABEL_REVISION &&
        canonicalJson(statementLabelSubject(saved.judgment)) ===
          canonicalJson(statementLabelSubject(judgment)),
    );

type StatementCandidate = {
  proposal: ChargeProposal;
  /** A complete label publication's active-input fence and checkpoint. */
  labelPublication?: {
    evidenceFingerprint: string;
    checkpoint: StatementLabelCheckpoint;
  };
  /** The spending checkpoint kept when a rule re-run reuses paid labels. */
  retainedCheckpoint?: StatementLabelCheckpoint;
};

/**
 * The `statement_transaction` Suggestion family: one slot per provider
 * charge. Batch admission defers anything that needs the one-at-a-time
 * writer's repairs (settled advice, reused labels) to that writer.
 */
export const statementSuggestions: SuggestionFamilyDeclaration<"statement_transaction"> &
  SuggestionFamily<
    StatementCandidate,
    ChargePublicationHistory,
    "settled",
    {
      states: Map<string, ChargeState> | null;
      history: Map<string, ChargePublicationHistory[]>;
    }
  > = {
  family: suggestionFamily.enum.statement_transaction,
  slot: ({ proposal: { charge } }) => ({
    lock: `statement-suggestion:${chargeId(charge)}`,
    fields: { source: charge.source, chargeKey: charge.chargeKey },
  }),
  fingerprint: ({ proposal }) => proposal.fingerprint,
  evidenceFingerprint: ({ proposal }) => proposal.evidenceFingerprint,
  row: (row) => ({
    ...row,
    producer: suggestionProducer.nullable().parse(row.producer),
    needsLabel: jsonText(row.data.needsLabel),
    checkpoint: row.data.labelCheckpoint ?? null,
    applicationPending: jsonText(row.data.applicationPending),
    applicationOrder: row.data.applicationOrder ?? null,
  }),
  admit: (tx, candidates) =>
    assertProviderIdentityPublication(
      tx,
      candidates.map(({ proposal }) => proposal),
    ),
  load: async (tx, candidates, batch) => ({
    states: batch
      ? await currentChargeStates(
          tx,
          candidates.map(({ proposal }) => proposal.charge),
        )
      : null,
    history: await priorStatementPublications(
      tx,
      candidates.map(({ proposal }) => proposal),
    ),
  }),
  batchable: ({ proposal }) =>
    proposal.judgment.recommended !== "void" &&
    !isSettledBooking(proposal.judgment),
  async precheck(tx, { proposal, labelPublication }, rows, _producer, context) {
    const { charge, judgment } = proposal;
    if (
      rows.some(
        (row) => row.active && row.status === suggestionStatus.enum.pending,
      )
    )
      await retireRetainedStatementAdvice(tx, proposal);
    if (context.batch) {
      const state = context.loaded.states?.get(chargeId(charge));
      return !state || chargeSettled(state, judgment)
        ? { kind: "defer" }
        : undefined;
    }
    // A charge matched, ignored or superseded after it was listed (an accept or
    // an import-page attach in between) needs no suggestion; a ref inserted
    // before publication never reaches the retiring trigger. Holds are the
    // exception: their charge is matched by the hold transaction itself.
    if (judgment.recommended !== "void") {
      const { rows: settled } = await getDb(tx).execute(sql`
        SELECT 1 FROM ${chargeStateOf(
          sql`r.source = ${charge.source} AND ${chargeKeyOf("r")} = ${charge.chargeKey}`,
        )} cs
        WHERE cs.ignored OR cs.superseded OR (cs.shortcode IS NOT NULL AND ${judgment.recommended !== "book"})
      `);
      if (settled.length) {
        // A prior commit may have lost its after-commit retirement effect.
        // Replaying that exact charge must finish the effect, not leave stale advice.
        await retireSettledChargeAdvice(tx, charge);
        return { kind: "resolved", reason: "settled" };
      }
    }
    if (isSettledBooking(judgment)) {
      const fresh = await prepareStatementSpending(tx, judgment);
      if (fresh?.status === "already_booked")
        return {
          kind: "retire",
          reason: "settled",
        };
    }
    // Complete labels publish their checkpoint in this transaction instead of
    // first rewriting the rule row. Preserve that writer's active-input fence.
    if (
      labelPublication &&
      !rows.some(
        (row) =>
          row.active &&
          row.status === suggestionStatus.enum.pending &&
          row.evidenceFingerprint === labelPublication.evidenceFingerprint,
      )
    )
      throw new Error(
        "Statement label publication lost its active evidence fence",
      );
    return undefined;
  },
  // A rule re-run retains model labels only while their label revision agrees.
  obsolete: (row, producer) =>
    producer.kind === "rule" &&
    row.producer?.kind === "model" &&
    row.producer.revision !== STATEMENT_LABEL_REVISION,
  onUnchanged: "none",
  async prepare(tx, candidate, rows, producer, context) {
    const { proposal } = candidate;
    const history = [
      ...rows,
      ...(context.loaded.history.get(chargeId(proposal.charge)) ?? []),
    ];
    if (context.batch)
      return reusableRuleLabels(history, proposal)
        ? "defer"
        : { candidate, producer };
    if (producer.kind !== "rule" || !proposal.judgment.create)
      return { candidate, producer };
    // Retain the paid votes, not their old rule/history conclusions. Evidence
    // still gets a fresh fingerprint and current apply-time validation.
    const reusable = reusableRuleLabels(history, proposal);
    if (!reusable) return { candidate, producer };
    const previous = suggestionJudgments.statement_transaction.parse(
      reusable.judgment,
    );
    const previousProducer = reusable.producer;
    if (!previous.create || previousProducer?.kind !== "model")
      return { candidate, producer };
    const judgment = structuredClone(proposal.judgment);
    const create = judgment.create!;
    Object.assign(
      create,
      decideStatementKind({
        amount: create.amount,
        votes: { ...create.votes, label: previous.create.votes.label },
        counterparty: {
          ...create.counterparty,
          label: previous.create.counterparty.label,
        },
        transfer: judgment.transfer,
      }),
    );
    for (const entry of judgment.candidates)
      entry.label = previous.candidates.find(
        (saved) => saved.transactionId === entry.transactionId,
      )!.label;
    judgment.spending = await prepareStatementSpending(
      tx,
      judgment,
      previous.spending?.request.advice ?? null,
    );
    judgment.clean = isClean(judgment, proposal.canonical.amount);
    const labelled = {
      ...candidate,
      proposal: await labelledProposal(proposal, judgment),
    };
    if (
      judgment.spending?.status === "deferred" ||
      previous.spending?.request.advice
    )
      return { candidate: labelled, producer: previousProducer };
    return {
      candidate: {
        ...labelled,
        retainedCheckpoint: statementLabelCheckpoint.parse({
          revision: STATEMENT_LABEL_REVISION,
          model: previousProducer.model,
          models:
            statementLabelCheckpoint.nullable().parse(reusable.checkpoint)
              ?.models ??
            (previousProducer.model ? [previousProducer.model] : []),
          judgment,
          kind: true,
          counterparty: true,
          spending: false,
        }),
      },
      producer,
    };
  },
  publication(
    { proposal, labelPublication, retainedCheckpoint },
    rows,
    producer,
  ) {
    const { judgment } = proposal;
    const inputPosition = rows.find(
      (row) => row.active && row.status === "pending",
    );
    const applicationOrder =
      producer.kind === "model" && inputPosition
        ? (statementApplicationOrder
            .nullable()
            .parse(inputPosition.applicationOrder) ?? {
            createdAt: inputPosition.createdAt,
            id: inputPosition.id,
          })
        : null;
    const checkpoint =
      retainedCheckpoint ??
      (producer.kind === "rule"
        ? savedRuleCheckpoint(rows, judgment)
        : labelPublication
          ? statementLabelCheckpoint.parse(labelPublication.checkpoint)
          : statementLabelCheckpoint.safeParse({
              revision: producer.revision,
              model: producer.model,
              models: producer.model ? [producer.model] : [],
              judgment,
              kind: true,
              counterparty: true,
            }).data);
    return chargePublication(
      proposal,
      producer,
      rows.length,
      applicationOrder,
      checkpoint,
    );
  },
  async afterPublish(tx, published, context) {
    for (const { candidate } of published)
      await retireRetainedStatementAdvice(tx, candidate.proposal);
    if (context.batch) {
      // Reference writers use evidence-key locks. Their transaction may commit
      // after our admission read but before these new states become visible.
      // Finish the same retirement check before acknowledging the whole batch.
      await enrollStatementPublicationRetirement(tx, {
        charges: tuples(
          published.map(({ candidate }) => candidate.proposal.charge),
        ),
        suggestionIds: published.map(({ suggestionId }) => suggestionId),
      });
      return;
    }
    for (const { suggestionId, candidate } of published) {
      const { charge, judgment } = candidate.proposal;
      // A ref writer holds evidence keys, not this charge's lock: one that
      // committed between the settled check and this commit has a trigger that
      // could not see the new row. Recheck once both are committed.
      if (judgment.recommended !== "void")
        await runAfterCommit(tx, (committed) =>
          withTransactionDatabase(committed, async (retirement) => {
            await assertWorkflowEffect(retirement);
            await transitionSuggestionStates(
              retirement,
              sql`${suggestionTable.id} = ${suggestionId}::uuid AND ${suggestionTable.status} = ${suggestionStatus.enum.pending}
                AND EXISTS (
                  SELECT 1 FROM ${chargeStateOf(
                    sql`r.source = ${charge.source} AND ${chargeKeyOf("r")} = ${charge.chargeKey}`,
                  )} cs
                  WHERE cs.ignored OR cs.superseded OR (cs.shortcode IS NOT NULL AND ${judgment.recommended !== "book"})
                )`,
              { active: false, status: "superseded" },
            );
          }),
        );
    }
  },
  labelBacklog: sql`${pendingSuggestion()} AND ${sourceSuggestionAutomaticEligible("s", true)} AND ((s.data->>'needsLabel')::boolean
    OR coalesce((s.data->>'applicationPending')::boolean, false))`,
  facts: (query, needs) => {
    const scope = statementScope(query);
    return scope ? statementSuggestionFacts(scope, needs) : null;
  },
  keys: async (db, query) => {
    const scope = statementScope(query);
    if (!scope) return [];
    const status = scope.status ?? "pending";
    const rows = await statementSuggestionKeys(db, scope);
    return rows.map((row) => ({
      family: "statement_transaction" as const,
      suggestionId: row.id,
      status,
      matchedRules: stamps.parse(row.matchedRules),
      automaticRule: row.automaticRule,
      fingerprint: row.fingerprint,
      clean: row.clean,
      strength: statementStrength(row),
      impact: row.reviewReason
        ? [{ kind: "caution", label: row.reviewReason }]
        : statementImpact[row.recommended],
      createdAt: row.createdAt,
      columns: {
        date: row.statementDate,
        month: row.statementDate.slice(0, 7),
        account: row.accountCode,
        owner: row.ownerCode,
        merchant: [row.merchant, row.rawDescription].filter(Boolean).join(" "),
        amount: row.amount,
        action: row.recommended,
        kind: row.kind,
        kindSource: row.kindSource,
        providerCategory: row.sourceCategory,
        providerStatus: row.providerStatus,
        candidate: row.candidateCode,
        modelLabel:
          row.labelSame && row.labelConfidence
            ? `${row.labelSame}:${row.labelConfidence}`
            : null,
      },
    }));
  },
  rows: async (db, keys) => {
    const rows = await readStatementSuggestions(
      db,
      keys.map((key) => key.suggestionId),
      keys[0]?.status === "applied" ? "applied" : "pending",
    );
    const byId = new Map(keys.map((key) => [key.suggestionId, key]));
    return new Map(
      rows.flatMap((row) => {
        const key = byId.get(row.suggestionId);
        if (!key) return [];
        const other = otherTransaction(row);
        return [
          [
            row.suggestionId,
            statementSuggestionRow.parse({
              ...keyBase(key),
              fingerprint: row.fingerprint,
              family: "statement_transaction",
              record: { entity: "financialAccount", id: row.accountId },
              ...(other
                ? { other: { entity: "financialTransaction", id: other } }
                : {}),
              summary: [
                { kind: "amount", amount: row.amount },
                { kind: "date", date: row.statementDate },
                { kind: "text", text: row.merchant ?? row.rawDescription },
              ],
              // Dismissal suppresses the charge permanently.
              actions: row.reviewReason
                ? verbs("dismiss")
                : verbs("accept", "correct", "dismiss"),
              evidence: row,
            }),
          ],
        ];
      }),
    );
  },
  outcomes: async (db, filters) => {
    const rows = await statementSuggestionStatusCounts(db, filters.runId);
    const of = (status: string) =>
      rows.find((row) => row.status === status)?.count ?? 0;
    return {
      applied: of("applied"),
      rejected: of("rejected"),
      superseded: of("superseded"),
      resolved: of("resolved"),
      fields: [],
    };
  },
  acceptAsIs: (row) => {
    // Labels ride on top of the evidence fingerprint, so a create labelled
    // clean under an earlier rule still passes the apply-time check.
    // Accept clean re-reads today's rule instead of the stored flag.
    if (row.evidence.reviewReason) return null;
    const { recommended, create, transfer, transferPair } = row.evidence;
    if (
      recommended === "create" &&
      create &&
      !kindAgreed(create, transfer, transferPair)
    )
      return null;
    const application = statementAcceptApplication(row.evidence);
    return application
      ? {
          suggestionId: row.suggestionId,
          operationId: crypto.randomUUID(),
          verdict: "correct",
          correction: { present: false },
          intent: "apply",
          expectedFingerprint: row.fingerprint,
          reason: null,
          evidence: null,
          application,
        }
      : null;
  },
  ...suggestionReviewFamilies.statement_transaction,
  ...declareAffectedRecords({
    roles: [
      "source",
      "occurrence",
      "import",
      "account",
      "candidate",
      "settlement",
    ],
    forward: statementRecords,
    reverse: statementReferenceMatch,
  }),
  actionable: sql`true`,
  summarize: (value: unknown) => {
    const decision = suggestionJudgments.statement_transaction.parse(value);
    return `Statement transaction: ${decision.recommended}`;
  },
  isolationLevel: "serializable",
  subject: suggestionSubjects.statement_transaction,
  target: suggestionProjectionTargets.statement_transaction,
  transactionBound: true,
  lockForApply: async (db, prediction) => {
    const judgment = suggestionJudgments.statement_transaction.parse(
      prediction.judgment,
    );
    const subject = suggestionSubjects.statement_transaction.parse(
      prediction.subject,
    );
    const { lockTransferPairLegs } =
      await import("~/server/domains/financial-transaction/repo/transfer-pair-suggestions");
    // Even a prediction made before pair discovery shares its charge's leg
    // lock with a later pair apply, before either can hold its projection.
    await lockTransferPairLegs(
      db,
      judgment.transferPair?.key ??
        `stmt:${subject.source}:${subject.chargeKey}`,
    );
  },
  actions: ["correct", "wrong", "uncertain", "dismissed"],
  apply: async (db, context, state, input) => {
    if (input.application?.kind !== "statement_transaction")
      throw new Error(
        "Applying a Transaction suggestion requires the chosen statement action",
      );
    const { applyStatementTransactionSuggestion } =
      await import("~/server/domains/transaction-import/repo/statement-suggestion-apply");
    await applyStatementTransactionSuggestion(db, context, state, {
      application: input.application,
      corrected: input.correction.present,
    });
  },
};

type StatementPublishResult =
  | { outcome: "published"; labelsReused: number; suggestionId: string }
  | { outcome: Exclude<PublishOutcome, "published">; labelsReused: number };

/** A rule re-run counts the paid labels it kept, unchanged or republished. */
function statementOutcome(
  published: SuggestionOutcome<
    StatementCandidate,
    ChargePublicationHistory,
    "settled"
  >,
  requested: SuggestionProducer,
): StatementPublishResult {
  switch (published.outcome) {
    case "published":
      return {
        outcome: "published",
        suggestionId: published.suggestionId,
        labelsReused:
          requested.kind === "rule" && published.producer.kind === "model"
            ? countLabels(published.candidate.proposal.judgment)
            : 0,
      };
    case "unchanged": {
      const [row] = published.rows;
      return {
        outcome: "unchanged",
        labelsReused:
          requested.kind === "rule" && row?.producer?.kind === "model"
            ? countLabels(
                suggestionJudgments.statement_transaction.parse(row.judgment),
              )
            : 0,
      };
    }
    case "resolved":
      return { outcome: published.reason, labelsReused: 0 };
    case "suppressed":
      return { outcome: "suppressed", labelsReused: 0 };
    case "deferred":
      throw new Error("Statement publication left a charge deferred");
  }
}

/**
 * Publish one charge's proposal. The charge's current suggestions are locked
 * first, so a member reviewing one serializes with its replacement: a
 * dismissal holds for its current evidence revision, an unchanged fingerprint is left
 * alone, and anything else is retired before the new one takes the charge.
 */
export async function publishChargeProposal(
  db: Database,
  proposal: ChargeProposal,
  producer: SuggestionProducer,
  labelPublication?: StatementCandidate["labelPublication"],
): Promise<StatementPublishResult> {
  return statementOutcome(
    await publishSuggestion(
      db,
      statementSuggestions,
      { proposal, labelPublication },
      producer,
    ),
    producer,
  );
}

async function retireStatementPublications(
  db: Database,
  input: { charges: SQL; suggestionIds: readonly string[] },
) {
  if (!input.suggestionIds.length) return;
  await withTransactionDatabase(db, async (retirement) => {
    await assertWorkflowEffect(retirement);
    await transitionSuggestionStates(
      retirement,
      sql`${inArray(suggestionTable.id, [...input.suggestionIds])}
          AND ${pendingStatementState}
          AND ${suggestionField("recommended", STATE)} <> ${statementTransactionAction.enum.void}
          AND EXISTS (SELECT 1 FROM ${chargeStateOf(
            sql`(r.source, r."chargeKey") IN (${input.charges})`,
          )} cs
            WHERE cs.source=${suggestionField("source", STATE)}
              AND cs."chargeKey"=${suggestionField("chargeKey", STATE)}
              AND (cs.ignored OR cs.superseded OR
                (cs.shortcode IS NOT NULL AND ${suggestionField("recommended", STATE)} <> ${statementTransactionAction.enum.book})))`,
      { active: false, status: "superseded" },
    );
  });
}

function enrollStatementPublicationRetirement(
  tx: Database,
  input: Parameters<typeof retireStatementPublications>[1],
) {
  if (!input.suggestionIds.length) return;
  return runAfterCommit(tx, (committed) =>
    retireStatementPublications(committed, input),
  );
}

/** A crash can leave a durable application receipt before its retirement check ran. */
export async function repairStatementApplicationReceipts(
  db: Database,
  receipts: readonly { suggestionId: string; charge: ChargeRef }[],
) {
  if (!receipts.length) return;
  await retireStatementPublications(db, {
    suggestionIds: receipts.map((receipt) => receipt.suggestionId),
    charges: sql.join(
      receipts.map(
        ({ charge }) => sql`(${charge.source}, ${charge.chargeKey})`,
      ),
      sql`, `,
    ),
  });
}

export type CompleteStatementLabelPublication = {
  proposal: ChargeProposal;
  evidenceFingerprint: string;
  checkpoint: StatementLabelCheckpoint;
  producer: SuggestionProducer & { kind: "model" };
};

export type StatementLabelPublicationResult =
  | {
      kind: "ready";
      origin: "published" | "recovered";
      receipt: {
        suggestionId: string;
        evidenceFingerprint: string;
        applicationOrder: z.infer<typeof statementApplicationOrder> | null;
      };
    }
  | {
      kind: "resolved";
      reason: Exclude<PublishOutcome, "published"> | "out_of_scope";
    }
  | { kind: "failed"; error: unknown };

/** New writes and recovery use the same locks, evidence fences and receipt owner. */
async function publishCompleteLabelBatch(
  db: Database,
  entries: readonly CompleteStatementLabelPublication[],
  scope?: StatementSuggestionScope,
): Promise<Map<string, StatementLabelPublicationResult>> {
  const publish = async (tx: Database) => {
    await assertWorkflowEffect(tx);
    const prior = await lockSuggestionSlots(
      tx,
      statementSuggestions,
      entries.map(({ proposal }) => ({ proposal })),
    );
    const charges = tuples(entries.map(({ proposal }) => proposal.charge));
    const current = await currentChargeStates(
      tx,
      entries.map(({ proposal }) => proposal.charge),
    );
    const outcomes = new Map<string, StatementLabelPublicationResult>();
    const scopedIds = scope
      ? await statementLabelTargetsInScope(
          tx,
          scope,
          prior.flatMap((history) =>
            history
              .filter(
                (row) =>
                  row.active && row.status === suggestionStatus.enum.pending,
              )
              .map((row) => row.id),
          ),
        )
      : null;
    await assertProviderIdentityPublication(
      tx,
      entries
        .filter((_, index) => {
          const pending = prior[index]!.filter(
            (row) => row.active && row.status === suggestionStatus.enum.pending,
          );
          return (
            !scopedIds ||
            !pending.length ||
            pending.some((row) => scopedIds.has(row.id))
          );
        })
        .map(({ proposal }) => proposal),
    );
    const publications: Array<{
      entry: CompleteStatementLabelPublication;
      history: ChargePublicationHistory[];
      applicationOrder: z.infer<typeof statementApplicationOrder> | null;
    }> = [];
    const retirementIds: string[] = [];
    for (const [index, entry] of entries.entries()) {
      const { proposal } = entry;
      const id = chargeId(proposal.charge);
      const history = prior[index]!;
      // Check the live resolver before publication and receipt recovery, not
      // merely the account retained on the previously admitted Suggestion.
      const pending = history.filter(
        (row) => row.active && row.status === suggestionStatus.enum.pending,
      );
      if (
        scopedIds &&
        pending.length &&
        !pending.some((row) => scopedIds.has(row.id))
      ) {
        outcomes.set(id, { kind: "resolved", reason: "out_of_scope" });
        continue;
      }
      const checkpoint = statementLabelCheckpoint.parse(entry.checkpoint);
      if (
        checkpoint.revision !== STATEMENT_LABEL_REVISION ||
        !checkpoint.spending ||
        (proposal.judgment.create &&
          (!checkpoint.kind || !checkpoint.counterparty)) ||
        proposal.judgment.candidates.some(
          (candidate) => candidate.label === null,
        ) ||
        canonicalJson(checkpoint.judgment) !== canonicalJson(proposal.judgment)
      )
        throw new Error(
          "Complete statement publication requires its complete label checkpoint",
        );
      if (
        history.some(
          (row) =>
            row.active &&
            row.suppression !== null &&
            (row.fingerprint === proposal.fingerprint ||
              row.evidenceFingerprint === proposal.evidenceFingerprint),
        )
      ) {
        outcomes.set(id, { kind: "resolved", reason: "suppressed" });
        continue;
      }
      const state = current.get(id);
      if (
        proposal.judgment.recommended !== "void" &&
        state &&
        chargeSettled(state, proposal.judgment)
      ) {
        await retireSettledChargeAdvice(tx, proposal.charge);
        outcomes.set(id, { kind: "resolved", reason: "settled" });
        continue;
      }
      if (isSettledBooking(proposal.judgment)) {
        const fresh = await prepareStatementSpending(tx, proposal.judgment);
        if (fresh?.status === "already_booked") {
          await transitionSuggestionStates(
            tx,
            sql`${pendingStatementState} AND ${suggestionField("source", STATE)}=${proposal.charge.source} AND ${suggestionField("chargeKey", STATE)}=${proposal.charge.chargeKey}`,
            { active: false, status: "superseded" },
          );
          outcomes.set(id, { kind: "resolved", reason: "settled" });
          continue;
        }
      }
      // A committed later-round publication already replaced the old input.
      // Recover its receipt before testing that input's now-obsolete fence.
      const recovered = history.find(
        (row) =>
          row.active &&
          row.status === suggestionStatus.enum.pending &&
          row.fingerprint === proposal.fingerprint &&
          row.evidenceFingerprint === proposal.evidenceFingerprint &&
          row.producer?.kind === "model" &&
          row.producer.revision === STATEMENT_LABEL_REVISION &&
          statementLabelCheckpoint.nullable().parse(row.checkpoint)
            ?.revision === STATEMENT_LABEL_REVISION,
      );
      if (recovered) {
        if (recovered.applicationPending === "true") {
          outcomes.set(id, {
            kind: "ready",
            origin: "recovered",
            receipt: {
              suggestionId: recovered.id,
              evidenceFingerprint: proposal.evidenceFingerprint,
              applicationOrder: statementApplicationOrder
                .nullable()
                .parse(recovered.applicationOrder),
            },
          });
          retirementIds.push(recovered.id);
        } else outcomes.set(id, { kind: "resolved", reason: "unchanged" });
        continue;
      }
      if (
        !history.some(
          (row) =>
            row.active &&
            row.status === suggestionStatus.enum.pending &&
            row.evidenceFingerprint === entry.evidenceFingerprint,
        )
      )
        throw new Error(
          "Statement label publication lost its active evidence fence",
        );
      if (
        (
          await unchangedSuggestions(
            statementSuggestions,
            history,
            { proposal },
            entry.producer,
          )
        ).length
      ) {
        outcomes.set(id, { kind: "resolved", reason: "unchanged" });
        continue;
      }
      const inputPosition = history.find(
        (row) => row.active && row.status === suggestionStatus.enum.pending,
      );
      const applicationOrder = inputPosition
        ? (statementApplicationOrder
            .nullable()
            .parse(inputPosition.applicationOrder) ?? {
            createdAt: inputPosition.createdAt,
            id: inputPosition.id,
          })
        : null;
      if (!state) {
        const outcome = await publishChargeProposal(
          tx,
          proposal,
          entry.producer,
          entry,
        );
        outcomes.set(
          id,
          outcome.outcome === "published"
            ? {
                kind: "ready",
                origin: "published",
                receipt: {
                  suggestionId: outcome.suggestionId,
                  evidenceFingerprint: proposal.evidenceFingerprint,
                  applicationOrder,
                },
              }
            : { kind: "resolved", reason: outcome.outcome },
        );
        continue;
      }
      publications.push({
        entry: { ...entry, checkpoint },
        history,
        applicationOrder,
      });
    }
    await retireSupersededSuggestions(
      tx,
      publications.flatMap(({ history }) =>
        history.filter((row) => row.active).map((row) => row.id),
      ),
    );
    if (publications.length) {
      const published = await publishSuggestions(
        tx,
        publications.map(({ entry, history, applicationOrder }) =>
          chargePublication(
            entry.proposal,
            entry.producer,
            history.length,
            applicationOrder,
            entry.checkpoint,
          ),
        ),
      );
      for (const [index, publication] of publications.entries()) {
        const suggestion = published[index];
        if (!suggestion)
          throw new Error("Statement publication returned no receipt");
        retirementIds.push(suggestion.id);
        outcomes.set(chargeId(publication.entry.proposal.charge), {
          kind: "ready",
          origin: "published",
          receipt: {
            suggestionId: suggestion.id,
            evidenceFingerprint: publication.entry.proposal.evidenceFingerprint,
            applicationOrder: publication.applicationOrder,
          },
        });
      }
    }
    // Recovery-only batches must finish the lost effect too.
    await enrollStatementPublicationRetirement(tx, {
      charges,
      suggestionIds: retirementIds,
    });
    return outcomes;
  };
  return scope
    ? withSnapshotWriteDatabase(db, publish, { isolationLevel: "serializable" })
    : withTransactionDatabase(db, publish);
}

/** Isolate failed entries without replaying a committed publication as a new write. */
export async function publishCompleteStatementLabels(
  db: Database,
  entries: readonly CompleteStatementLabelPublication[],
  scope?: StatementSuggestionScope,
): Promise<Map<string, StatementLabelPublicationResult>> {
  if (
    new Set(entries.map((entry) => chargeId(entry.proposal.charge))).size !==
    entries.length
  )
    throw new Error(
      "Complete statement publication contains duplicate charges",
    );
  const key = (entry: CompleteStatementLabelPublication) =>
    chargeId(entry.proposal.charge);
  const outcomes = new Map<string, StatementLabelPublicationResult>();
  await inSuggestionBatches(entries, {
    concurrency: STATEMENT_PUBLISH_CONCURRENCY,
    label: suggestionFamily.enum.statement_transaction,
    batch: async (batch) => {
      const published = await publishCompleteLabelBatch(db, batch, scope);
      return batch.map((entry) => published.get(key(entry)));
    },
    one: async (entry) => {
      const outcome = (await publishCompleteLabelBatch(db, [entry], scope)).get(
        key(entry),
      );
      if (!outcome)
        throw new Error("Statement label publication lost its entry");
      return outcome;
    },
    onOutcome: (entry, outcome) => outcomes.set(key(entry), outcome),
    onFailure: (entry, error) =>
      outcomes.set(key(entry), { kind: "failed", error }),
  });
  return outcomes;
}

const ruleProducer = (runId: RunId | null): SuggestionProducer => ({
  kind: "rule",
  model: null,
  revision: STATEMENT_SUGGESTION_REVISION,
  runId,
  evaluationId: null,
});

const statementGenerationFailure = (
  ref: string,
  error: unknown,
): RunStepError => ({
  at: new Date().toISOString(),
  ref,
  message: runFailureText(error instanceof Error ? error : String(error)),
});

/** A failed batch read isolates malformed evidence without slowing healthy preparation. */
async function prepareStatementGenerationPage(
  db: Database,
  charges: readonly ChargeRef[],
  failed: RunStepError[],
) {
  try {
    return await buildChargeProposals(db, charges);
  } catch (error) {
    if (isWorkflowInterrupted(error)) throw error;
    const prepared = new Map<string, ChargeProposal>();
    await forEachConcurrently(
      charges,
      STATEMENT_PUBLISH_CONCURRENCY,
      async (charge) => {
        try {
          const [proposal] = await buildChargeProposals(db, [charge]);
          if (proposal) prepared.set(chargeId(charge), proposal);
        } catch (itemError) {
          if (isWorkflowInterrupted(itemError)) throw itemError;
          failed.push(
            statementGenerationFailure(`charge:${chargeId(charge)}`, itemError),
          );
        }
      },
    );
    return charges.flatMap((charge) => {
      const proposal = prepared.get(chargeId(charge));
      return proposal ? [proposal] : [];
    });
  }
}

/** Recompute and publish named charges, e.g. the siblings of an applied one. */
export async function regenerateCharges(
  db: Database,
  charges: readonly ChargeRef[],
  scope?: StatementSuggestionScope,
) {
  if (!charges.length) return;
  const admitted =
    scope?.importId || scope?.since
      ? new Set(
          (
            await unwrapDb(db).execute<ChargeRef>(sql`
        SELECT scoped.source, scoped."chargeKey" FROM (${scopedStatementChargeKeys(scope)}) scoped
        WHERE (scoped.source, scoped."chargeKey") IN (${tuples(charges)})
      `)
          ).rows.map(chargeId),
        )
      : null;
  for (const proposal of await buildChargeProposals(
    db,
    admitted
      ? charges.filter((charge) => admitted.has(chargeId(charge)))
      : charges,
  )) {
    if (
      scope?.accountIds?.length &&
      !scope.accountIds.includes(proposal.judgment.accountId)
    )
      continue;
    await publishChargeProposal(db, proposal, ruleProducer(null));
  }
}

/** Admit a retry in its current scope before repairing any projection. */
async function admitRetriedCharge(
  db: Database,
  charge: ChargeRef,
  scope: StatementSuggestionScope,
) {
  const observations = await loadObservations(db, [charge]);
  if (!observations.length)
    throw new Error("Retained charge identity was not found");
  if (scope.importId || scope.since) {
    const { rows } = await getDb(db).execute(sql`
      SELECT 1 FROM ${sourceObservations} r WHERE ${notDeleted("r")}
        AND r.source = ${charge.source} AND r."chargeKey" = ${charge.chargeKey}
        ${scope.since ? sql`AND r."statementDate" >= ${scope.since}::date` : sql``}
        ${scope.importId ? sql`AND (r.id IN (SELECT m."statementRowId" FROM ${transactionImportMembers} m WHERE m."importId" = ${scope.importId}::uuid) OR r."withdrawalImportId" = ${scope.importId}::uuid)` : sql``}
      LIMIT 1
    `);
    if (!rows.length) return false;
  }
  if (scope.accountIds?.length) {
    const preparation = await prepareFinancialStatementPreview(db);
    const stored = observations.find((row) => row.accountId)?.accountId;
    const preview = await previewFinancialTransactionImport(
      db,
      {
        rows: [previewRowFor(charge, canonicalObservation(observations))],
      },
      {
        preparation,
        candidatePolicy: "suggestion",
        includeVendorInference: false,
        accountHints: new Map(stored ? [[chargeId(charge), stored]] : []),
      },
    );
    const account = preview.rows[0]?.accountId;
    const id = account ? preparation.ids.get(account) : null;
    if (!id || !scope.accountIds.includes(id)) return false;
  }
  return true;
}

/** Re-admit only retained failed charges through the ordinary current-evidence planner. */
export async function retryStatementGenerationRefs(
  db: Database,
  input: {
    runId: RunId | null;
    scope?: StatementSuggestionScope;
    refs: readonly string[];
    work?: PageWork;
  },
) {
  const failed: RunStepError[] = [];
  let done = 0;
  let skipped = 0;
  let published = 0;
  let labelsReused = 0;
  let unchanged = 0;
  for (const ref of input.refs) {
    const original = statementChargeFromWorkRef(ref);
    if (!original) {
      failed.push(
        statementGenerationFailure(
          ref,
          new Error("Unsupported retained statement work reference"),
        ),
      );
      continue;
    }
    try {
      const { rows: mapped } = await getDb(db).execute<{
        source: string;
        chargeKey: string;
        held: boolean;
      }>(sql`
        SELECT DISTINCT observation.source,observation."chargeKey",
          (observation."reviewState"<>${sourceOccurrenceReviewState.enum.ready}) AS held
        FROM ${sourceObservations} observation
        WHERE observation.source=${original.source} AND ${notDeleted("observation")}
          AND (observation."chargeKey"=${original.chargeKey} OR
            -- includes-deleted: retained aliases rebind original work references without accepting ownership.
            EXISTS(SELECT 1 FROM "FinancialEvidenceAlias" retained WHERE retained."observationId"=observation.id
              AND retained.source=${original.source} AND retained.value=${original.chargeKey}))
        ORDER BY observation.source,observation."chargeKey"`);
      if (!mapped.length || mapped.some((charge) => charge.held))
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Retained statement work requires source identity or ownership review. Its original failure reference and paid advice remain retained; resolve the source evidence and retry this same work.",
        );
      const admitted: ChargeRef[] = [];
      for (const charge of mapped) {
        const inScope = await withTransactionDatabase(db, async (tx) => {
          await assertWorkflowEffect(tx);
          await getDb(tx).execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`statement-suggestion:${chargeId(charge)}`},0))`,
          );
          if (!(await admitRetriedCharge(tx, charge, input.scope ?? {})))
            return false;
          await retireSettledChargeAdvice(tx, charge);
          return true;
        });
        if (inScope) admitted.push(charge);
      }
      if (!admitted.length) {
        skipped++;
        continue;
      }
      // A retained work reference remains one progress unit even when its old hint
      // resolves to several independent proven source occurrences.
      const page = await generateStatementSuggestionPage(db, {
        runId: input.runId,
        scope: input.scope,
        after: null,
        retryCharges: admitted,
        work: input.work,
      });
      published += page.published;
      labelsReused += page.labelsReused;
      unchanged += page.unchanged;
      if (page.failed.length)
        failed.push(
          statementGenerationFailure(
            ref,
            new Error(JSON.stringify(page.failed)),
          ),
        );
      else done++;
    } catch (error) {
      if (isWorkflowInterrupted(error)) throw error;
      failed.push(statementGenerationFailure(ref, error));
    }
  }
  return { done, skipped, failed, published, labelsReused, unchanged };
}

/** Keep the publication proposal graph out of the serial application frame. */
async function publishStatementGenerationPage(
  db: Database,
  charges: readonly ChargeRef[],
  scope: StatementSuggestionScope | undefined,
  runId: RunId | null,
  failed: RunStepError[],
) {
  let published = 0;
  let labelsReused = 0;
  let unchanged = 0;
  const accountIds = scope?.accountIds;
  log.info("Statement generation phase", {
    phase: "preparation",
    charges: charges.length,
  });
  const built = await prepareStatementGenerationPage(db, charges, failed);
  const preparedAt = performance.now();
  const proposals = accountIds?.length
    ? built.filter((proposal) =>
        accountIds.includes(proposal.judgment.accountId),
      )
    : built;
  const outOfScope = built.length - proposals.length;
  log.info("Statement generation phase", {
    phase: "publication",
    proposals: proposals.length,
    observations: proposals.reduce(
      (total, proposal) => total + proposal.observations.length,
      0,
    ),
    transactionCandidates: proposals.reduce(
      (total, proposal) => total + proposal.judgment.candidates.length,
      0,
    ),
    purchaseCandidates: proposals.reduce(
      (total, proposal) =>
        total + (proposal.judgment.spending?.candidates.length ?? 0),
      0,
    ),
  });
  // Publish independent charges first; import applications then recheck the
  // current ledger sequentially, including reused labels on unchanged imports.
  const producer = ruleProducer(runId);
  await publishSuggestionBatches(
    db,
    statementSuggestions,
    proposals.map((proposal) => ({ proposal })),
    producer,
    {
      concurrency: STATEMENT_PUBLISH_CONCURRENCY,
      onOutcome: (_, result) => {
        const outcome = statementOutcome(result, producer);
        labelsReused += outcome.labelsReused;
        if (outcome.outcome === "published") published++;
        else unchanged++;
      },
      onFailure: ({ proposal }, error) =>
        failed.push(
          statementGenerationFailure(
            `charge:${chargeId(proposal.charge)}`,
            error,
          ),
        ),
    },
  );
  const publishedAt = performance.now();
  return {
    charges: proposals.map(({ charge }) => charge),
    published,
    labelsReused,
    unchanged,
    outOfScope,
    preparedAt,
    publishedAt,
  };
}

/** One generation page: deterministic, safe to repeat, resumable at `next`. */
export async function generateStatementSuggestionPage(
  db: Database,
  input: {
    after: ChargeRef | null;
    runId: RunId | null;
    limit?: number;
    scope?: StatementSuggestionScope;
    /** A Run step's page recorder; receives the same timings the log line carries. */
    work?: PageWork;
    /** Retained item failures only; never advance or restart the population cursor. */
    retryCharges?: readonly ChargeRef[];
  },
): Promise<{
  found: number;
  published: number;
  processed: number;
  labelsReused: number;
  unchanged: number;
  /** Charges read but resolved to an account outside the scope. */
  outOfScope: number;
  failed: RunStepError[];
  next: ChargeRef | null;
}> {
  const limit = Math.max(
    1,
    Math.min(
      input.limit ?? STATEMENT_SUGGESTION_PAGE,
      // Import generation also admits serial money writes before its checkpoint.
      input.scope?.importId
        ? JOB_PAGE_LIMITS.statementApplicationsPerPage
        : JOB_PAGE_LIMITS.statementGenerationPerPage,
    ),
  );
  const startedAt = performance.now();
  log.info("Statement generation phase", {
    phase: "selection",
    limit,
  });
  const charges = input.retryCharges
    ? [...input.retryCharges]
    : await nextUnmatchedCharges(db, {
        after: input.after,
        limit,
        scope: input.scope ?? {},
      });
  const failed: RunStepError[] = [];
  const selectedAt = performance.now();
  const {
    charges: proposalCharges,
    published,
    labelsReused,
    unchanged,
    outOfScope,
    preparedAt,
    publishedAt,
  } = await publishStatementGenerationPage(
    db,
    charges,
    input.scope,
    input.runId,
    failed,
  );
  if (input.scope?.importId) {
    const { applyAutomaticRulesForCharge } =
      await import("~/server/generic/suggestions/repo/automatic-application");
    for (const [chargeIndex, charge] of proposalCharges.entries()) {
      const ref = `charge:${chargeId(charge)}`;
      if (failed.some((failure) => failure.ref === ref)) continue;
      try {
        log.info("Statement generation phase", {
          phase: "regeneration",
          chargeIndex,
          charges: proposalCharges.length,
        });
        await regenerateCharges(db, [charge], input.scope);
        log.info("Statement generation phase", {
          phase: "application",
          chargeIndex,
          charges: proposalCharges.length,
        });
        await applyAutomaticRulesForCharge(db, charge, true, input.scope);
      } catch (error) {
        if (isWorkflowInterrupted(error)) throw error;
        failed.push(statementGenerationFailure(ref, error));
      }
    }
  }
  const timings = {
    selection: Math.round(selectedAt - startedAt),
    preparation: Math.round(preparedAt - selectedAt),
    publication: Math.round(publishedAt - preparedAt),
    application: Math.round(performance.now() - publishedAt),
  };
  log.info("Statement generation page", {
    charges: charges.length,
    proposals: proposalCharges.length,
    published,
    unchanged,
    failed: failed.length,
    selectionMs: timings.selection,
    preparationMs: timings.preparation,
    publicationMs: timings.publication,
    applicationMs: timings.application,
  });
  input.work?.add({
    timings,
    concurrency: {
      publication: peakWorkers(
        STATEMENT_PUBLISH_CONCURRENCY,
        proposalCharges.length,
      ),
    },
  });
  return {
    found: charges.length,
    published,
    processed: charges.length,
    labelsReused,
    unchanged,
    outOfScope,
    failed,
    next:
      !input.retryCharges && charges.length === limit ? charges.at(-1)! : null,
  };
}

/** The holds `generateStatementHoldVoidPage` pages, for a step's frozen count. */
export async function countStatementPendingHolds(
  db: Database,
  scope?: StatementSuggestionScope,
) {
  return (
    await statementPendingTransactions(db, await holdAccounts(db, scope), {
      scope,
    })
  ).length;
}

/** Vanished holds use their own bounded transaction-ID cursor, including non-voidable holds. */
export async function generateStatementHoldVoidPage(
  db: Database,
  input: {
    after: string | null;
    runId: RunId | null;
    limit?: number;
    scope?: StatementSuggestionScope;
  },
) {
  const limit = Math.max(
    1,
    Math.min(
      input.limit ?? STATEMENT_SUGGESTION_PAGE,
      JOB_PAGE_LIMITS.suggestionsPerPage,
    ),
  );
  const accounts = await holdAccounts(db, input.scope);
  const holds = await statementPendingTransactions(db, accounts, {
    scope: input.scope,
    page: { after: input.after, limit },
  });
  const failed: RunStepError[] = [];
  const proposals = await buildHoldVoidProposalsForHolds(
    db,
    holds,
    (hold, error) => {
      failed.push(
        statementGenerationFailure(`statement_hold:${hold.id}`, error),
      );
    },
  );
  let published = 0;
  let labelsReused = 0;
  let unchanged = 0;
  await forEachConcurrently(
    proposals,
    STATEMENT_PUBLISH_CONCURRENCY,
    async (proposal) => {
      try {
        const outcome = await publishChargeProposal(
          db,
          proposal,
          ruleProducer(input.runId),
        );
        labelsReused += outcome.labelsReused;
        if (outcome.outcome === "published") published++;
        else unchanged++;
      } catch (error) {
        if (isWorkflowInterrupted(error)) throw error;
        const ref = proposal.judgment.void
          ? `statement_hold:${proposal.judgment.void.transactionId}`
          : `charge:${chargeId(proposal.charge)}`;
        failed.push(statementGenerationFailure(ref, error));
      }
    },
  );
  return {
    found: holds.length,
    processed: holds.length,
    published,
    labelsReused,
    unchanged,
    failed,
    next: holds.length === limit ? holds.at(-1)!.id : null,
  };
}

/** A label pass's position in `(createdAt, id)` order. */
export type LabelCursor = z.infer<typeof statementApplicationOrder> & {
  inclusive?: boolean;
};

/** A partial judgment is unpublished work, not a new advisory suggestion. */
export async function recordStatementLabelCheckpoint(
  db: Database,
  input: {
    charge: ChargeRef;
    evidenceFingerprint: string;
    checkpoint: StatementLabelCheckpoint;
    scope?: StatementSuggestionScope;
  },
): Promise<"saved" | "settled" | "moved" | "out_of_scope"> {
  const checkpoint = statementLabelCheckpoint.parse(input.checkpoint);
  const save = async (
    tx: Database,
  ): Promise<"saved" | "settled" | "moved" | "out_of_scope"> => {
    await assertWorkflowEffect(tx);
    if (input.scope) {
      const { rows } = await unwrapDb(tx).execute<{ id: string }>(sql`
        SELECT s.id FROM "Suggestion" s WHERE ${pendingSuggestion()}
          AND ${suggestionField("source")} = ${input.charge.source}
          AND ${suggestionField("chargeKey")} = ${input.charge.chargeKey}
          AND ${suggestionField("evidenceFingerprint")} = ${input.evidenceFingerprint}
      `);
      if (
        rows.length &&
        !(
          await statementLabelTargetsInScope(
            tx,
            input.scope,
            rows.map((row) => row.id),
          )
        ).size
      )
        return "out_of_scope";
    }
    let matched = 0;
    await transitionSuggestionStates(
      tx,
      sql`${pendingSuggestion(STATE)}
      AND ${suggestionField("source", STATE)} = ${input.charge.source}
      AND ${suggestionField("chargeKey", STATE)} = ${input.charge.chargeKey}
      AND ${suggestionField("evidenceFingerprint", STATE)} = ${input.evidenceFingerprint}`,
      (row) => {
        matched += 1;
        const data = stateData.parse(row.data ?? {});
        const previous = statementLabelCheckpoint.safeParse(
          data.labelCheckpoint,
        );
        const merged = structuredClone(checkpoint);
        const retained =
          previous.success &&
          previous.data.revision === checkpoint.revision &&
          canonicalJson(statementLabelSubject(previous.data.judgment)) ===
            canonicalJson(statementLabelSubject(checkpoint.judgment))
            ? previous.data
            : null;
        if (retained) {
          // First committed answers win; a stale preparation cannot erase them
          // and later replay them as supposedly new recovery progress.
          for (const candidate of merged.judgment.candidates)
            candidate.label =
              retained.judgment.candidates.find(
                (saved) =>
                  saved.transactionId === candidate.transactionId &&
                  canonicalJson(statementCandidateSubject(saved)) ===
                    canonicalJson(statementCandidateSubject(candidate)),
              )?.label ?? candidate.label;
          const create = merged.judgment.create;
          if (create && retained.judgment.create) {
            if (retained.kind)
              create.votes.label = retained.judgment.create.votes.label;
            if (retained.counterparty)
              create.counterparty.label =
                retained.judgment.create.counterparty.label;
            Object.assign(
              create,
              decideStatementKind({
                amount: create.amount,
                votes: create.votes,
                counterparty: create.counterparty,
                transfer: merged.judgment.transfer,
              }),
            );
          }
          if (retained.spending)
            merged.judgment.spending = retained.judgment.spending;
          merged.kind ||= retained.kind;
          merged.counterparty ||= retained.counterparty;
          merged.spending ||= retained.spending;
          merged.models = [...new Set([...retained.models, ...merged.models])];
          merged.model = merged.models.length === 1 ? merged.models[0]! : null;
        }
        return {
          data: {
            ...data,
            labelCheckpoint: z.json().parse(jsonSnapshot.parse(merged)),
          },
        };
      },
    );
    if (matched) {
      return "saved";
    }
    const { rows: settled } = await unwrapDb(tx).execute(sql`
    SELECT 1 FROM ${chargeStateOf(sql`r.source = ${input.charge.source} AND ${chargeKeyOf("r")} = ${input.charge.chargeKey}`)} cs
    WHERE ${checkpoint.judgment.recommended !== statementTransactionAction.enum.void}
      AND (cs.ignored OR cs.superseded OR (cs.shortcode IS NOT NULL AND ${checkpoint.judgment.recommended !== "book"}))
    LIMIT 1
  `);
    return settled.length ? "settled" : "moved";
  };
  return input.scope
    ? withSnapshotWriteDatabase(db, save, { isolationLevel: "serializable" })
    : withTransactionDatabase(db, save);
}

/** Clear only the receipt whose application settled; a replacement owns its own receipt. */
export async function completeStatementApplications(
  db: Database,
  suggestionIds: readonly string[],
  scope?: StatementSuggestionScope,
) {
  if (!suggestionIds.length) return [];
  const complete = async (tx: Database) => {
    await assertWorkflowEffect(tx);
    // Completion mutates durable receipt/cursor state even when no financial
    // rule applied. Its write admission must retain the original selection.
    const scoped = scope
      ? await statementLabelTargetsInScope(tx, scope, suggestionIds)
      : null;
    const admitted = suggestionIds.filter((id) => !scoped || scoped.has(id));
    if (!admitted.length) return [];
    await transitionSuggestionStates(
      tx,
      inArray(suggestionTable.id, admitted),
      (row) => {
        const {
          applicationPending: _pending,
          applicationOrder: _order,
          ...data
        } = stateData.parse(row.data ?? {});
        return { data };
      },
    );
    return admitted;
  };
  return scope
    ? withSnapshotWriteDatabase(db, complete, {
        isolationLevel: "serializable",
      })
    : withTransactionDatabase(db, complete);
}

export const STATEMENT_APPLICATION_PREFIX_LIMIT =
  JOB_PAGE_LIMITS.suggestionsPerPage;

/** A locked publication without import authority or applicable rule stamps cannot admit an automatic effect.
 * Only the original consecutive prefix is resolved; callers must apply a
 * boundary charge after releasing these locks and reread the remaining suffix.
 */
export async function completeNoActionStatementPrefix(
  db: Database,
  entries: readonly {
    suggestionId: string;
    charge: ChargeRef;
    evidenceFingerprint: string;
  }[],
  scope?: StatementSuggestionScope,
) {
  if (scope?.importId) return 0;
  const window = entries.slice(0, STATEMENT_APPLICATION_PREFIX_LIMIT);
  if (!window.length) return 0;
  if (new Set(window.map((entry) => entry.suggestionId)).size !== window.length)
    throw new Error("Statement application prefix contains duplicate receipts");
  // A negative preflight only declines batching; ordinary admission reads fresh.
  // Positive results prove nothing until the whole prefix is locked and checked.
  // Import-only rules are inapplicable to this unscoped path regardless of their switch.
  // Unknown or obsolete stamps remain boundaries; only exact current stamps are excluded.
  const excluded = importOnlyStatementRuleStamps();
  const hasApplicableRules = (data: SQL) => sql<boolean>`EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(${matchedRulesOf(data)}) AS matched(value)
    WHERE matched.value IS NULL OR NOT ${inArray(sql`matched.value`, excluded)})`;
  const first = window[0]!;
  const [candidate] = await getDb(db)
    .select({ id: suggestionTable.id })
    .from(suggestionTable)
    .where(
      and(
        eq(suggestionTable.id, first.suggestionId),
        eq(suggestionTable.family, suggestionFamily.enum.statement_transaction),
        eq(suggestionTable.active, true),
        eq(suggestionTable.status, suggestionStatus.enum.pending),
        isNull(suggestionTable.suppression),
        sql`${suggestionField("source", STATE)} = ${first.charge.source}`,
        sql`${suggestionField("chargeKey", STATE)} = ${first.charge.chargeKey}`,
        sql`${suggestionField("evidenceFingerprint", STATE)} = ${first.evidenceFingerprint}`,
        sql`${suggestionTable.data}->'applicationPending' = 'true'::jsonb`,
        sql`NOT ${hasApplicableRules(sql`${suggestionTable.data}`)}`,
      ),
    )
    .limit(1);
  if (!candidate) return 0;
  const complete = async (tx: Database) => {
    await assertWorkflowEffect(tx);
    const rows = await getDb(tx)
      .select({
        id: suggestionTable.id,
        family: suggestionTable.family,
        active: suggestionTable.active,
        status: suggestionTable.status,
        suppression: suggestionTable.suppression,
        data: suggestionTable.data,
        hasRules: hasApplicableRules(sql`${suggestionTable.data}`),
      })
      .from(suggestionTable)
      .where(
        inArray(
          suggestionTable.id,
          window.map((entry) => entry.suggestionId),
        ),
      )
      .orderBy(suggestionTable.id)
      .for("update");
    const byId = new Map(rows.map((row) => [row.id, row]));
    const scoped = scope
      ? await statementLabelTargetsInScope(
          tx,
          scope,
          rows.map((row) => row.id),
        )
      : null;
    const settled: string[] = [];
    for (const entry of window) {
      const row = byId.get(entry.suggestionId);
      const data = stateData.safeParse(row?.data);
      if (
        !row ||
        (scoped && !scoped.has(entry.suggestionId)) ||
        row.family !== suggestionFamily.enum.statement_transaction ||
        !row.active ||
        row.status !== suggestionStatus.enum.pending ||
        row.suppression !== null ||
        row.hasRules ||
        !data.success ||
        data.data.source !== entry.charge.source ||
        data.data.chargeKey !== entry.charge.chargeKey ||
        data.data.evidenceFingerprint !== entry.evidenceFingerprint ||
        data.data.applicationPending !== true
      )
        break;
      settled.push(entry.suggestionId);
    }
    return (await completeStatementApplications(tx, settled, scope)).length;
  };
  return scope
    ? withSnapshotWriteDatabase(db, complete, {
        isolationLevel: "serializable",
      })
    : withTransactionDatabase(db, complete);
}

/**
 * Pending rule suggestions awaiting decision-model labels after the cursor.
 * A stale row is paged past rather than ending the pass; regeneration
 * republishes it under a later position.
 */
async function statementLabelCandidates(
  db: Database,
  limit: number,
  after: LabelCursor | null = null,
  scope: StatementSuggestionScope = {},
  retryCharges?: readonly ChargeRef[],
) {
  const scoped = labelIdentityScope(scope);
  const retained =
    retryCharges === undefined
      ? sql`true`
      : retryCharges.length
        ? sql`-- includes-deleted: retained aliases map prior work without establishing current financial ownership.
    EXISTS (
    SELECT 1 FROM ${sourceObservationIdentities} observation
    WHERE observation.source=${suggestionField("source")} AND observation."chargeKey"=${suggestionField("chargeKey")}
      AND (${sql.join(
        retryCharges.map(
          (
            charge,
          ) => sql`(observation.source=${charge.source} AND (observation."chargeKey"=${charge.chargeKey} OR
        -- includes-deleted: retained aliases rebind original work references without accepting ownership.
        EXISTS(SELECT 1 FROM "FinancialEvidenceAlias" retained WHERE retained."observationId"=observation.id AND retained.source=${charge.source} AND retained.value=${charge.chargeKey})))`,
        ),
        sql` OR `,
      )})
  )`
        : sql`false`;
  const positionAt = sql`coalesce((s.data->'applicationOrder'->>'createdAt')::timestamp, s."createdAt")`;
  const positionId = sql`coalesce((s.data->'applicationOrder'->>'id')::uuid, s.id)`;
  const nativePosition = sql`(s.data->'applicationOrder'->>'createdAt' IS NULL AND s.data->'applicationOrder'->>'id' IS NULL)`;
  const selectPositions = (position: "native" | "retained") => {
    const at = position === "native" ? sql`s."createdAt"` : positionAt;
    const id = position === "native" ? sql`s.id` : positionId;
    return sql`SELECT s.id, ${at} AS "positionAt", ${id} AS "positionId"
      FROM "Suggestion" s
      WHERE ${statementSuggestions.labelBacklog}
        AND ${position === "native" ? nativePosition : sql`NOT ${nativePosition}`}
        AND ${scoped}
        AND ${retained}
        ${after ? sql`AND (${at}, ${id}) ${after.inclusive ? sql`>=` : sql`>`} (${after.createdAt}::timestamp, ${after.id}::uuid)` : sql``}
      ORDER BY ${at},${id} LIMIT ${limit}`;
  };
  // Disjoint positions preserve the global first K in their two first-K sets.
  // Identity/date eligibility and the cursor precede each branch limit.
  const query = sql`WITH selected AS MATERIALIZED (
    SELECT * FROM ((${selectPositions("native")}) UNION ALL (${selectPositions("retained")})) candidates
    ORDER BY "positionAt","positionId" LIMIT ${limit}
  )
  SELECT selected.id,to_char(selected."positionAt",'YYYY-MM-DD"T"HH24:MI:SS.US') AS "createdAt",selected."positionId" AS "cursorId"
  FROM selected
  ORDER BY selected."positionAt",selected."positionId"`;
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    createdAt: string;
    cursorId: string;
  }>(query);
  return rows;
}

/** Fill the requested scoped page, advancing over excluded cursor candidates. */
export async function suggestionsNeedingLabels(
  db: Database,
  limit: number,
  after: LabelCursor | null = null,
  scope: StatementSuggestionScope = {},
  retryCharges?: readonly ChargeRef[],
) {
  const selected: Awaited<ReturnType<typeof statementLabelCandidates>> = [];
  let cursor = after;
  // A nearly full output page must not turn a sparse suffix into one preview
  // per excluded candidate. Extra admitted rows retain their native positions.
  const scanLimit = Math.min(limit, STATEMENT_SUGGESTION_PAGE);
  while (selected.length < limit) {
    const candidates = await statementLabelCandidates(
      db,
      scanLimit,
      cursor,
      scope,
      retryCharges,
    );
    const admitted = scope.accountIds?.length
      ? await statementLabelTargetsInScope(
          db,
          scope,
          candidates.map((row) => row.id),
        )
      : null;
    selected.push(
      ...candidates
        .filter((row) => !admitted || admitted.has(row.id))
        .slice(0, limit - selected.length),
    );
    const last = candidates.at(-1);
    if (!last || candidates.length < scanLimit) break;
    cursor = { createdAt: last.createdAt, id: last.cursorId };
  }
  if (!selected.length) return [];
  // Account preparation is bounded by cursor candidates; only the filled page
  // hydrates judgments/checkpoints. Exclusions never end a partial scan early.
  const query = sql`WITH selected(id,"positionAt","positionId") AS (VALUES ${sql.join(
    selected.map(
      (row) =>
        sql`(${row.id}::uuid,${row.createdAt}::timestamp,${row.cursorId}::uuid)`,
    ),
    sql`, `,
  )})
  SELECT s.id,to_char(selected."positionAt",'YYYY-MM-DD"T"HH24:MI:SS.US') AS "createdAt",selected."positionId" AS "cursorId",
    s.subject,s.judgment,s.data->'amount' AS amount,
    ${suggestionField("evidenceFingerprint")} AS "evidenceFingerprint",s.data->'labelCheckpoint' AS checkpoint,
    coalesce((s.data->>'applicationPending')::boolean,false) AS "applicationPending"
  FROM selected JOIN "Suggestion" s ON s.id=selected.id
  ORDER BY selected."positionAt",selected."positionId"`;
  const read = (client: Database) =>
    unwrapDb(client).execute<{
      id: string;
      createdAt: string;
      subject: unknown;
      judgment: unknown;
      amount: unknown;
      evidenceFingerprint: string;
      checkpoint: unknown;
      applicationPending: boolean;
      cursorId: string;
    }>(query);
  const { rows } = await read(db);
  return rows.map((row) => ({
    ...row,
    judgment: suggestionJudgments.statement_transaction.parse(row.judgment),
    amount: z.number().finite().parse(row.amount),
    checkpoint: statementLabelCheckpoint.nullable().parse(row.checkpoint),
  }));
}

const labelIdentityScope = (scope: StatementSuggestionScope) =>
  scope.importId || scope.since
    ? sql`(${suggestionField("source")}, ${suggestionField("chargeKey")}) IN (
        WITH label_scope AS MATERIALIZED (${scopedStatementChargeKeys(scope)})
        SELECT source,"chargeKey" FROM label_scope)`
    : sql`true`;

/** Resolve only named cursor candidates or write-admission targets. */
async function statementLabelScope(
  db: Database,
  scope: StatementSuggestionScope,
  suggestionIds: readonly string[],
) {
  const identity = labelIdentityScope(scope);
  const selected = suggestionIds.length
    ? sql`s.id IN (${sql.join(
        suggestionIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql`false`;
  if (!scope.accountIds?.length) return sql`${identity} AND ${selected}`;
  // Re-admission checks scope alone. Replaced/completed rows still reach the
  // existing evidence fences and later-round regeneration/replay path.
  const eligible = sql`s.family = ${suggestionFamily.enum.statement_transaction}`;
  const { rows } = await unwrapDb(db).execute<
    ChargeRef & {
      id: string;
      voidTarget: boolean;
      voidAccountId: string | null;
    }
  >(sql`
    SELECT s.id, ${suggestionField("source")} AS source, ${suggestionField("chargeKey")} AS "chargeKey",
      s.judgment->${statementTransactionAction.enum.void}->>'transactionId' IS NOT NULL AS "voidTarget",
      held."accountId" AS "voidAccountId"
    FROM "Suggestion" s
    LEFT JOIN "FinancialTransaction" held ON held.id=(s.judgment->${statementTransactionAction.enum.void}->>'transactionId')::uuid
      AND ${notDeleted("held")}
    WHERE ${eligible} AND ${identity} AND ${selected}
  `);
  const admitted: string[] = [];
  const preparation = rows.length
    ? await prepareFinancialStatementPreview(db)
    : undefined;
  for (
    let offset = 0;
    offset < rows.length;
    offset += STATEMENT_SUGGESTION_PAGE
  ) {
    const batch = rows.slice(offset, offset + STATEMENT_SUGGESTION_PAGE);
    const prepared = await prepareChargePreviews(
      db,
      batch.filter((row) => !row.voidTarget),
      preparation,
    );
    const accounts = new Map(
      prepared?.preview.rows.map((row) => [
        row.key,
        row.accountId ? prepared.preparation.ids.get(row.accountId) : undefined,
      ]),
    );
    for (const row of batch) {
      const accountId = row.voidAccountId ?? accounts.get(chargeId(row));
      if (accountId && scope.accountIds.includes(accountId))
        admitted.push(row.id);
    }
  }
  return admitted.length
    ? sql`${identity} AND s.id IN (${sql.join(
        admitted.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql`false`;
}

/** Model latency and retries must re-admit the selected receipts under the same scope. */
export async function statementLabelTargetsInScope(
  db: Database,
  scope: StatementSuggestionScope,
  suggestionIds: readonly string[],
) {
  const scoped = await statementLabelScope(db, scope, suggestionIds);
  const { rows } = await unwrapDb(db).execute<{ id: string }>(sql`
    SELECT s.id FROM "Suggestion" s
    WHERE s.family = ${suggestionFamily.enum.statement_transaction} AND ${scoped}
  `);
  return new Set(rows.map((row) => row.id));
}

/** How many pending suggestions still need labels, for a Sweep's count. */
export async function countSuggestionsNeedingLabels(
  db: Database,
  scope: StatementSuggestionScope = {},
) {
  if (scope.accountIds?.length) {
    let count = 0;
    let after: LabelCursor | null = null;
    for (;;) {
      const candidates = await statementLabelCandidates(
        db,
        STATEMENT_SUGGESTION_PAGE,
        after,
        scope,
      );
      count += (
        await statementLabelTargetsInScope(
          db,
          scope,
          candidates.map((row) => row.id),
        )
      ).size;
      const last = candidates.at(-1);
      if (!last || candidates.length < STATEMENT_SUGGESTION_PAGE) return count;
      after = { createdAt: last.createdAt, id: last.cursorId };
    }
  }
  return countSuggestionLabelBacklog(
    db,
    statementSuggestions,
    labelIdentityScope(scope),
  );
}
