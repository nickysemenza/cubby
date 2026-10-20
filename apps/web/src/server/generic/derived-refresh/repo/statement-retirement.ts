import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentChildHandle,
  assessmentFamily,
} from "@cubby/schemas/assessment";
import {
  DERIVED_REFRESH_PAGE,
  derivedRefreshStatementCursor,
} from "@cubby/schemas/derived-refresh";
import { statementRowDisposition } from "@cubby/schemas/statement-row";
import { statementTransactionAction } from "@cubby/schemas/statement-suggestion";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { derivedRefreshCursor } from "~/server/db/schema";
import { readInputRevisions } from "~/server/generic/derived-refresh/repo/revisions";

const KEY = "derived-refresh:statements";
const inputs = [
  "kind:financialTransaction",
  "context:EntityExternalId",
  "context:StatementRow",
];
const fingerprint = async (db: Database) =>
  JSON.stringify(await readInputRevisions(db, inputs));
const candidateRows = z.array(z.object({ id: assessmentChildHandle }));

export async function nextStatementRetirementWake(db: Database) {
  const [stored] = await getDb(db)
    .select()
    .from(derivedRefreshCursor)
    .where(eq(derivedRefreshCursor.key, KEY))
    .limit(1);
  const cursor = stored?.cursor
    ? derivedRefreshStatementCursor.parse(stored.cursor)
    : null;
  return !cursor ||
    cursor.after !== null ||
    cursor.completedFingerprint !== (await fingerprint(db))
    ? new Date()
    : null;
}

/** The cursor finishes its epoch before restarting, so later edits cannot starve high IDs. */
export async function processStatementRetirementPage(db: Database) {
  return withTransactionDatabase(db, async (tx) => {
    const client = getDb(tx);
    await client
      .insert(derivedRefreshCursor)
      .values({ key: KEY })
      .onConflictDoNothing();
    const [stored] = await client
      .select()
      .from(derivedRefreshCursor)
      .where(eq(derivedRefreshCursor.key, KEY))
      .limit(1)
      .for("update");
    const current = await fingerprint(tx);
    const previous = stored?.cursor
      ? derivedRefreshStatementCursor.parse(stored.cursor)
      : null;
    if (previous?.after === null && previous.completedFingerprint === current)
      return { done: true, processed: 0 };
    const cursor = previous?.after
      ? previous
      : {
          phase: derivedRefreshStatementCursor.shape.phase.value,
          after: null,
          inputFingerprint: current,
          completedFingerprint: previous?.completedFingerprint ?? null,
        };
    const result = await client.execute(sql`SELECT id FROM "AssessmentState"
      WHERE family=${assessmentFamily.enum.statement_transaction} AND active AND status=${suggestionStatus.enum.pending}
        ${cursor.after ? sql`AND id>${cursor.after}::uuid` : sql``}
      ORDER BY id LIMIT ${DERIVED_REFRESH_PAGE}`);
    const candidates = candidateRows.parse(result.rows);
    // includes-deleted: deleted observations invalidate their pending suggestions.
    if (candidates.length)
      await client.execute(sql`
      UPDATE "AssessmentState" s SET active=false,status=${suggestionStatus.enum.superseded},"updatedAt"=now()
      WHERE s.id IN (${sql.join(
        candidates.map((row) => sql`${row.id}::uuid`),
        sql`, `,
      )})
        AND s.family=${assessmentFamily.enum.statement_transaction} AND s.active AND s.status=${suggestionStatus.enum.pending}
        -- includes-deleted: retiring suggestions whose observations were deleted.
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(s.data->'refs') ref(value)
          WHERE (s.data->>'recommended'<>${statementTransactionAction.enum.void} AND EXISTS (SELECT 1 FROM "EntityExternalId" e WHERE e.kind='settlement_ref' AND e."deletedAt" IS NULL
            AND e.source=split_part(ref.value,':',1) AND e."externalId"=substr(ref.value,strpos(ref.value,':')+1)))
            -- includes-deleted: deleted observations invalidate pending suggestions.
            OR EXISTS (SELECT 1 FROM "StatementRow" r WHERE r.source=split_part(ref.value,':',1) AND r."externalId"=substr(ref.value,strpos(ref.value,':')+1)
              AND (r."deletedAt" IS NOT NULL OR r.disposition=${statementRowDisposition.enum.ignored} OR r."supersededByRowId" IS NOT NULL))
        )`);
    const completed = candidates.length < DERIVED_REFRESH_PAGE;
    await client
      .update(derivedRefreshCursor)
      .set({
        cursor: {
          ...cursor,
          after: completed ? null : (candidates.at(-1)?.id ?? null),
          completedFingerprint: completed
            ? cursor.inputFingerprint
            : cursor.completedFingerprint,
        },
      })
      .where(eq(derivedRefreshCursor.key, KEY));
    return {
      done: completed && cursor.inputFingerprint === current,
      processed: candidates.length,
    };
  });
}
