import { emailClassificationObservationInput } from "@cubby/schemas/email-observations";
import { desc, eq, inArray, type SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { databaseForTransaction, isTransaction } from "~/server/db/helpers";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { email, emailClassificationObservation } from "~/server/db/schema";

type Changes = Partial<{
  [K in keyof typeof email.$inferInsert]: (typeof email.$inferInsert)[K] | SQL;
}>;

/** Source publications append predictions; emailState alone publishes relevance. */
export async function updateEmailStateWhere(
  db: Database | DrizzleTransaction,
  values: Changes,
  where: SQL | undefined,
) {
  const source = isTransaction(db) ? databaseForTransaction(db) : db;
  const { householdWrite, append, evidenceRow, reconcileNow, emitWrites } =
    await import("~/server/kernel/api");
  const { emailStateColumns, emailPredictionEvidence } =
    await import("~/server/domains/email/repo/email-state");
  return householdWrite(source, async (database) => {
    const q = repositoryQueries(database);
    const authored = Object.fromEntries(
      Object.entries(values).filter(
        ([field, value]) =>
          value !== undefined &&
          !emailStateColumns.some((owned) => owned === field),
      ),
    );
    const requested = Object.entries(values).filter(
      ([field, value]) =>
        value !== undefined &&
        emailStateColumns.some((owned) => owned === field),
    );
    const rows = Object.keys(authored).length
      ? await q.update(email).set(authored).where(where).returning()
      : await q.select().from(email).where(where);
    if (requested.length) {
      for (const row of rows) {
        const input = emailClassificationObservationInput.parse({
          emailId: row.id,
          checksum: row.checksum,
          classification: row.classification,
          stage: row.classificationStage,
          reason: row.classificationReason,
          classificationVersion: row.classificationVersion,
          ...Object.fromEntries(
            requested.map(([field, value]) => [
              field === "classificationStage"
                ? "stage"
                : field === "classificationReason"
                  ? "reason"
                  : field,
              value,
            ]),
          ),
        });
        const [previous] = await q
          .select()
          .from(emailClassificationObservation)
          .where(eq(emailClassificationObservation.emailId, row.id))
          .orderBy(
            desc(emailClassificationObservation.createdAt),
            desc(emailClassificationObservation.id),
          )
          .limit(1);
        if (
          previous &&
          previous.checksum === input.checksum &&
          previous.classification === input.classification &&
          previous.stage === input.stage &&
          previous.reason === input.reason &&
          previous.classificationVersion === input.classificationVersion
        ) {
          const { recordEmailClassificationApplication } =
            await import("~/server/domains/purchase-import/repo/gmail/observations");
          await recordEmailClassificationApplication(database, previous.id);
        } else {
          await append(database, [
            evidenceRow(emailPredictionEvidence, {
              ...input,
              application: "applied",
            }),
          ]);
        }
      }
    }
    if (rows.length)
      await emitWrites(database, {
        table: email,
        ids: rows.map((row) => row.id),
        columns: Object.keys(authored),
        discovers: rows.map((row) => ({ kind: "emailState", key: row.id })),
      });
    await reconcileNow(
      database,
      rows.map((row) => ({ kind: "emailState", key: row.id })),
    );
    return rows.length
      ? q
          .select()
          .from(email)
          .where(
            inArray(
              email.id,
              rows.map((row) => row.id),
            ),
          )
      : [];
  });
}
