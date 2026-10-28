import { assessmentFamily } from "@cubby/schemas/assessment";
import type { FinancialSpendingPlan } from "@cubby/schemas/financial-booking";
import { financialTransactionKind } from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  statementSuggestionOut,
  statementTransactionAction,
  statementTransactionJudgment,
  type StatementSuggestionOut,
} from "@cubby/schemas/statement-suggestion";
import { sql, type SQL } from "drizzle-orm";

import type { Database } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  pendingSuggestion,
  suggestionField,
  chargeKeyOf,
  chargeStateOf,
  LIVE_REFS,
} from "~/server/domains/transaction-import/repo/statement-charge";
import {
  automaticApplicationRule,
  matchedRulesOf,
} from "~/server/generic/assessment/repo/assessment";
import { reviewFamilyDeclarations } from "~/server/generic/assessment/repo/review-families";

import { isClean } from "./statement-suggestions";

const currentClean = sql`coalesce((coalesce((${suggestionField("clean")})::boolean, false) AND (
  a.judgment->${"create"}->>${"kind"} NOT IN (${financialTransactionKind.enum.purchase}, ${financialTransactionKind.enum.refund}, ${financialTransactionKind.enum.fee})
  OR a.judgment->${"spending"}->>${"status"} IN (${"ready" satisfies FinancialSpendingPlan["status"]}, ${"already_booked" satisfies FinancialSpendingPlan["status"]}))), false)`;

/** Record-level scope the cross-family list pushes into SQL. */
export type StatementSuggestionScope = {
  assessmentIds?: readonly string[];
  /** FinancialAccount or candidate/hold FinancialTransaction ids. */
  recordUuids?: readonly string[];
  runCode?: string;
  /** Pending by default; `applied` lists reviewed history. */
  status?: "pending" | "applied";
};

const inStatus = (status: StatementSuggestionScope["status"]) =>
  status === "applied"
    ? sql`s.family = ${assessmentFamily.enum.statement_transaction} AND s.status = ${status}`
    : pendingSuggestion();

const conditions = (filters: StatementSuggestionScope): SQL => {
  const where: SQL[] = [inStatus(filters.status)];
  if (filters.assessmentIds)
    where.push(sql`s.id = ANY(${uuidArrayParam(filters.assessmentIds)})`);
  if (filters.runCode)
    where.push(
      sql`s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${filters.runCode})`,
    );
  if (filters.recordUuids) {
    const ids = sql.join(
      filters.recordUuids.map((id) => sql`${id}`),
      sql`, `,
    );
    where.push(sql`(fa.id::text IN (${ids})
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(a.judgment->'candidates') candidate WHERE candidate->>'transactionId' IN (${ids}))
      OR a.judgment->${"supersede"}->>'pendingTransactionId' IN (${ids})
      OR a.judgment->${"void"}->>'transactionId' IN (${ids})
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(${reviewFamilyDeclarations.statement_transaction.records}) ref WHERE ref->>'id' IN (${ids})))`);
  }
  return sql.join(where, sql` AND `);
};

const FROM = sql`FROM "AssessmentState" s
  JOIN "Assessment" a ON a.id = s.id
  JOIN "FinancialAccount" fa ON fa.id = (${suggestionField("accountId")})::uuid AND ${notDeleted("fa")}
  LEFT JOIN "LedgerParty" account_owner ON account_owner.id = fa."ledgerPartyId"
  JOIN "SourceTransactionRecord" r ON r.id = s."recordId"`;

// Counts and list keys use the same first surviving candidate as hydration.
const FIRST_CANDIDATE = sql`LEFT JOIN LATERAL (
      SELECT candidate->${"label"} AS label, ft.shortcode
      FROM jsonb_array_elements(a.judgment->'candidates') WITH ORDINALITY AS c(candidate, position)
      JOIN "FinancialTransaction" ft ON ft.id = (candidate->>'transactionId')::uuid
      ORDER BY position LIMIT 1
    ) first_candidate ON true`;

/** Only facts used by unfiltered pending counts; no list-column hydration. */
export async function statementSuggestionCountFacts(
  db: Database,
  filters: StatementSuggestionScope,
) {
  const { rows } = await unwrapDb(db).execute<{
    recommended: string;
    automatic: boolean;
    clean: boolean;
    labelSame: string | null;
    labelConfidence: string | null;
    count: number;
  }>(sql`
    -- Evaluate eligibility and correlated facts once before aggregation.
    WITH facts AS MATERIALIZED (
      SELECT ${suggestionField("recommended")} AS recommended, (${currentClean}) AS clean,
        first_candidate.label->>${"same"} AS "labelSame",
        first_candidate.label->>${"confidence"} AS "labelConfidence",
        ${automaticApplicationRule(sql`s.id`)} AS "automaticRule"
      ${FROM}
      ${FIRST_CANDIDATE}
      WHERE ${conditions(filters)}
    )
    SELECT recommended, clean, "labelSame", "labelConfidence",
      ("automaticRule" IS NOT NULL) AS automatic, count(*)::int AS count
    FROM facts
    GROUP BY recommended, clean, "labelSame", "labelConfidence", ("automaticRule" IS NOT NULL)
  `);
  // Keys validate every eligible action before excluding automatic applications.
  for (const row of rows) statementTransactionAction.parse(row.recommended);
  return rows.filter((row) => !row.automatic);
}

