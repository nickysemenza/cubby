import type { ActorContext } from "@cubby/schemas/context";
import {
  parseShortcodeFor,
  type SourceTransactionRecordId,
  type FinancialTransactionShortcode,
} from "@cubby/schemas/identifiers";
import { sourceOccurrenceReviewState } from "@cubby/schemas/source-occurrence-fields";
import { transactionImportInput } from "@cubby/schemas/source-transaction-record";
import { moneyToMinor } from "@cubby/shared";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted, unwrapDb } from "~/server/db/helpers";
import { textArrayParam } from "~/server/db/helpers/query";
import { transactionImportRecord } from "~/server/db/retained-tables";
import { transactionImport } from "~/server/db/schema";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { reconcileFinancialEvidenceCorrection } from "~/server/domains/financial-transaction/repo/financial-evidence-correction";
import {
  sourceObservationColumns,
  sourceObservationsForPage,
} from "~/server/domains/transaction-import/repo/source-observation-state";

/** A ready occurrence supplies current facts; all accepted occurrences corroborate independently. */
export async function reconcileRecordedFinancialEvidence(
  db: Database,
  source: string,
  occurrenceCodes: readonly string[],
  actor: ActorContext,
) {
  const reviews: {
    transactionId: FinancialTransactionShortcode;
    reason: string;
  }[] = [];
  if (!occurrenceCodes.length) return reviews;
  const ids = await unwrapDb(db).execute<{ id: SourceTransactionRecordId }>(
    sql`
    SELECT r.id FROM "SourceOccurrence" o JOIN "SourceTransactionRecord" r ON r.id=o."currentObservationId"
    WHERE o.source=${source} AND o.shortcode = ANY(${textArrayParam(occurrenceCodes)}) AND ${notDeleted("r")}
  `,
    "objects",
  );
  const heads = ids.length
    ? await getDb(db)
        .select({
          acceptedTransactionId: sourceObservationColumns.acceptedTransactionId,
          transactionShortcode: sourceObservationColumns.transactionShortcode,
          chargeKey: sourceObservationColumns.chargeKey,
          withdrawnAt: sourceObservationColumns.withdrawnAt,
          amount: sourceObservationColumns.amount,
        })
        .from(
          sql`${sourceObservationsForPage(ids.map((row) => row.id))} "SourceTransactionRecord"`,
        )
        .where(eq(sourceObservationColumns.reviewState, "ready"))
    : [];
  for (const head of heads) {
    if (
      head.acceptedTransactionId === null ||
      head.transactionShortcode === null
    )
      continue;
    const transactionId = parseShortcodeFor(
      "financialTransaction",
      head.transactionShortcode,
    );
    const result = await reconcileFinancialEvidenceCorrection(
      db,
      {
        source,
        externalId: head.chargeKey,
        transactionId,
        amount: head.withdrawnAt === null ? head.amount : null,
        verifyCurrentEvidence: async (tx, observation) => {
          if (observation.withdrawnAt !== null) {
            const [proof] = observation.withdrawalImportId
              ? await getDb(tx)
                  .select()
                  .from(transactionImport)
                  .where(
                    and(
                      eq(transactionImport.id, observation.withdrawalImportId),
                      notDeleted(transactionImport),
                    ),
                  )
                  .limit(1)
              : [];
            const counts = await unwrapDb(tx).execute<{
              count: number;
            }>(
              sql`
            SELECT count(*)::int AS count FROM ${transactionImportRecord} member WHERE member."importId"=${observation.withdrawalImportId}::uuid`,
              "objects",
            );
            const parsed = transactionImportInput.shape.coverage.safeParse(
              proof?.coverage,
            );
            const coverage = parsed.success ? parsed.data : undefined;
            if (
              !proof?.completedAt ||
              counts[0]?.count !== proof.rowCountDeclared ||
              !coverage ||
              coverage.visibility !== "all" ||
              coverage.account !== observation.providerAccountId ||
              coverage.from > observation.statementDate ||
              coverage.to < observation.statementDate
            )
              return {
                status: "review",
                reason:
                  "Withdrawal requires persisted complete account/window evidence.",
              };
          }
          const rows = await unwrapDb(tx).execute<{ blocked: boolean }>(
            sql`
          -- includes-deleted: retired observations and bindings remain safety blockers.
          SELECT EXISTS (
            SELECT 1 FROM "SourceOccurrence" other
            LEFT JOIN "SourceTransactionRecord" evidence ON evidence.id = other."currentObservationId"
            WHERE other."acceptedTransactionId" = ${observation.acceptedTransactionId}::uuid
              AND other.id <> ${observation.occurrenceId}::uuid
              AND (other."deletedAt" IS NOT NULL OR other."reviewState" <> ${sqlEnumConstant(sourceOccurrenceReviewState, sourceOccurrenceReviewState.enum.ready)}
                OR other."supersededByOccurrenceId" IS NOT NULL OR other."replacementObservationId" IS NOT NULL
                OR evidence.id IS NULL OR evidence."deletedAt" IS NOT NULL
                OR (other."withdrawnAt" IS NULL AND (${observation.withdrawnAt !== null}
                  OR evidence."amountMinor" <> ${moneyToMinor(observation.amount)}::bigint
                  OR other."accountId" IS DISTINCT FROM ${observation.accountId}::uuid)))
            UNION ALL
            SELECT 1 FROM "FinancialEvidenceAlias" alias
            LEFT JOIN "SourceOccurrence" owner ON owner.id = alias."occurrenceId"
            WHERE alias."historicalTransactionId" = ${observation.acceptedTransactionId}::uuid
              AND (owner.id IS NULL OR owner."acceptedTransactionId" IS DISTINCT FROM alias."historicalTransactionId")
          ) AS blocked`,
            "objects",
          );
          return rows[0]?.blocked
            ? {
                status: "review",
                reason:
                  "Independent or unresolved historical source evidence blocks automatic booking correction.",
              }
            : { status: "verified" };
        },
      },
      actor,
    );
    if (result.status === "review")
      reviews.push({ transactionId, reason: result.reason });
  }
  return reviews;
}
