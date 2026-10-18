import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  statementSuggestionOut,
  statementTransactionAction,
  statementTransactionJudgment,
  type StatementSuggestionFilters,
  type StatementSuggestionOut,
} from "@cubby/schemas/statement-suggestion";
import { sql, type SQL } from "drizzle-orm";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import {
  pendingSuggestion,
  suggestionField,
} from "~/server/domains/statement-import/repo/statement-charge";

/** Record-level scope the cross-family list adds to the statement filters. */
export type StatementSuggestionScope = StatementSuggestionFilters & {
  /** FinancialAccount or candidate/hold FinancialTransaction ids. */
  recordUuids?: readonly string[];
  runCode?: string;
};

const conditions = (filters: StatementSuggestionScope): SQL => {
  const where: SQL[] = [pendingSuggestion()];
  if (filters.accountId) where.push(sql`fa.shortcode = ${filters.accountId}`);
  if (filters.month)
    where.push(sql`${suggestionField("month")} = ${filters.month}`);
  if (filters.action)
    where.push(sql`${suggestionField("recommended")} = ${filters.action}`);
  if (filters.clean !== undefined)
    where.push(sql`(${suggestionField("clean")})::boolean = ${filters.clean}`);
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
      OR a.judgment->'supersede'->>'pendingTransactionId' IN (${ids})
      OR a.judgment->'void'->>'transactionId' IN (${ids}))`);
  }
  return sql.join(where, sql` AND `);
};

const FROM = sql`FROM "AssessmentState" s
  JOIN "Assessment" a ON a.id = s.id
  JOIN "FinancialAccount" fa ON fa.id = (${suggestionField("accountId")})::uuid AND fa."deletedAt" IS NULL
  JOIN "StatementRow" r ON r.id = s."recordId"`;

/** The sort and Strength inputs of every pending suggestion in scope. */
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
  }>(sql`
    SELECT s.id, s.fingerprint, (${suggestionField("clean")})::boolean AS clean,
      ${suggestionField("recommended")} AS recommended,
      a.judgment->'candidates'->0->'label'->>'same' AS "labelSame",
      a.judgment->'candidates'->0->'label'->>'confidence' AS "labelConfidence",
      a."createdAt"
    ${FROM}
    WHERE ${conditions(filters)}
  `);
  return rows.map((row) => ({
    ...row,
    recommended: statementTransactionAction.parse(row.recommended),
    createdAt: new Date(row.createdAt),
  }));
}

/** Public rows for the given pending suggestions, in no particular order. */
export async function readStatementSuggestions(
  db: Database,
  ids: readonly string[],
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
    accountName: string;
    merchant: string | null;
    rawDescription: string;
    sourceCategory: string | null;
  }>(sql`
    SELECT s.id, s.fingerprint, s.data, a.judgment, s.model, a."createdAt",
      fa.shortcode AS "accountCode", fa.name AS "accountName",
      r.merchant, r."rawDescription", r."sourceCategory"
    ${FROM}
    WHERE ${pendingSuggestion()} AND s.id IN (${sql.join(
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
      accountName: row.accountName,
      statementDate: judgment.statementDate,
      amount: judgment.create?.amount ?? 0,
      merchant: row.merchant,
      rawDescription: row.rawDescription,
      sourceCategory: row.sourceCategory,
      providerStatus: judgment.providerStatus,
      recommended: judgment.recommended,
      clean: judgment.clean,
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
    WHERE s.family = 'statement_transaction'
      ${runCode ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${runCode})` : sql``}
    GROUP BY s.status
  `);
  return rows;
}

export async function listStatementSuggestionGroups(db: Database) {
  const { rows } = await unwrapDb(db).execute<{
    accountId: string;
    accountName: string;
    month: string;
    total: number;
    clean: number;
    create: number;
    attach: number;
    supersede: number;
    void: number;
    amount: string;
  }>(sql`
    SELECT fa.shortcode AS "accountId", fa.name AS "accountName", ${suggestionField("month")} AS month,
      count(*)::int AS total,
      count(*) FILTER (WHERE (${suggestionField("clean")})::boolean)::int AS clean,
      count(*) FILTER (WHERE ${suggestionField("recommended")} = ${statementTransactionAction.enum.create})::int AS "create",
      count(*) FILTER (WHERE ${suggestionField("recommended")} = ${statementTransactionAction.enum.attach})::int AS "attach",
      count(*) FILTER (WHERE ${suggestionField("recommended")} = ${statementTransactionAction.enum.supersede})::int AS "supersede",
      count(*) FILTER (WHERE ${suggestionField("recommended")} = ${statementTransactionAction.enum.void})::int AS "void",
      COALESCE(sum((${suggestionField("amount")})::numeric), 0) AS amount
    FROM "AssessmentState" s
    JOIN "FinancialAccount" fa ON fa.id = (${suggestionField("accountId")})::uuid AND fa."deletedAt" IS NULL
    WHERE ${pendingSuggestion()}
    GROUP BY fa.shortcode, fa.name, 3
    ORDER BY 3 DESC, fa.name
  `);
  return rows.map((row) => ({
    ...row,
    accountId: parseShortcodeFor("financialAccount", row.accountId),
    amount: Number(row.amount),
  }));
}