/** Every pending suggestion in scope with its list columns, before hydration. */
export async function statementSuggestionKeys(
  db: Database,
  filters: StatementSuggestionScope,
) {
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    fingerprint: string | null;
    clean: boolean;
    recommended: string;
    reviewReason: string | null;
    labelSame: string | null;
    labelConfidence: string | null;
    createdAt: Date | string;
    statementDate: string;
    accountCode: string;
    ownerCode: string | null;
    merchant: string | null;
    rawDescription: string;
    amount: string | null;
    kind: string | null;
    kindSource: string | null;
    sourceCategory: string | null;
    providerStatus: string;
    candidateCode: string | null;
    matchedRules: string[];
    automaticRule: string | null;
  }>(sql`
    SELECT s.id, s.fingerprint, (${currentClean}) AS clean,
      ${suggestionField("recommended")} AS recommended,
      a.judgment->>${"reviewReason"} AS "reviewReason",
      first_candidate.label->>${"same"} AS "labelSame",
      first_candidate.label->>${"confidence"} AS "labelConfidence",
      a."createdAt", a.judgment->>'statementDate' AS "statementDate",
      fa.shortcode AS "accountCode", account_owner.shortcode AS "ownerCode",
      r.merchant, r."rawDescription", ${suggestionField("amount")} AS amount,
      a.judgment->${"create"}->>${"kind"} AS kind,
      a.judgment->${"create"}->>${"kindSource"} AS "kindSource",
      r."sourceCategory", a.judgment->>'providerStatus' AS "providerStatus",
      first_candidate.shortcode AS "candidateCode",
      ${matchedRulesOf(sql`s.data`)} AS "matchedRules",
      ${automaticApplicationRule(sql`s.id`)} AS "automaticRule"
    ${FROM}
    ${FIRST_CANDIDATE}
    WHERE ${conditions(filters)}
  `);
  return rows.map((row) => ({
    ...row,
    recommended: statementTransactionAction.parse(row.recommended),
    amount: row.amount === null ? 0 : Number(row.amount),
    createdAt: new Date(row.createdAt),
  }));
}

