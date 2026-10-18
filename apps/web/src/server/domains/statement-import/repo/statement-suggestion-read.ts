import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  type listStatementSuggestionsInput,
  statementSuggestionOut,
  statementTransactionAction,
  statementTransactionJudgment,
  type StatementSuggestionFilters,
  type StatementSuggestionOut,
} from "@cubby/schemas/statement-suggestion";
import { sql, type SQL } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import {
  pendingSuggestion,
  suggestionField,
} from "~/server/domains/statement-import/repo/statement-charge";

const conditions = (filters: StatementSuggestionFilters): SQL => {
  const where: SQL[] = [pendingSuggestion()];
  if (filters.accountId) where.push(sql`fa.shortcode = ${filters.accountId}`);
  if (filters.month)
    where.push(sql`${suggestionField("month")} = ${filters.month}`);
  if (filters.action)
    where.push(sql`${suggestionField("recommended")} = ${filters.action}`);
  if (filters.clean !== undefined)
    where.push(sql`(${suggestionField("clean")})::boolean = ${filters.clean}`);
  return sql.join(where, sql` AND `);
};

const FROM = sql`FROM "AssessmentState" s
  JOIN "Assessment" a ON a.id = s.id
  JOIN "FinancialAccount" fa ON fa.id = (${suggestionField("accountId")})::uuid AND fa."deletedAt" IS NULL
  JOIN "StatementRow" r ON r.id = s."recordId"`;

export async function listStatementSuggestions(
  db: Database,
  input: z.output<typeof listStatementSuggestionsInput>,
) {
  const where = conditions(input.filters);
  const [page, counted] = await Promise.all([
    unwrapDb(db).execute<{
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
      WHERE ${where}
      ORDER BY ${suggestionField("statementDate")} DESC, s.id
      LIMIT ${input.limit} OFFSET ${input.offset}
    `),
    unwrapDb(db).execute<{ count: number }>(
      sql`SELECT count(*)::int AS count ${FROM} WHERE ${where}`,
    ),
  ]);
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
  const data: StatementSuggestionOut[] = page.rows.flatMap((row, index) => {
    const judgment = judgments[index]!;
    // A candidate deleted since publication drops out; the trigger-free
    // read never names a transaction that no longer exists.
    const candidates = judgment.candidates.filter((candidate) =>
      codes.has(candidate.transactionId),
    );
    const { sourceRef: _ref, ...create } = judgment.create ?? {
      sourceRef: null,
    };
    return [
      statementSuggestionOut.parse({
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
          judgment.supersede &&
          codes.has(judgment.supersede.pendingTransactionId)
            ? code(judgment.supersede.pendingTransactionId)
            : null,
        voidTransactionId:
          judgment.void && codes.has(judgment.void.transactionId)
            ? code(judgment.void.transactionId)
            : null,
        siblings: judgment.siblings.length,
        model: row.model === "rule" ? null : row.model,
        createdAt: new Date(row.createdAt).toISOString(),
      }),
    ];
  });
  return { data, count: Number(counted.rows[0]?.count ?? 0) };
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
  return {
    data: rows.map((row) => ({
      ...row,
      accountId: parseShortcodeFor("financialAccount", row.accountId),
      amount: Number(row.amount),
    })),
  };
}
