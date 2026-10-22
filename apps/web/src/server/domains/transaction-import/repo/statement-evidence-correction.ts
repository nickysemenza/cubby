import type { ActorContext } from "@cubby/schemas/context";
import {
  parseEntityId,
  parseShortcodeFor,
  type FinancialTransactionShortcode,
} from "@cubby/schemas/identifiers";
import { transactionImportInput } from "@cubby/schemas/source-transaction-record";
import { cents } from "@cubby/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/db/helpers";
import { transactionImport, sourceTransactionRecord } from "~/server/db/schema";
import { reconcileFinancialEvidenceCorrection } from "~/server/domains/financial-transaction/repo/financial-evidence-correction";

import { auditEvidenceRows } from "./intake-audit";

/** Revisions can change generated money only while every retained source agrees. */
export async function reconcileRecordedFinancialEvidence(
  db: Database,
  source: string,
  chargeKeys: readonly string[],
  actor: ActorContext,
) {
  const reviews: {
    transactionId: FinancialTransactionShortcode;
    reason: string;
  }[] = [];
  if (!chargeKeys.length) return reviews;
  const heads = await getDb(db)
    .select()
    .from(sourceTransactionRecord)
    .where(
      and(
        eq(sourceTransactionRecord.source, source),
        inArray(sourceTransactionRecord.chargeKey, [...chargeKeys]),
        eq(sourceTransactionRecord.current, true),
        notDeleted(sourceTransactionRecord),
      ),
    );
  for (const head of heads) {
    const { rows: linked } = await unwrapDb(db).execute<{
      shortcode: string;
      accountId: string;
    }>(sql`
      SELECT DISTINCT ft.shortcode, ft."accountId" FROM "FinancialTransaction" ft
      JOIN "EntityExternalId" ref ON ref."entityId" = ft.id AND ref.kind = 'settlement_ref' AND ref."deletedAt" IS NULL
      JOIN "SourceTransactionRecord" observed ON observed.source = ref.source AND observed."deletedAt" IS NULL
        AND (observed."externalId" = ref."externalId" OR
          observed."legacyReference" = ref."externalId")
      WHERE observed.source = ${source} AND observed."chargeKey" = ${head.chargeKey} AND ft."deletedAt" IS NULL
    `);
    if (linked.length !== 1) continue;
    const target = linked[0]!;
    const transactionId = parseShortcodeFor(
      "financialTransaction",
      target.shortcode,
    );
    if (head.accountId === null)
      await withTransaction(db, async (tx) => {
        const updated = await tx
          .update(sourceTransactionRecord)
          .set({
            accountId: parseEntityId("financialAccount", target.accountId),
          })
          .where(
            and(
              eq(sourceTransactionRecord.id, head.id),
              sql`${sourceTransactionRecord.accountId} IS NULL`,
            ),
          )
          .returning();
        await auditEvidenceRows(
          tx,
          actor,
          "sourceTransactionRecord",
          [head],
          updated,
        );
      });
    const result = await reconcileFinancialEvidenceCorrection(
      db,
      {
        source,
        externalId: head.externalId,
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
            const { rows: counts } = await unwrapDb(tx).execute<{
              count: number;
            }>(sql`
            SELECT count(*)::int AS count FROM "TransactionImportRecord" m
            JOIN "SourceTransactionRecord" r ON r.id=m."statementRowId" AND r."deletedAt" IS NULL
            WHERE m."importId"=${observation.withdrawalImportId}::uuid
          `);
            const parsed = transactionImportInput.shape.coverage.safeParse(
              proof?.coverage,
            );
            const coverage = parsed.success ? parsed.data : undefined;
            if (
              !proof?.completedAt ||
              counts[0]?.count !== proof.rowCountDeclared ||
              !coverage ||
              coverage.visibility !== "all" ||
              coverage.account !==
                (observation.providerAccountId ??
                  observation.accountDescriptor) ||
              coverage.from > observation.statementDate ||
              coverage.to < observation.statementDate
            )
              return {
                status: "review",
                reason:
                  "Withdrawal requires persisted complete account/window evidence.",
              };
          }
          const { rows: evidence } = await unwrapDb(tx).execute<{
            amount: number | null;
            withdrawn: boolean | null;
            own: boolean | null;
          }>(sql`
          SELECT DISTINCT latest.amount, latest."withdrawnAt" IS NOT NULL AS withdrawn,
            latest.source = ${source} AND latest."chargeKey" = ${head.chargeKey} AS own
          FROM "FinancialTransaction" ft
          JOIN "EntityExternalId" ref ON ref."entityId" = ft.id AND ref.kind='settlement_ref' AND ref."deletedAt" IS NULL
          LEFT JOIN "SourceTransactionRecord" observed ON observed.source=ref.source AND observed."deletedAt" IS NULL
            AND (observed."externalId"=ref."externalId" OR observed."legacyReference"=ref."externalId")
          LEFT JOIN "SourceTransactionRecord" latest ON latest.source=observed.source AND latest."chargeKey"=observed."chargeKey"
            AND latest.current AND latest."deletedAt" IS NULL
          WHERE ft.shortcode=${transactionId}
        `);
          if (evidence.some((row) => row.amount === null))
            return {
              status: "review",
              reason:
                "Independent settlement evidence needs review before this booking changes.",
            };
          if (
            evidence.some(
              (row) =>
                !row.own &&
                !row.withdrawn &&
                (observation.withdrawnAt !== null ||
                  cents(Number(row.amount)) !== cents(observation.amount)),
            )
          )
            return {
              status: "review",
              reason:
                "Other current source evidence still supports this booking or disagrees with the new amount.",
            };
          return { status: "verified" };
        },
      },
      actor,
    );
    if (result.status === "review")
      reviews.push({ transactionId, reason: result.reason });
  }
  return reviews;
}
