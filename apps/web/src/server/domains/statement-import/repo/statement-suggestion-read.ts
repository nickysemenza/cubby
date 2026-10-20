import { assessmentFamily } from "@cubby/schemas/assessment";
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
import {
  pendingSuggestion,
  suggestionField,
} from "~/server/domains/statement-import/repo/statement-charge";
import {
  automaticApplicationRule,
  matchedRulesOf,
} from "~/server/generic/assessment/repo/assessment";

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
      OR a.judgment->${"void"}->>'transactionId' IN (${ids}))`);
  }
  return sql.join(where, sql` AND `);
};

const FROM = sql`FROM "AssessmentState" s
  JOIN "Assessment" a ON a.id = s.id
  JOIN "FinancialAccount" fa ON fa.id = (${suggestionField("accountId")})::uuid AND fa."deletedAt" IS NULL
  LEFT JOIN "LedgerParty" account_owner ON account_owner.id = fa."ledgerPartyId"
  JOIN "StatementRow" r ON r.id = s."recordId"`;

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
    SELECT s.id, s.fingerprint, (${suggestionField("clean")})::boolean AS clean,
      ${suggestionField("recommended")} AS recommended,
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
    -- The first candidate that still exists, as hydration shows it.
    LEFT JOIN LATERAL (
      SELECT candidate->${"label"} AS label, ft.shortcode
      FROM jsonb_array_elements(a.judgment->'candidates') WITH ORDINALITY AS c(candidate, position)
      JOIN "FinancialTransaction" ft ON ft.id = (candidate->>'transactionId')::uuid
      ORDER BY position LIMIT 1
    ) first_candidate ON true
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
  const transactionIds = [
    ...new Set(
      judgments.flatMap((judgment) => [
        ...judgment.candidates.map((candidate) => candidate.transactionId),
        ...(judgment.supersede
          ? [judgment.supersede.pendingTransactionId]
          : []),
        ...(judgment.void ? [judgment.void.transactionId] : []),
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
      WHERE "deletedAt" IS NULL AND id IN (${sql.join(
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
      providerStatus: judgment.providerStatus,
      recommended: judgment.recommended,
      clean: judgment.clean,
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