/** Public rows for the given suggestions still in `status`, in no particular order. */
export async function readStatementSuggestions(
  db: Database,
  ids: readonly string[],
  status: StatementSuggestionScope["status"] = "pending",
): Promise<StatementSuggestionOut[]> {
  if (!ids.length) return [];
  const page = await unwrapDb(db).execute<{
    id: string;
    fingerprint: string | null;
    data: { source: string; chargeKey: string };
    judgment: unknown;
    model: string;
    createdAt: Date | string;
    accountCode: string;
    ownerCode: string | null;
    merchant: string | null;
    rawDescription: string;
    sourceCategory: string | null;
  }>(sql`
    SELECT s.id, s.fingerprint, s.data, a.judgment, s.model, a."createdAt",
      fa.shortcode AS "accountCode", account_owner.shortcode AS "ownerCode",
      r.merchant, r."rawDescription", r."sourceCategory"
    ${FROM}
    WHERE ${inStatus(status)} AND s.id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `);
  const judgments = page.rows.map((row) =>
    statementTransactionJudgment.parse(row.judgment),
  );
  const { rows: categoryEvidence } = await unwrapDb(db).execute<{
    id: string;
    source: string;
    sourceCategory: string | null;
  }>(sql`
    WITH roots AS (
      SELECT s.id, s.data->>${"source"} AS source, s.data->>'chargeKey' AS "chargeKey"
      FROM "AssessmentState" s WHERE s.id = ANY(${uuidArrayParam(page.rows.map((row) => row.id))})
    ), matched AS (
      SELECT roots.id, cs.shortcode FROM roots
      JOIN ${chargeStateOf(sql`(r.source, ${chargeKeyOf("r")}) IN (SELECT source, "chargeKey" FROM roots)`)} cs
        ON cs.source = roots.source AND cs."chargeKey" = roots."chargeKey"
      WHERE cs.shortcode IS NOT NULL
    ), members AS (
      SELECT id, source, "chargeKey" FROM roots
      UNION
      SELECT matched.id, observed.source, ${chargeKeyOf("observed")} AS "chargeKey"
      FROM matched JOIN ${LIVE_REFS} refs ON refs.shortcode = matched.shortcode
      JOIN "SourceTransactionRecord" observed ON observed.source = refs.source
        AND (observed."externalId" = refs."externalId" OR observed."legacyReference" = refs."externalId")
        AND ${notDeleted("observed")}
    )
    SELECT DISTINCT members.id, r.source, r."sourceCategory"
    FROM members JOIN "SourceTransactionRecord" r
      ON r.source = members.source AND ${chargeKeyOf("r")} = members."chargeKey"
    WHERE ${notDeleted("r")}
    ORDER BY members.id, r.source, r."sourceCategory" NULLS FIRST
  `);
  const categories = new Map<
    string,
    StatementSuggestionOut["sourceCategories"]
  >();
  for (const { id, source, sourceCategory } of categoryEvidence) {
    const entries = categories.get(id) ?? [];
    entries.push({ source, sourceCategory });
    categories.set(id, entries);
  }
  const transactionIds = [
    ...new Set(
      judgments.flatMap((judgment) => [
        ...judgment.candidates.map((candidate) => candidate.transactionId),
        ...(judgment.supersede
          ? [judgment.supersede.pendingTransactionId]
          : []),
        ...(judgment.void ? [judgment.void.transactionId] : []),
        ...(judgment.matchedTransactionId
          ? [judgment.matchedTransactionId]
          : []),
      ]),
    ),
  ];
  const codes = new Map<string, string>();
  if (transactionIds.length) {
    const { rows } = await unwrapDb(db).execute<{
      id: string;
      shortcode: string;
    }>(sql`
      SELECT id, shortcode FROM "FinancialTransaction"
      WHERE id IN (${sql.join(
        transactionIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    `);
    for (const row of rows) codes.set(String(row.id), row.shortcode);
  }
  const code = (id: string) =>
    parseShortcodeFor("financialTransaction", codes.get(id)!);
  const transferAccountIds = [
    ...new Set(
      judgments.flatMap((judgment) =>
        judgment.transfer?.accountId ? [judgment.transfer.accountId] : [],
      ),
    ),
  ];
  const accountCodes = new Map<string, string>();
  if (transferAccountIds.length) {
    const { rows } = await unwrapDb(db).execute<{
      id: string;
      shortcode: string;
    }>(sql`
      SELECT id, shortcode FROM "FinancialAccount"
      WHERE ${notDeleted("FinancialAccount")} AND id IN (${sql.join(
        transferAccountIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    `);
    for (const row of rows) accountCodes.set(String(row.id), row.shortcode);
  }
  return page.rows.map((row, index) => {
    const judgment = judgments[index]!;
    // A candidate deleted since publication drops out; the trigger-free
    // read never names a transaction that no longer exists.
    const candidates = judgment.candidates.filter((candidate) =>
      codes.has(candidate.transactionId),
    );
    const { sourceRef: _ref, ...create } = judgment.create ?? {
      sourceRef: null,
    };
    return statementSuggestionOut.parse({
      assessmentId: row.id,
      fingerprint: row.fingerprint,
      source: row.data.source,
      chargeKey: row.data.chargeKey,
      accountId: row.accountCode,
      ownerId: row.ownerCode,
      statementDate: judgment.statementDate,
      amount: judgment.create?.amount ?? 0,
      merchant: row.merchant,
      rawDescription: row.rawDescription,
      sourceCategory: row.sourceCategory,
      sourceCategories: categories.get(row.id) ?? [],
      providerStatus: judgment.providerStatus,
      recommended: judgment.recommended,
      reviewReason: judgment.reviewReason,
      clean: isClean(judgment, judgment.create?.amount ?? 0),
      spending: judgment.spending,
      matchedTransactionId:
        judgment.matchedTransactionId && code(judgment.matchedTransactionId),
      transferPair: judgment.transferPair,
      create: judgment.create ? create : null,
      candidates: candidates.map((candidate) => ({
        ...candidate,
        transactionId: code(candidate.transactionId),
      })),
      supersedeTransactionId:
        judgment.supersede && codes.has(judgment.supersede.pendingTransactionId)
          ? code(judgment.supersede.pendingTransactionId)
          : null,
      voidTransactionId:
        judgment.void && codes.has(judgment.void.transactionId)
          ? code(judgment.void.transactionId)
          : null,
      transfer: judgment.transfer && {
        ledgerTransfer: judgment.transfer.ledgerTransfer,
        // An account deleted since publication names no account.
        accountId: accountCodes.has(judgment.transfer.accountId ?? "")
          ? parseShortcodeFor(
              "financialAccount",
              accountCodes.get(judgment.transfer.accountId!)!,
            )
          : null,
      },
      siblings: judgment.siblings.length,
      model: row.model === "rule" ? null : row.model,
      createdAt: new Date(row.createdAt).toISOString(),
    });
  });
}

/** Statement outcome counts by AssessmentState status, optionally for one Run. */
export async function statementSuggestionStatusCounts(
  db: Database,
  runCode?: string,
) {
  const { rows } = await unwrapDb(db).execute<{
    status: string;
    count: number;
  }>(sql`
    SELECT s.status, count(*)::int AS count FROM "AssessmentState" s
    WHERE s.family = ${assessmentFamily.enum.statement_transaction}
      ${runCode ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${runCode})` : sql``}
    GROUP BY s.status
  `);
  return rows;
}
