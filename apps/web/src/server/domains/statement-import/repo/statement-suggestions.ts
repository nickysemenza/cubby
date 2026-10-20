import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentFamily,
  assessmentJudgments,
  assessmentProducer,
  type AssessmentProducer,
  feedbackEvent,
  feedbackVerdict,
} from "@cubby/schemas/assessment";
import { financialAccountIdentity } from "@cubby/schemas/financial-account-fields";
import { financialBookingInput } from "@cubby/schemas/financial-booking";
import {
  FINANCIAL_STATEMENT_IMPORT_MAX_ROWS,
  type FinancialStatementImportRow,
} from "@cubby/schemas/financial-transaction";
import {
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import { financialTransactionProviderStatus } from "@cubby/schemas/financial-transaction-fields";
import { statementRowProviderStatus } from "@cubby/schemas/statement-row";
import {
  type StatementCounterparty,
  type StatementKindVotes,
  type StatementTransactionCandidate,
  statementTransactionAction,
  type StatementTransactionJudgment,
  STATEMENT_LABEL_REVISION,
  statementLabelCheckpoint,
  type StatementLabelCheckpoint,
} from "@cubby/schemas/statement-suggestion";
import { cents } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { forEachConcurrently } from "~/lib/concurrency-limiter";
import { plainDateDaysBetween } from "~/lib/household-date";
import type { Database } from "~/server/db";
import {
  getDb,
  runAfterCommit,
  unwrapDb,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { previewFinancialStatementImport } from "~/server/domains/financial-transaction/repo/financial-statement-preview";
import { findTransferPairsForCharges } from "~/server/domains/financial-transaction/repo/transfer-pair-suggestions";
import {
  CHARGE_STATE,
  chargeKeyOf,
  chargeStateOf,
  pendingSuggestion,
  suggestionField,
  suggestionRefKey,
} from "~/server/domains/statement-import/repo/statement-charge";
import { statementImportMembers } from "~/server/domains/statement-import/repo/statement-import-membership";
import {
  statementLabelInputs,
  statementLabelSubject,
} from "~/server/domains/statement-import/repo/statement-label-input";
import {
  decideStatementKind,
  kindAgreed,
  type OwnAccount,
  ownAccountNamed,
  statementTransactionKind,
} from "~/server/domains/statement-import/repo/statement-transaction-kind";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import {
  automaticRuleStamp,
  matchStatementRules,
  statementSubjectKey,
} from "~/server/generic/assessment/repo/automatic-rules";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

import { prepareStatementSpending } from "./statement-spending";

/** Matching revision and Automatic attach precision window; clean-only changes use the policy below. */
export const STATEMENT_SUGGESTION_REVISION = "2026-10-20.1";
/**
 * Bump when only bulk-acceptability changes. Labels ride on top of the
 * evidence fingerprint, so a stricter clean rule would otherwise leave
 * labelled judgments looking current; this republishes them without
 * renaming the revision, which the automatic attach rule's measured windows
 * are keyed by.
 */
const STATEMENT_CLEAN_POLICY = "2026-10-20.2";
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

type Observation = {
  id: string;
  source: string;
  externalId: string;
  chargeKey: string;
  rowPosition: number | null;
  providerTransactionId: string | null;
  accountDescriptor: string;
  statementDate: string;
  providerAmount: number;
  amount: number;
  merchant: string | null;
  rawDescription: string;
  sourceCategory: string | null;
  providerStatus: "posted" | "pending" | null;
  providerNotes: string | null;
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

/** Which unmatched charges a generation pass covers; empty covers the ledger. */
export type StatementSuggestionScope = {
  /** Only the charges one import observed. */
  importId?: string | null;
  /**
   * Only charges that resolve to these FinancialAccounts. Resolution is the
   * preview's (an alias, then a card's last four), so this filters resolved
   * proposals rather than the rows a page reads.
   */
  accountIds?: readonly string[];
  /** Only charges dated on or after this day (`YYYY-MM-DD`). */
  since?: string | null;
};

/** Unmatched charges in `(source, chargeKey)` order after the cursor. */
async function nextUnmatchedCharges(
  db: Database,
  input: {
    after: ChargeRef | null;
    limit: number;
    scope: StatementSuggestionScope;
  },
): Promise<ChargeRef[]> {
  const after = input.after
    ? sql`AND (cs.source, cs."chargeKey") > (${input.after.source}, ${input.after.chargeKey})`
    : sql``;
  const { importId, since } = input.scope;
  // A scope selects whole charges, so the charge's state still reads every
  // live observation of it.
  const filters = [
    ...(importId
      ? [
          sql`seen.id IN (SELECT m."statementRowId" FROM ${statementImportMembers} m WHERE m."importId" = ${importId}::uuid)`,
        ]
      : []),
    ...(since ? [sql`seen."statementDate" >= ${since}::date`] : []),
  ];
  const state = filters.length
    ? chargeStateOf(sql`(r.source, ${chargeKeyOf("r")}) IN (
        SELECT seen.source, ${chargeKeyOf("seen")} FROM "StatementRow" seen
        WHERE seen."deletedAt" IS NULL AND ${sql.join(filters, sql` AND `)}
      )`)
    : CHARGE_STATE;
  const { rows } = await unwrapDb(db).execute<ChargeRef>(sql`
    SELECT cs.source, cs."chargeKey" FROM ${state} cs
    WHERE NOT cs.ignored AND NOT cs.superseded
      AND (cs.shortcode IS NULL OR EXISTS (SELECT 1 FROM "FinancialTransaction" ft
        WHERE ft.shortcode = cs.shortcode AND ft."deletedAt" IS NULL
          AND ft.status = ${financialTransactionStatus.enum.posted}
          AND ft.kind IN (${financialTransactionKind.enum.purchase},${financialTransactionKind.enum.refund},${financialTransactionKind.enum.fee})
          AND (NOT EXISTS (SELECT 1 FROM "FinancialTransactionAllocation" allocation
              WHERE allocation."transactionId" = ft.id AND allocation."deletedAt" IS NULL)
            OR EXISTS (SELECT 1 FROM "AssessmentState" existing
              WHERE existing.family = ${assessmentFamily.enum.statement_transaction} AND existing.active
                AND existing.status = ${suggestionStatus.enum.pending}
                AND existing.data->>${"source"} = cs.source AND existing.data->>${"chargeKey"} = cs."chargeKey"
                AND existing.data->>${"recommended"} = ${statementTransactionAction.enum.book}))))
      ${after}
    ORDER BY cs.source, cs."chargeKey"
    LIMIT ${input.limit}
  `);
  return rows.map((row) => ({ source: row.source, chargeKey: row.chargeKey }));
}

/**
 * Charge work within the import/date bounds: unmatched charges and matched,
 * unallocated spending, plus pending booking work that may now be complete.
 */
export async function countUnmatchedCharges(
  db: Database,
  scope: StatementSuggestionScope,
) {
  let total = 0;
  let after: ChargeRef | null = null;
  for (;;) {
    const page = await nextUnmatchedCharges(db, { after, limit: 5_000, scope });
    total += page.length;
    if (page.length < 5_000) return total;
    after = page.at(-1)!;
  }
}

async function loadObservations(
  db: Database,
  charges: readonly ChargeRef[],
): Promise<Observation[]> {
  if (!charges.length) return [];
  const { rows } = await unwrapDb(db).execute<
    Record<string, string | number | Date | null>
  >(sql`
    SELECT r.id, r.source, r."externalId", ${chargeKeyOf("r")} AS "chargeKey",
      r."rowPosition", r."providerTransactionId", r."accountDescriptor",
      r."statementDate", r."providerAmount", r.amount, r.merchant,
      r."rawDescription", r."sourceCategory", r."providerStatus",
      r."providerNotes", r."accountId", r."createdAt", si.fingerprint AS "importFingerprint"
    FROM "StatementRow" r
    JOIN "StatementImport" si ON si.id = r."batchId"
    WHERE r."deletedAt" IS NULL
      AND (r.source, ${chargeKeyOf("r")}) IN (${tuples(charges)})
    ORDER BY r."createdAt" DESC, r.id
  `);
  return rows.map((row) => ({
    id: String(row.id),
    source: String(row.source),
    externalId: String(row.externalId),
    chargeKey: String(row.chargeKey),
    rowPosition: row.rowPosition === null ? null : Number(row.rowPosition),
    providerTransactionId:
      row.providerTransactionId === null
        ? null
        : String(row.providerTransactionId),
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
    accountId: row.accountId === null ? null : String(row.accountId),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
    importFingerprint: String(row.importFingerprint),
  }));
}

/** The newest observation with a physical position names the charge's settlement ref. */
const canonicalObservation = (observations: Observation[]) =>
  observations.find((row) => row.rowPosition !== null) ?? observations[0]!;

const previewRowFor = (
  charge: ChargeRef,
  row: Observation,
): FinancialStatementImportRow => ({
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
): Promise<PendingTransaction[]> {
  if (!accountIds.length) return [];
  const { rows } = await unwrapDb(db).execute<
    Record<string, string | number | Date | null | string[]>
  >(sql`
    SELECT ft.id, ft."accountId", ft.amount, ft.status, ft."postedDate",
      ft."transactionDate", ft.merchant, ft."rawDescription",
      array_agg(DISTINCT sr.id) AS "pendingRowIds"
    FROM "FinancialTransaction" ft
    JOIN "EntityExternalId" fx ON fx."entityId" = ft.id
      AND fx.kind = 'settlement_ref' AND fx."deletedAt" IS NULL
    JOIN "StatementRow" sr ON sr.source = fx.source AND sr."externalId" = fx."externalId"
      AND sr."deletedAt" IS NULL AND sr."providerStatus" = ${statementRowProviderStatus.enum.pending}
    WHERE ft."deletedAt" IS NULL AND ft.status = ${financialTransactionStatus.enum.pending}
      AND ft."accountId" IN (${sql.join(
        accountIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      AND NOT EXISTS (
        SELECT 1 FROM "EntityExternalId" other
        WHERE other."entityId" = ft.id AND other.kind = 'settlement_ref'
          AND other."deletedAt" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "StatementRow" held
            WHERE held.source = other.source AND held."externalId" = other."externalId"
              AND held."deletedAt" IS NULL AND held."providerStatus" = ${statementRowProviderStatus.enum.pending}
          )
      )
    GROUP BY ft.id
  `);
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
      SELECT p.key, p."rowIds", o.id, o.source, ${chargeKeyOf("o")} AS "chargeKey"
      FROM p JOIN "StatementRow" o ON o.source = p.source
        AND o."accountDescriptor" = p.descriptor
        AND o."providerAmount" = p.amount
        AND o."statementDate" BETWEEN p.day - ${SIBLING_WINDOW_DAYS}::int AND p.day + ${SIBLING_WINDOW_DAYS}::int
        AND o."deletedAt" IS NULL
        AND ${chargeKeyOf("o")} <> p."chargeKey"
    ),
    cs AS MATERIALIZED ${chargeStateOf(
      sql`(r.source, ${chargeKeyOf("r")}) IN (SELECT source, "chargeKey" FROM o)`,
    )},
    members AS MATERIALIZED (
      SELECT m."importId", m."statementRowId" FROM ${statementImportMembers} m
      WHERE m."statementRowId" IN (SELECT id FROM o UNION SELECT unnest("rowIds") FROM p)
    )
    SELECT o.key, array_agg(DISTINCT o."chargeKey" ORDER BY o."chargeKey") AS siblings
    FROM o
    JOIN cs ON cs.source = o.source AND cs."chargeKey" = o."chargeKey"
      AND NOT cs.ignored AND NOT cs.superseded AND cs.shortcode IS NULL
    -- One export speaks one descriptor vocabulary: two of its own rows are two
    -- real charges, so only another export's row can be this money again.
    WHERE NOT EXISTS (
      SELECT 1 FROM members mo
      JOIN members mp ON mp."importId" = mo."importId"
      WHERE mo."statementRowId" = o.id AND mp."statementRowId" = ANY(o."rowIds")
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
    refs AS MATERIALIZED (
      SELECT p.key, p.source, p."chargeKey", p."transactionId", fx."externalId"
      FROM p JOIN "EntityExternalId" fx ON fx."entityId" = p."transactionId"
        AND fx.kind = 'settlement_ref' AND fx."deletedAt" IS NULL
        AND fx.source = p.source
    ),
    -- Two indexed probes rather than one OR join: a ref is either an
    -- occurrence id or a charge key (a v1 hash stored as legacyExternalId).
    hits AS MATERIALIZED (
      SELECT refs.key, refs."transactionId", refs."chargeKey" AS own,
        r.source, ${chargeKeyOf("r")} AS "claimKey"
      FROM refs JOIN "StatementRow" r ON r.source = refs.source
        AND r."externalId" = refs."externalId" AND r."deletedAt" IS NULL
      UNION
      SELECT refs.key, refs."transactionId", refs."chargeKey",
        r.source, ${chargeKeyOf("r")}
      FROM refs JOIN "StatementRow" r ON r.source = refs.source
        AND ${chargeKeyOf("r")} = refs."externalId" AND r."deletedAt" IS NULL
    ),
    -- An ignored or superseded charge was set aside by the member, so it no
    -- longer claims the transaction holding its ref.
    cs AS MATERIALIZED ${chargeStateOf(
      sql`(r.source, ${chargeKeyOf("r")}) IN (SELECT source, "claimKey" FROM hits)`,
    )}
    SELECT DISTINCT hits.key, hits."transactionId"
    FROM hits JOIN cs ON cs.source = hits.source AND cs."chargeKey" = hits."claimKey"
      AND NOT cs.ignored AND NOT cs.superseded
    WHERE hits."claimKey" <> hits.own
  `);
  for (const row of rows) {
    const set = result.get(row.key) ?? new Set<string>();
    set.add(String(row.transactionId));
    result.set(row.key, set);
  }
  return result;
}

/** Every live account, with the names a cash-out or funding descriptor may use. */
async function ownAccounts(db: Database): Promise<OwnAccount[]> {
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    identity: unknown;
    ledgerPartyId: string | null;
    vendorName: string | null;
  }>(sql`
    SELECT fa.id, fa.identity, fa."ledgerPartyId", v.name AS "vendorName"
    FROM "FinancialAccount" fa
    LEFT JOIN "Vendor" v ON v.id = fa."providerVendorId" AND v."deletedAt" IS NULL
    WHERE fa."deletedAt" IS NULL
  `);
  return rows.map((row) => {
    const identity = financialAccountIdentity.parse(row.identity);
    const names = [
      identity.kind === "stored_value" ? identity.provider : null,
      identity.kind === "bank_account" || identity.kind === "other"
        ? identity.institution
        : null,
      row.vendorName,
    ].filter((name): name is string => Boolean(name));
    return {
      id: String(row.id),
      kind: identity.kind,
      names,
      ledgerPartyId:
        row.ledgerPartyId === null ? null : String(row.ledgerPartyId),
    };
  });
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
    -- derived once from the accept Feedback and probed through the
    -- settlement-ref unique index. Ref keys split at the first ':', the
    -- separator suggestionRefKey writes after the source.
    ruled AS MATERIALIZED (
      SELECT DISTINCT fx."entityId" AS id
      FROM "Feedback" f
      JOIN "Assessment" a ON a.id = f."assessmentId"
        AND a.family = ${assessmentFamily.enum.statement_transaction}
        AND (a.judgment->>'clean')::boolean
        AND a.judgment->>'recommended' = ${statementTransactionAction.enum.create}
      JOIN "AssessmentState" s ON s.id = a.id AND s.status = ${suggestionStatus.enum.applied}
        AND (${suggestionField("accountId")})::uuid IN (SELECT account FROM p)
      CROSS JOIN LATERAL jsonb_array_elements_text(s.data->'refs') ref(key)
      JOIN "EntityExternalId" fx ON fx.kind = 'settlement_ref' AND fx."deletedAt" IS NULL
        AND fx.source = split_part(ref.key, ':', 1)
        AND fx."externalId" = substr(ref.key, length(split_part(ref.key, ':', 1)) + 2)
      WHERE f.intent = ${feedbackEvent.shape.intent.unwrap().enum.apply}
        AND f.verdict = ${feedbackVerdict.enum.correct}
        AND f.correction = ${JSON.stringify({ present: false })}::jsonb
    )
    SELECT p.key, array_agg(DISTINCT ft.kind) AS kinds, count(*)::int AS count,
      bool_or(EXISTS (
        SELECT 1 FROM "Expense" e
        WHERE e."bookingTransactionCode" = ft.shortcode AND e."deletedAt" IS NULL
          AND e."economicRole" = ${financialBookingInput.shape.economicRole.unwrap().enum.reimbursement}
      )) AS reimbursed,
      bool_or(EXISTS (
        SELECT 1 FROM "FinancialTransactionAllocation" fta
        JOIN "Purchase" pu ON pu.id = fta."purchaseId" AND pu."deletedAt" IS NULL
          AND pu."vendorId" IS NOT NULL
        WHERE fta."transactionId" = ft.id AND fta."deletedAt" IS NULL
      )) AS purchased
    FROM p
    JOIN "FinancialTransaction" ft ON ft."accountId" = p.account
      AND ft."deletedAt" IS NULL AND ft.status <> ${financialTransactionStatus.enum.void}
      AND ft.merchant IS NOT NULL AND ${merchantKey(sql`ft.merchant`)} = p.merchant
      AND COALESCE(ft."postedDate", ft."transactionDate") < p.day
      AND sign(ft.amount)::int = p.direction
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
  row: { amount: number; status: "posted" | "pending"; date: string },
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
export async function buildChargeProposals(
  db: Database,
  charges: readonly ChargeRef[],
): Promise<ChargeProposal[]> {
  const observations = await loadObservations(db, charges);
  const byCharge = new Map<string, Observation[]>();
  for (const row of observations) {
    const key = chargeId(row);
    byCharge.set(key, [...(byCharge.get(key) ?? []), row]);
  }
  const grouped = charges.flatMap((charge) => {
    const rows = byCharge.get(chargeId(charge));
    return rows?.length && rows[0]!.providerAmount !== 0
      ? [{ charge, observations: rows, canonical: canonicalObservation(rows) }]
      : [];
  });
  if (!grouped.length) return [];
  const { rows: matchedCharges } = await unwrapDb(db).execute<{
    source: string;
    chargeKey: string;
    shortcode: string;
  }>(sql`
    SELECT cs.source, cs."chargeKey", cs.shortcode FROM ${CHARGE_STATE} cs
    WHERE (cs.source, cs."chargeKey") IN (${tuples(charges)}) AND cs.shortcode IS NOT NULL
      AND NOT cs.ignored AND NOT cs.superseded
  `);
  const matchedByCharge = new Map(
    matchedCharges.map((row) => [chargeId(row), row.shortcode]),
  );
  const preview = await previewFinancialStatementImport(
    db,
    {
      rows: grouped.map(({ charge, canonical }) =>
        previewRowFor(charge, canonical),
      ),
    },
    undefined,
    {
      candidatePolicy: "suggestion",
      accountHints: new Map(
        grouped.flatMap(({ charge, observations: rows }) => {
          const stored = rows.find((row) => row.accountId)?.accountId;
          return stored ? [[chargeId(charge), stored] as const] : [];
        }),
      ),
    },
  );
  const previewByKey = new Map(preview.rows.map((row) => [row.key, row]));
  const shortcodes = [
    ...new Set([
      ...matchedCharges.map((row) => row.shortcode),
      ...preview.rows.flatMap((row) => [
        ...row.existingTransactionIds,
        ...(row.accountId ? [row.accountId] : []),
      ]),
    ]),
  ];
  const ids = new Map<string, string>();
  if (shortcodes.length) {
    const { rows } = await unwrapDb(db).execute<{
      id: string;
      shortcode: string;
    }>(sql`
      SELECT id, shortcode FROM "FinancialTransaction" WHERE shortcode IN (${sql.join(
        shortcodes.map((code) => sql`${code}`),
        sql`, `,
      )})
      UNION ALL
      SELECT id, shortcode FROM "FinancialAccount" WHERE shortcode IN (${sql.join(
        shortcodes.map((code) => sql`${code}`),
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
  const [pendingTransactions, siblings, claimed, accounts, history] =
    await Promise.all([
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
      ownAccounts(db),
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
  const pairsByCharge = await findTransferPairsForCharges(db, charges);

  const proposals: ChargeProposal[] = [];
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
    const providerStatus =
      canonical.providerStatus === "pending" ? "pending" : "posted";
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
                  status: providerStatus,
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
      providerStatus === "posted"
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
    const matchedCode = matchedByCharge.get(chargeId(charge));
    const recommended = matchedCode
      ? "book"
      : hold
        ? "supersede"
        : candidates.length
          ? "attach"
          : "create";
    const judgment: StatementTransactionJudgment = {
      recommended,
      accountId,
      statementDate: canonical.statementDate,
      providerStatus,
      create: {
        kind: decision.kind,
        kindSource: decision.kindSource,
        votes: decision.votes,
        counterparty: decision.counterparty,
        status: providerStatus,
        amount: statementAmount,
        transactionDate:
          providerStatus === "pending" ? canonical.statementDate : null,
        postedDate:
          providerStatus === "posted" ? canonical.statementDate : null,
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
    judgment.spending = await prepareStatementSpending(db, judgment);
    if (recommended === "book" && judgment.spending?.status === "deferred")
      continue;
    judgment.clean = isClean(judgment, statementAmount);
    proposals.push(await finishProposal(charge, canonical, rows, judgment));
  }
  return proposals;
}

/** Bulk acceptance never changes an amount or relies on a kind sources dispute. */
export function isClean(
  judgment: StatementTransactionJudgment,
  statementAmount: number,
): boolean {
  if (judgment.siblings.length) return false;
  if (
    judgment.create?.status === "posted" &&
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
): Promise<ChargeProposal> {
  assessmentJudgments.statement_transaction.parse(judgment);
  const fingerprint = await sha256Hex(
    canonicalJson({
      revision: STATEMENT_SUGGESTION_REVISION,
      cleanPolicy: STATEMENT_CLEAN_POLICY,
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
    refs,
  };
}

/** Model labels ride on the evidence fingerprint rather than replacing it. */
export async function labelledProposal(
  proposal: ChargeProposal,
  judgment: StatementTransactionJudgment,
): Promise<ChargeProposal> {
  assessmentJudgments.statement_transaction.parse(judgment);
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
        WHERE ft."deletedAt" IS NULL AND ft.status = ${financialTransactionStatus.enum.pending}
      `)
    ).rows.map((row) => String(row.id));
  const holds = await statementPendingTransactions(db, accounts);
  const proposals: ChargeProposal[] = [];
  for (const hold of holds) {
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
    const charge = { source: canonical.source, chargeKey: canonical.chargeKey };
    proposals.push(
      await finishProposal(charge, canonical, rows, {
        recommended: "void",
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
      }),
    );
  }
  return proposals;
}

async function loadObservationsById(db: Database, rowIds: readonly string[]) {
  if (!rowIds.length) return [];
  const { rows } = await unwrapDb(db).execute<ChargeRef>(sql`
    SELECT DISTINCT r.source, ${chargeKeyOf("r")} AS "chargeKey" FROM "StatementRow" r
    WHERE r.id IN (${sql.join(
      rowIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) AND r."deletedAt" IS NULL
  `);
  const all = await loadObservations(db, rows);
  return all.filter((row) => rowIds.includes(row.id));
}

/** The import proving the hold vanished: newer, same account, past the window, without it. */
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
    SELECT si.id FROM "StatementImport" si
    WHERE si."deletedAt" IS NULL AND si.source = ${input.source}
      AND si."createdAt" > ${input.after}::timestamptz
      AND EXISTS (
        SELECT 1 FROM ${statementImportMembers} m
        JOIN "StatementRow" r ON r.id = m."statementRowId" AND r."deletedAt" IS NULL
        WHERE m."importId" = si.id AND r."accountDescriptor" = ${input.accountDescriptor}
          AND r."statementDate" >= ${input.coveredThrough}::date + ${PENDING_POST_WINDOW_DAYS}::int
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${statementImportMembers} m
        JOIN "StatementRow" held ON held.id = m."statementRowId" AND held."deletedAt" IS NULL
        JOIN "StatementRow" seen ON seen.source = held.source AND seen."deletedAt" IS NULL
          AND ${chargeKeyOf("seen")} = ${chargeKeyOf("held")}
        JOIN ${statementImportMembers} ms ON ms."statementRowId" = seen.id AND ms."importId" = si.id
        WHERE held.id IN (${sql.join(
          input.rowIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      )
    ORDER BY si."createdAt", si.id
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
    SELECT r.amount, r."statementDate" FROM "StatementRow" r
    WHERE r."deletedAt" IS NULL
      AND r."providerStatus" IS DISTINCT FROM ${statementRowProviderStatus.enum.pending}
      AND r."statementDate" BETWEEN ${date}::date - ${PENDING_POST_WINDOW_DAYS}::int
        AND ${date}::date + ${PENDING_POST_WINDOW_DAYS}::int
      AND sign(r.amount) = sign(${hold.amount}::numeric)
      AND r."accountDescriptor" IN (
        SELECT held."accountDescriptor" FROM "StatementRow" held
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

export type PublishOutcome =
  | "published"
  | "unchanged"
  | "suppressed"
  | "settled";

/**
 * Publish one charge's proposal. The charge's current suggestions are locked
 * first, so a member reviewing one serializes with its replacement: a
 * dismissal (suppression) holds forever, an unchanged fingerprint is left
 * alone, and anything else is retired before the new one takes the charge.
 */
export async function publishChargeProposal(
  db: Database,
  proposal: ChargeProposal,
  producer: AssessmentProducer,
): Promise<{ outcome: PublishOutcome; labelsReused: number }> {
  const { charge } = proposal;
  const ruleGeneration = producer.kind === "rule";
  const countLabels = (value: typeof proposal.judgment) =>
    value.candidates.filter((entry) => entry.label !== null).length +
    (value.create
      ? Number(value.create.votes.label !== null) +
        Number(value.create.counterparty.label !== null)
      : 0);
  return withTransactionDatabase(db, async (tx) => {
    let retainedSpendingCheckpoint: StatementLabelCheckpoint | undefined;
    const client = getDb(tx);
    await client.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`statement-suggestion:${chargeId(charge)}`}, 0))`,
    );
    const { rows: stored } = await client.execute<{
      id: string;
      status: string;
      fingerprint: string | null;
      evidenceFingerprint: string | null;
      suppression: unknown;
      active: boolean;
      judgment: unknown;
      producer: unknown;
      needsLabel: string | null;
      checkpoint: unknown;
    }>(sql`
      SELECT s.id, s.status, s.fingerprint, ${suggestionField("evidenceFingerprint")} AS "evidenceFingerprint",
        s.suppression, s.active, a.judgment, a.producer,
        ${suggestionField("needsLabel")} AS "needsLabel", s.data->'labelCheckpoint' AS checkpoint
      FROM "AssessmentState" s JOIN "Assessment" a ON a.id = s.id
      WHERE s.family = ${assessmentFamily.enum.statement_transaction}
        AND ${suggestionField("source")} = ${charge.source}
        AND ${suggestionField("chargeKey")} = ${charge.chargeKey}
      ORDER BY s."createdAt" DESC, s.id DESC
      FOR UPDATE OF s
    `);
    const prior = stored.map((row) => ({
      ...row,
      producer: assessmentProducer.nullable().parse(row.producer),
      checkpoint: statementLabelCheckpoint.nullable().parse(row.checkpoint),
    }));
    if (prior.some((row) => row.suppression !== null))
      return { outcome: "suppressed", labelsReused: 0 };
    // A charge matched, ignored or superseded after it was listed (an accept or
    // an import-page attach in between) needs no suggestion; a ref inserted
    // before publication never reaches the retiring trigger. Holds are the
    // exception: their charge is matched by the hold transaction itself.
    if (proposal.judgment.recommended !== "void") {
      const { rows: settled } = await client.execute(sql`
        SELECT 1 FROM ${chargeStateOf(
          sql`r.source = ${charge.source} AND ${chargeKeyOf("r")} = ${charge.chargeKey}`,
        )} cs
        WHERE cs.ignored OR cs.superseded OR (cs.shortcode IS NOT NULL AND ${proposal.judgment.recommended !== "book"})
      `);
      if (settled.length) return { outcome: "settled", labelsReused: 0 };
    }
    if (
      proposal.judgment.recommended === "book" &&
      proposal.judgment.spending?.status === "already_booked"
    ) {
      const fresh = await prepareStatementSpending(tx, proposal.judgment);
      if (fresh?.status === "already_booked") {
        await client.execute(sql`UPDATE "AssessmentState" SET active=false, status=${suggestionStatus.enum.superseded}, "updatedAt"=now()
          WHERE family=${assessmentFamily.enum.statement_transaction} AND active AND status=${suggestionStatus.enum.pending}
            AND data->>${"source"}=${charge.source} AND data->>${"chargeKey"}=${charge.chargeKey}`);
        return { outcome: "settled", labelsReused: 0 };
      }
    }
    // A rule re-run never displaces labels a model added to the same evidence.
    const unchanged = prior.find(
      (row) =>
        row.active &&
        !(
          producer.kind === "rule" &&
          row.producer?.kind === "model" &&
          row.producer.revision !== STATEMENT_LABEL_REVISION
        ) &&
        (row.fingerprint === proposal.fingerprint ||
          (producer.kind === "rule" &&
            row.evidenceFingerprint === proposal.evidenceFingerprint)),
    );
    if (unchanged)
      return {
        outcome: "unchanged",
        labelsReused:
          ruleGeneration && unchanged.producer?.kind === "model"
            ? countLabels(
                assessmentJudgments.statement_transaction.parse(
                  unchanged.judgment,
                ),
              )
            : 0,
      };
    if (producer.kind === "rule" && proposal.judgment.create) {
      // Retain the paid votes, not their old rule/history conclusions. Evidence
      // still gets a fresh fingerprint and current apply-time validation.
      const inputs = canonicalJson(statementLabelInputs(proposal.judgment));
      const reusable = prior.find((row) => {
        if (
          row.needsLabel !== "false" ||
          row.producer?.kind !== "model" ||
          row.producer.revision !== STATEMENT_LABEL_REVISION ||
          !["pending", "superseded"].includes(row.status)
        )
          return false;
        const previous = assessmentJudgments.statement_transaction.parse(
          row.judgment,
        );
        return canonicalJson(statementLabelInputs(previous)) === inputs;
      });
      if (reusable) {
        const previous = assessmentJudgments.statement_transaction.parse(
          reusable.judgment,
        );
        const previousProducer = reusable.producer;
        if (previous.create && previousProducer?.kind === "model") {
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
          for (const candidate of judgment.candidates)
            candidate.label = previous.candidates.find(
              (entry) => entry.transactionId === candidate.transactionId,
            )!.label;
          judgment.spending = await prepareStatementSpending(
            tx,
            judgment,
            previous.spending?.request.advice ?? null,
          );
          judgment.clean = isClean(judgment, proposal.canonical.amount);
          proposal = await labelledProposal(proposal, judgment);
          if (
            judgment.spending?.status === "deferred" ||
            previous.spending?.request.advice
          )
            producer = previousProducer;
          else
            retainedSpendingCheckpoint = statementLabelCheckpoint.parse({
              revision: STATEMENT_LABEL_REVISION,
              model: previousProducer.model,
              judgment,
              kind: true,
              counterparty: true,
              spending: false,
            });
        }
      }
    }
    const retire = prior.filter((row) => row.active).map((row) => row.id);
    if (retire.length)
      await client.execute(sql`
        UPDATE "AssessmentState"
        SET active = false,
          status = CASE WHEN status = ${suggestionStatus.enum.pending} THEN ${suggestionStatus.enum.superseded} ELSE status END,
          "updatedAt" = now()
        WHERE id IN (${sql.join(
          retire.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      `);
    const { judgment } = proposal;
    const checkpoint =
      retainedSpendingCheckpoint ??
      (producer.kind === "rule"
        ? prior
            .flatMap((row) => (row.checkpoint ? [row.checkpoint] : []))
            .find(
              (saved) =>
                saved.revision === STATEMENT_LABEL_REVISION &&
                canonicalJson(statementLabelSubject(saved.judgment)) ===
                  canonicalJson(statementLabelSubject(judgment)),
            )
        : undefined);
    const published = await publishAssessment(
      tx,
      {
        publicationKey: `statement_transaction:${chargeId(charge)}:${proposal.fingerprint}:${prior.length}`,
        family: "statement_transaction",
        subject: {
          kind: "statement_transaction",
          entity: "statementRow",
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
      {
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
          clean: judgment.clean,
          refs: proposal.refs,
          evidenceFingerprint: proposal.evidenceFingerprint,
          // Rule output awaits the decision model's labels: candidate
          // identity, and the kind and counterparty of every create.
          needsLabel: producer.kind === "rule" && judgment.create !== null,
          ...(checkpoint && { labelCheckpoint: checkpoint }),
          ...(await automaticRuleStamp(
            "statement_transaction",
            matchStatementRules(judgment),
            statementSubjectKey(charge),
          )),
        },
      },
    );
    // A ref writer holds evidence keys, not this charge's lock: one that
    // committed between the settled check and this commit has a trigger that
    // could not see the new row. Recheck once both are committed.
    if (judgment.recommended !== "void")
      await runAfterCommit(tx, (committed) =>
        getDb(committed)
          .execute(
            sql`UPDATE "AssessmentState" SET active = false, status = ${suggestionStatus.enum.superseded}, "updatedAt" = now()
            WHERE id = ${published.id}::uuid AND status = ${suggestionStatus.enum.pending}
              AND EXISTS (
                SELECT 1 FROM ${chargeStateOf(
                  sql`r.source = ${charge.source} AND ${chargeKeyOf("r")} = ${charge.chargeKey}`,
                )} cs
                WHERE cs.ignored OR cs.superseded OR (cs.shortcode IS NOT NULL AND ${judgment.recommended !== "book"})
              )`,
          )
          .then(() => undefined),
      );
    return {
      outcome: "published",
      labelsReused:
        ruleGeneration && producer.kind === "model" ? countLabels(judgment) : 0,
    };
  });
}

const ruleProducer = (runId: string | null): AssessmentProducer => ({
  kind: "rule",
  model: null,
  revision: STATEMENT_SUGGESTION_REVISION,
  runId,
  evaluationId: null,
});

/** Recompute and publish named charges, e.g. the siblings of an applied one. */
export async function regenerateCharges(
  db: Database,
  charges: readonly ChargeRef[],
) {
  for (const proposal of await buildChargeProposals(db, charges))
    await publishChargeProposal(db, proposal, ruleProducer(null));
}

/** One generation page: deterministic, safe to repeat, resumable at `next`. */
export async function generateStatementSuggestionPage(
  db: Database,
  input: {
    after: ChargeRef | null;
    runId: string | null;
    limit?: number;
    scope?: StatementSuggestionScope;
  },
): Promise<{
  published: number;
  processed: number;
  labelsReused: number;
  unchanged: number;
  /** Charges read but resolved to an account outside the scope. */
  outOfScope: number;
  next: ChargeRef | null;
}> {
  const limit = input.limit ?? STATEMENT_SUGGESTION_PAGE;
  const charges = await nextUnmatchedCharges(db, {
    after: input.after,
    limit,
    scope: input.scope ?? {},
  });
  let published = 0;
  let labelsReused = 0;
  let unchanged = 0;
  const accountIds = input.scope?.accountIds;
  const built = await buildChargeProposals(db, charges);
  const proposals = accountIds?.length
    ? built.filter((proposal) =>
        accountIds.includes(proposal.judgment.accountId),
      )
    : built;
  const outOfScope = built.length - proposals.length;
  // The final page also judges vanished holds, whose charges are matched.
  if (charges.length < limit)
    proposals.push(...(await buildHoldVoidProposals(db)));
  // Publish independent charges first; import applications then recheck the
  // current ledger sequentially, including reused labels on unchanged imports.
  await forEachConcurrently(
    proposals,
    STATEMENT_PUBLISH_CONCURRENCY,
    async (proposal) => {
      const outcome = await publishChargeProposal(
        db,
        proposal,
        ruleProducer(input.runId),
      );
      labelsReused += outcome.labelsReused;
      if (outcome.outcome === "published") published++;
      else unchanged++;
    },
  );
  if (input.scope?.importId) {
    const { applyAutomaticRulesForCharge } =
      await import("~/server/generic/assessment/repo/automatic-rule-runtime");
    for (const proposal of proposals) {
      await regenerateCharges(db, [proposal.charge]);
      await applyAutomaticRulesForCharge(db, proposal.charge, true);
    }
  }
  return {
    published,
    processed: charges.length,
    labelsReused,
    unchanged,
    outOfScope,
    next: charges.length === limit ? charges.at(-1)! : null,
  };
}

/** A label pass's position in `(createdAt, id)` order. */
export type LabelCursor = {
  createdAt: string;
  id: string;
  inclusive?: boolean;
};

/** A partial judgment is unpublished work, not a new advisory assessment. */
export async function recordStatementLabelCheckpoint(
  db: Database,
  input: {
    charge: ChargeRef;
    evidenceFingerprint: string;
    checkpoint: StatementLabelCheckpoint;
  },
): Promise<"saved" | "settled" | "moved"> {
  const checkpoint = statementLabelCheckpoint.parse(input.checkpoint);
  const { rows } = await unwrapDb(db).execute<{ id: string }>(sql`
    UPDATE "AssessmentState" s
    SET data = jsonb_set(coalesce(s.data, '{}'::jsonb), '{labelCheckpoint}', ${JSON.stringify(checkpoint)}::jsonb),
      "updatedAt" = now()
    WHERE ${pendingSuggestion()}
      AND ${suggestionField("source")} = ${input.charge.source}
      AND ${suggestionField("chargeKey")} = ${input.charge.chargeKey}
      AND ${suggestionField("evidenceFingerprint")} = ${input.evidenceFingerprint}
    RETURNING s.id
  `);
  if (rows.length) return "saved";
  const { rows: settled } = await unwrapDb(db).execute(sql`
    SELECT 1 FROM "AssessmentState" s
    WHERE s.family = ${assessmentFamily.enum.statement_transaction}
      AND ${suggestionField("source")} = ${input.charge.source}
      AND ${suggestionField("chargeKey")} = ${input.charge.chargeKey}
      AND s.suppression IS NOT NULL
    UNION ALL
    SELECT 1 FROM ${chargeStateOf(sql`r.source = ${input.charge.source} AND ${chargeKeyOf("r")} = ${input.charge.chargeKey}`)} cs
    WHERE ${checkpoint.judgment.recommended !== statementTransactionAction.enum.void}
      AND (cs.ignored OR cs.superseded OR (cs.shortcode IS NOT NULL AND ${checkpoint.judgment.recommended !== "book"}))
    LIMIT 1
  `);
  return settled.length ? "settled" : "moved";
}

/**
 * Pending rule suggestions awaiting decision-model labels after the cursor.
 * A stale row is paged past rather than ending the pass; regeneration
 * republishes it under a later position.
 */
export async function suggestionsNeedingLabels(
  db: Database,
  limit: number,
  after: LabelCursor | null = null,
  importId: string | null = null,
) {
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    createdAt: string;
    subject: unknown;
    evidenceFingerprint: string;
    checkpoint: unknown;
  }>(sql`
    SELECT s.id, to_char(s."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "createdAt",
      a.subject, ${suggestionField("evidenceFingerprint")} AS "evidenceFingerprint",
      s.data->'labelCheckpoint' AS checkpoint
    FROM "AssessmentState" s JOIN "Assessment" a ON a.id = s.id
    WHERE ${pendingSuggestion()} AND (${suggestionField("needsLabel")})::boolean
      ${importScope(importId)}
      ${after ? sql`AND (s."createdAt", s.id) ${after.inclusive ? sql`>=` : sql`>`} (${after.createdAt}::timestamp, ${after.id}::uuid)` : sql``}
    ORDER BY s."createdAt", s.id
    LIMIT ${limit}
  `);
  return rows.map((row) => ({
    ...row,
    checkpoint: statementLabelCheckpoint.nullable().parse(row.checkpoint),
  }));
}

/**
 * An import-scoped pass labels only the charges that import observed, so
 * concurrent import Sweeps never ask the model about the same suggestions.
 */
const importScope = (importId: string | null) =>
  importId
    ? sql`AND (${suggestionField("source")}, ${suggestionField("chargeKey")}) IN (
        SELECT seen.source, ${chargeKeyOf("seen")} FROM "StatementRow" seen
        WHERE seen."deletedAt" IS NULL AND seen.id IN (
          SELECT m."statementRowId" FROM ${statementImportMembers} m WHERE m."importId" = ${importId}::uuid))`
    : sql``;

/** How many pending suggestions still need labels, for a Sweep's count. */
export async function countSuggestionsNeedingLabels(
  db: Database,
  importId: string | null = null,
) {
  const { rows } = await unwrapDb(db).execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM "AssessmentState" s
    WHERE ${pendingSuggestion()} AND (${suggestionField("needsLabel")})::boolean
      ${importScope(importId)}
  `);
  return rows[0]?.count ?? 0;
}
