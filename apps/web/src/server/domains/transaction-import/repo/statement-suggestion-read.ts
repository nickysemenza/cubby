import { suggestionStatus } from "@cubby/schemas/ai";
import type { FinancialSpendingPlan } from "@cubby/schemas/financial-booking";
import { financialTransactionKind } from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  statementSuggestionOut,
  statementTransactionAction,
  statementTransactionJudgment,
  type StatementSuggestionOut,
} from "@cubby/schemas/statement-suggestion";
import { suggestionFamily } from "@cubby/schemas/suggestion";
import { sql, type SQL } from "drizzle-orm";

import type { Database } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { sourceObservations } from "~/server/domains/transaction-import/repo/source-observation-state";
import {
  SOURCE_HELD_REASON,
  statementSuggestionSourceHeld,
} from "~/server/domains/transaction-import/repo/source-observation-state";
import {
  pendingSuggestion,
  sourceSuggestionAutomaticEligible,
  suggestionField,
  chargeKeyOf,
  chargeStateOf,
  LIVE_REFS,
} from "~/server/domains/transaction-import/repo/statement-charge";
import { reviewFamilyDeclarations } from "~/server/generic/suggestions/repo/review-families";
import {
  automaticApplicationRule,
  matchedRulesOf,
} from "~/server/generic/suggestions/repo/suggestion";

import { isClean } from "./statement-suggestions";

const currentClean = sql`${sourceSuggestionAutomaticEligible()} AND coalesce((coalesce((${suggestionField("clean")})::boolean, false) AND (
  s.judgment->${"create"}->>${"kind"} NOT IN (${financialTransactionKind.enum.purchase}, ${financialTransactionKind.enum.refund}, ${financialTransactionKind.enum.fee})
  OR s.judgment->${"spending"}->>${"status"} IN (${"ready" satisfies FinancialSpendingPlan["status"]}, ${"already_booked" satisfies FinancialSpendingPlan["status"]}))), false)`;

/** Record-level scope the cross-family list pushes into SQL. */
export type StatementSuggestionScope = {
  suggestionIds?: readonly string[];
  /** FinancialAccount or candidate/hold FinancialTransaction ids. */
  recordUuids?: readonly string[];
  runCode?: string;
  /** Pending by default; `applied` lists reviewed history. */
  status?: "pending" | "applied";
};

const inStatus = (status: StatementSuggestionScope["status"]) =>
  status === "applied"
    ? sql`s.family = ${suggestionFamily.enum.statement_transaction} AND s.status = ${status}`
    : pendingSuggestion();

