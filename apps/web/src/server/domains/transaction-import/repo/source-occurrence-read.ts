import { sourceOccurrenceRawOut } from "@cubby/schemas/entity-contracts/sourceOccurrence";
import { sourceOccurrenceClosure } from "@cubby/schemas/source-occurrence-fields";
import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  sourceOccurrenceRepositoryReadSchema,
  sourceOccurrenceSchemaBindings,
} from "~/entity/generated/entity-schema-bindings.sourceOccurrence.gen";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  isTransaction,
  unwrapDb,
  withTransaction,
} from "~/server/db/helpers";
import { sourceOccurrence } from "~/server/db/schema";
import { expenseScaffold } from "~/server/domains/expense/repo/lookup";
import { defineRepository } from "~/server/entity-kernel/repo/repository";
import { constraintViolation } from "~/server/errors/app-error";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListReadOptions } from "~/server/generic/list/repo/list-projection";
import { jsonSnapshot } from "~/server/lib/canonical-json";

const rawSets = sourceOccurrenceClosure.shape.sets.omit({
  effectiveExpenses: true,
});
const resultSchema = z.object({ snapshot: z.string(), sets: rawSets });
const rowIdentity = z.object({ id: z.string() });

/** One snapshot and one shared graph load per requested owner page. Never authorizes a write. */
async function loadOccurrenceClosures(
  db: Database | DrizzleTransaction,
  rows: readonly (typeof sourceOccurrence.$inferSelect)[],
) {
  if (rows.length > 10)
    return constraintViolation(
      "Read occurrence closure in groups of at most ten owners.",
    );
  if (!rows.length)
    return new Map<string, z.infer<typeof sourceOccurrenceClosure>>();
  const database = isTransaction(db) ? databaseForTransaction(db) : db;
  return withTransaction(
    database,
    async (tx) => {
      const query = unwrapDb(tx);
      const isolation = await query.execute(
        sql`SELECT current_setting('transaction_isolation') AS level`,
        "objects",
      );
      if (
        isolation[0]?.level !== "repeatable read" &&
        isolation[0]?.level !== "serializable"
      )
        return constraintViolation(
          "Occurrence closure needs a snapshot read outside a read-committed write transaction.",
        );
      const ids = sql.join(
        rows.map((row) => sql`${row.id}::uuid`),
        sql`, `,
      );
      // CTEs select complete sets, including tombstones. LIMIT is only a sentinel: overflow refuses the bundle.
      const definitions = sql`
      WITH owners AS MATERIALIZED (SELECT * FROM "SourceOccurrence" WHERE id IN (${ids})),
      observations AS MATERIALIZED (SELECT * FROM "SourceTransactionRecord" WHERE "occurrenceId" IN (SELECT id FROM owners)),
      root_aliases AS MATERIALIZED (SELECT * FROM "FinancialEvidenceAlias" WHERE "observationId" IN (SELECT id FROM observations) OR "occurrenceId" IN (SELECT id FROM owners)),
      siblings AS MATERIALIZED (SELECT DISTINCT sibling.* FROM "FinancialEvidenceAlias" sibling JOIN root_aliases root ON sibling.source=root.source AND sibling.value=root.value WHERE sibling."observationId" IS NOT NULL),
      observation_aliases AS MATERIALIZED (
        SELECT * FROM root_aliases
        UNION SELECT * FROM "FinancialEvidenceAlias" WHERE "observationId" IN (SELECT "observationId" FROM siblings)
        UNION SELECT * FROM "FinancialEvidenceAlias" WHERE "occurrenceId" IN (SELECT "occurrenceId" FROM siblings WHERE "occurrenceId" IS NOT NULL)
      ),
      bindings AS MATERIALIZED (SELECT DISTINCT binding.* FROM "FinancialEvidenceAlias" binding JOIN observation_aliases evidence ON evidence.source=binding.source AND evidence.value=binding.value WHERE binding."historicalTransactionId" IS NOT NULL),
      transactions AS MATERIALIZED (SELECT * FROM "FinancialTransaction" WHERE id IN (SELECT "acceptedTransactionId" FROM owners UNION SELECT "historicalTransactionId" FROM bindings)),
      allocations AS MATERIALIZED (SELECT * FROM "FinancialTransactionAllocation" WHERE "transactionId" IN (SELECT id FROM transactions)),
      purchases AS MATERIALIZED (SELECT * FROM "Purchase" WHERE id IN (SELECT "purchaseId" FROM allocations)),
      expenses AS MATERIALIZED (SELECT * FROM "Expense" WHERE "purchaseId" IN (SELECT id FROM purchases)),
      memberships AS MATERIALIZED (SELECT * FROM "TransactionImportRecord" WHERE "statementRowId" IN (SELECT id FROM observations)),
      aliases AS MATERIALIZED (SELECT * FROM observation_aliases UNION SELECT * FROM bindings),
      judgments AS MATERIALIZED (SELECT * FROM "SourceObservationAnnotation" WHERE "observationId" IN (SELECT id FROM observations)),
      collections AS MATERIALIZED (SELECT * FROM "TransactionImport" WHERE id IN (SELECT "importId" FROM memberships)),
      attribution AS MATERIALIZED (SELECT * FROM "ExpenseAttribution" WHERE "expenseId" IN (SELECT id FROM expenses)),
      transfers AS MATERIALIZED (SELECT * FROM "LedgerTransfer" WHERE id IN (SELECT "ledgerTransferId" FROM transactions)),
      claims AS MATERIALIZED (SELECT * FROM "LedgerSourceClaim" WHERE "expenseId" IN (SELECT id FROM expenses) OR "ledgerTransferId" IN (SELECT id FROM transfers)),
      payment_evidence AS MATERIALIZED (SELECT * FROM "PurchasePaymentEvidence" WHERE "purchaseId" IN (SELECT id FROM purchases)),
      receipts AS MATERIALIZED (
        SELECT id,"runId","operationId",kind,"inputFingerprint",state,"completedAt" FROM "RunOperation" receipt
        WHERE jsonb_path_exists(receipt.result, '$.** ? (@ == $codes[*])',
          jsonb_build_object('codes',(SELECT coalesce(jsonb_agg(shortcode),'[]'::jsonb) FROM transactions)))
      )`;
      const selections: ReadonlyArray<readonly [string, string, string]> = [
        ["occurrences", "owners", "to_jsonb(r)"],
        [
          "observations",
          "observations",
          `to_jsonb(r)||jsonb_build_object('amountMinor',r."amountMinor"::text,'providerAmountMinor',r."providerAmountMinor"::text)`,
        ],
        ["judgments", "judgments", "to_jsonb(r)"],
        ["aliases", "aliases", "to_jsonb(r)"],
        ["memberships", "memberships", "to_jsonb(r)"],
        ["collections", "collections", "to_jsonb(r) - 'notes'"],
        [
          "transactions",
          "transactions",
          `to_jsonb(r)||jsonb_build_object('amountMinor',r."amountMinor"::text)`,
        ],
        [
          "allocations",
          "allocations",
          `to_jsonb(r)||jsonb_build_object('amountMinor',r."amountMinor"::text)`,
        ],
        [
          "purchases",
          "purchases",
          `to_jsonb(r)||jsonb_build_object('statedTotalMinor',r."statedTotalMinor"::text)`,
        ],
        ["expenses", "expenses", "to_jsonb(r)"],
        [
          "recordedAttribution",
          "attribution",
          `to_jsonb(r)||jsonb_build_object('weight',r.weight::text)`,
        ],
        [
          "transfers",
          "transfers",
          `to_jsonb(r)||jsonb_build_object('amountMinor',r."amountMinor"::text)`,
        ],
        [
          "sourceClaims",
          "claims",
          `to_jsonb(r)||jsonb_build_object('targetAmountMinor',r."targetAmountMinor"::text)`,
        ],
        [
          "paymentEvidence",
          "payment_evidence",
          `to_jsonb(r)||jsonb_build_object('amountMinor',r."amountMinor"::text)`,
        ],
        ["receiptReferences", "receipts", "to_jsonb(r)"],
      ];
      const sets = selections.map(
        ([name, table, value]) =>
          sql`${name}::text, (SELECT coalesce(jsonb_agg(data ORDER BY identity), '[]'::jsonb) FROM (SELECT ${sql.raw(table === "judgments" ? 'r."observationId"::text' : table === "memberships" ? 'jsonb_build_array(r."importId", r."statementRowId")::text' : "r.id::text")} AS identity, ${sql.raw(value)} AS data FROM ${sql.identifier(table)} r ORDER BY identity LIMIT 1001) captured)`,
      );
      const loaded = await query.execute(
        sql`${definitions}, bundle AS MATERIALIZED (SELECT jsonb_build_object(${sql.join(sets, sql`, `)}) AS data)
          SELECT txid_current_snapshot()::text AS snapshot,
            CASE WHEN octet_length(data::text) <= 1048576 THEN data END AS sets FROM bundle`,
        "objects",
      );
      if (loaded[0]?.sets === null)
        return constraintViolation(
          "Occurrence closure exceeds one MiB; narrow the owner scope.",
        );
      const captured = resultSchema.parse(loaded[0]);
      if (Object.values(captured.sets).some((set) => set.length > 1000))
        return constraintViolation(
          "Occurrence closure exceeds one thousand rows in a named set; narrow the owner scope.",
        );
      const expenseIds = captured.sets.expenses.map(
        (row) => rowIdentity.parse(row).id,
      );
      // The canonical Expense read supplies recorded inputs and effective attribution/category with provenance.
      const effectiveExpenses = expenseIds.length
        ? (
            await expenseScaffold.getByIds(tx, expenseIds, [
              "beneficiaries",
              "funders",
              "spendingCategoryId",
              "spendingCategoryName",
              "projectAllocations",
              "spendingCategoryAllocations",
            ])
          ).data
        : [];
      const shared = {
        scope: rows.map((row) => row.shortcode),
        snapshot: captured.snapshot,
        sets: {
          ...captured.sets,
          effectiveExpenses: jsonSnapshot.parse(effectiveExpenses),
        },
      };
      if (new TextEncoder().encode(JSON.stringify(shared)).byteLength > 1048576)
        return constraintViolation(
          "Occurrence closure exceeds one MiB; narrow the owner scope.",
        );
      // The complete page bundle belongs to the first result only; copying it per root multiplies Worker memory.
      const first = rows[0];
      if (!first)
        return new Map<string, z.infer<typeof sourceOccurrenceClosure>>();
      return new Map([
        [
          first.id,
          sourceOccurrenceClosure.parse({ root: first.shortcode, ...shared }),
        ],
      ]);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

const read = {
  references: {
    physicalImportId: { kind: "lookup", missing: "null", includeDeleted: true },
    currentObservationId: {
      kind: "lookup",
      missing: "null",
      includeDeleted: true,
    },
    accountId: { kind: "lookup", missing: "null", includeDeleted: true },
    supersededByOccurrenceId: {
      kind: "lookup",
      missing: "null",
      includeDeleted: true,
    },
    replacementObservationId: {
      kind: "lookup",
      missing: "null",
      includeDeleted: true,
    },
    withdrawalImportId: {
      kind: "lookup",
      missing: "null",
      includeDeleted: true,
    },
    acceptedTransactionId: {
      kind: "lookup",
      missing: "null",
      includeDeleted: true,
    },
  },
  bindings: (bind) => {
    const closure = bind.batch(({ db, rows }) =>
      loadOccurrenceClosures(db, rows),
    );
    return [
      closure.fields(
        sourceOccurrenceRawOut.pick({ closure: true }),
        (row, loaded) => ({
          closure: loaded.get(row.id),
        }),
        { scope: "explicit" },
      ),
    ];
  },
} satisfies ListReadOptions<typeof sourceOccurrence.$inferSelect>;

export const sourceOccurrenceRepository = defineRepository("sourceOccurrence", {
  schemas: sourceOccurrenceSchemaBindings,
  scaffold: listScaffold("sourceOccurrence", sourceOccurrence, {
    readSchema: sourceOccurrenceRepositoryReadSchema,
    read,
  }),
});