const conditions = (filters: StatementSuggestionScope): SQL => {
  const where: SQL[] = [inStatus(filters.status)];
  if (filters.suggestionIds)
    where.push(sql`s.id = ANY(${uuidArrayParam(filters.suggestionIds)})`);
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
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(s.judgment->'candidates') candidate WHERE candidate->>'transactionId' IN (${ids}))
      OR s.judgment->${"supersede"}->>'pendingTransactionId' IN (${ids})
      OR s.judgment->${"void"}->>'transactionId' IN (${ids})
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(${reviewFamilyDeclarations.statement_transaction.records}) ref WHERE ref->>'id' IN (${ids})))`);
  }
  return sql.join(where, sql` AND `);
};

const FROM = sql`FROM "Suggestion" s
  JOIN "FinancialAccount" fa ON fa.id = (${suggestionField("accountId")})::uuid AND ${notDeleted("fa")}
  LEFT JOIN "LedgerParty" account_owner ON account_owner.id = fa."ledgerPartyId"
  JOIN ${sourceObservations} r ON r.id = s."recordId"`;

// List keys use the same first surviving candidate as hydration.
const FIRST_CANDIDATE = sql`LEFT JOIN LATERAL (
      SELECT candidate->${"label"} AS label, ft.shortcode
      FROM jsonb_array_elements(s.judgment->'candidates') WITH ORDINALITY AS c(candidate, position)
      JOIN "FinancialTransaction" ft ON ft.id = (candidate->>'transactionId')::uuid
      ORDER BY position LIMIT 1
    ) first_candidate ON true`;

/**
 * Browse columns over Suggestion. The source record and the account are joined only when a filter or sort reads them, and current
 * evidence is rechecked for page rows rather than for the whole family.
 */
export function statementSuggestionFacts(
  filters: StatementSuggestionScope,
  needs: ReadonlySet<string>,
) {
  const has = (...names: string[]) => names.some((name) => needs.has(name));
  const firstCandidate = has("candidate", "modelLabel");
  const stateFilters: SQL[] = [
    filters.status === "applied"
      ? sql`s.family = ${suggestionFamily.enum.statement_transaction} AND s.status = ${filters.status}`
      : sql`s.family = ${suggestionFamily.enum.statement_transaction} AND s.active AND s.status = ${suggestionStatus.enum.pending}`,
  ];
  if (filters.suggestionIds)
    stateFilters.push(
      sql`s.id = ANY(${uuidArrayParam(filters.suggestionIds)})`,
    );
  if (filters.runCode)
    stateFilters.push(
      sql`s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${filters.runCode})`,
    );
  const clean = sql`CASE WHEN (${suggestionField("clean")})::boolean
    THEN ${currentClean}
    ELSE false END`;
  const firstLabel = sql`s.judgment#>'{candidates,0,label}'`;
  const labelSame = sql`${firstLabel}->>${"same"}`;
  const labelConfidence = sql`${firstLabel}->>${"confidence"}`;
  const strength = sql`CASE WHEN ${clean} OR (${labelSame} = ${"same"} AND ${labelConfidence} = ${"high"}) THEN ${"strong"}
    WHEN ${labelConfidence} = ${"medium"} THEN ${"medium"} ELSE ${"weak"} END`;
  const statementDate = suggestionField("statementDate");
  return {
    columns: {
      clean,
      strength,
      createdAt: sql`to_char(s."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      date: statementDate,
      month: sql`left(${statementDate}, 7)`,
      account: sql`ARRAY[fa.shortcode]`,
      owner: sql`array_remove(ARRAY[account_owner.shortcode], NULL)`,
      merchant: sql`ARRAY[concat_ws(' ', r.merchant, r."rawDescription")]`,
      amount: sql`coalesce((${suggestionField("amount")})::numeric, 0)`,
      action: suggestionField("recommended"),
      kind: sql`s.judgment->${"create"}->>${"kind"}`,
      kindSource: sql`s.judgment->${"create"}->>${"kindSource"}`,
      providerCategory: sql`r."sourceCategory"`,
      providerStatus: sql`s.judgment->>'providerStatus'`,
      candidate: sql`first_candidate.shortcode`,
      modelLabel: sql`first_candidate.label->>${"same"} || ':' || first_candidate.label->>${"confidence"}`,
    } satisfies Record<string, SQL>,
    from: sql.join(
      [
        sql`"Suggestion" s`,
        ...(has("account", "owner")
          ? [
              sql`JOIN "FinancialAccount" fa ON fa.id = (${suggestionField("accountId")})::uuid AND ${notDeleted("fa")}`,
              sql`LEFT JOIN "LedgerParty" account_owner ON account_owner.id = fa."ledgerPartyId"`,
            ]
          : []),
        ...(has("merchant", "providerCategory")
          ? [sql`JOIN ${sourceObservations} r ON r.id = s."recordId"`]
          : []),
        ...(firstCandidate ? [FIRST_CANDIDATE] : []),
      ],
      sql` `,
    ),
    where: sql.join(stateFilters, sql` AND `),
  };
}

/** Listed suggestions by id with their columns, before hydration. */
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
      s.judgment->>${"reviewReason"} AS "reviewReason",
      first_candidate.label->>${"same"} AS "labelSame",
      first_candidate.label->>${"confidence"} AS "labelConfidence",
      s."createdAt", s.judgment->>'statementDate' AS "statementDate",
      fa.shortcode AS "accountCode", account_owner.shortcode AS "ownerCode",
      r.merchant, r."rawDescription", ${suggestionField("amount")} AS amount,
      s.judgment->${"create"}->>${"kind"} AS kind,
      s.judgment->${"create"}->>${"kindSource"} AS "kindSource",
      r."sourceCategory", s.judgment->>'providerStatus' AS "providerStatus",
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
    sourceHeld: boolean;
  }>(sql`
    SELECT s.id, s.fingerprint, s.data, s.judgment, s.model, s."createdAt",
      ${statementSuggestionSourceHeld("s")} AS "sourceHeld",
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
      FROM "Suggestion" s WHERE s.id = ANY(${uuidArrayParam(page.rows.map((row) => row.id))})
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
      JOIN ${sourceObservations} observed ON observed.source = refs.source
        AND observed."chargeKey" = refs."externalId"
        AND ${notDeleted("observed")}
    )
    SELECT DISTINCT members.id, r.source, r."sourceCategory"
    FROM members JOIN ${sourceObservations} r
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
      suggestionId: row.id,
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
      reviewReason: row.sourceHeld ? SOURCE_HELD_REASON : judgment.reviewReason,
      clean: !row.sourceHeld && isClean(judgment, judgment.create?.amount ?? 0),
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

/** Statement outcome counts by Suggestion status, optionally for one Run. */
export async function statementSuggestionStatusCounts(
  db: Database,
  runCode?: string,
) {
  const { rows } = await unwrapDb(db).execute<{
    status: string;
    count: number;
  }>(sql`
    SELECT s.status, count(*)::int AS count FROM "Suggestion" s
    WHERE s.family = ${suggestionFamily.enum.statement_transaction}
      ${runCode ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${runCode})` : sql``}
    GROUP BY s.status
  `);
  return rows;
}
