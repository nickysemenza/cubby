import { emailLinkEvidenceKind } from "@cubby/schemas/email-fields";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { appSettings } from "~/server/db/retained-tables";
import { emailPurchaseEvidenceSql } from "~/server/domains/email/repo/email-purchase-links";

// Random id; the retired roster cursor row had a different, incompatible shape.
const CURSOR_ID = "6c1b7a52-0f1e-4e8a-9f3d-2a4b8d7e5c91";
const cursorSchema = z.object({
  after: z.uuid().nullable().default(null),
  nextAt: z.iso.datetime().nullable().default(null),
});
export const EMAIL_PURCHASE_PAGE = 50;

/** Emails whose retained evidence suggests a purchase link, in id order after the cursor. */
export async function emailsWithSuggestedPurchases(
  db: Database,
  after: string | null,
) {
  const rows = await getDb(db).execute(
    sql`
    SELECT DISTINCT "Email"."id" AS "id", "Email"."shortcode" AS "shortcode"
    FROM "Email"
    CROSS JOIN LATERAL (${emailPurchaseEvidenceSql()}) evidence
    WHERE ${notDeleted("Email")} AND evidence."kind" = ${emailLinkEvidenceKind.enum.suggested}
      ${after ? sql`AND "Email"."id" > ${after}::uuid` : sql``}
    ORDER BY "Email"."id" LIMIT ${EMAIL_PURCHASE_PAGE}
  `,
    "objects",
  );
  return z.array(z.object({ id: z.uuid(), shortcode: z.string() })).parse(rows);
}

const cursorNextAt = sql`(SELECT ((${appSettings.metadata}->>'nextAt')::timestamptz AT TIME ZONE 'UTC')
  FROM ${appSettings} WHERE ${appSettings.id} = ${CURSOR_ID}::uuid)`;

/** Permit selection: the pass takes a page unless its cursor waits for a later hour. */
export const emailPurchaseDiscoveryDue = (unit: string) =>
  sql`SELECT ${unit}::text AS unit, false AS demand, now()::timestamp AS since
    WHERE coalesce(${cursorNextAt} <= now() AT TIME ZONE 'UTC', true)`;
export const emailPurchaseDiscoveryNext = () =>
  sql`SELECT coalesce(${cursorNextAt}, now() AT TIME ZONE 'UTC')`;

/** Serializes one pass page on its cursor row and saves the cursor `work` returns. */
export function emailPurchaseDiscoveryPage<T extends { nextAt: Date | null }>(
  db: Database,
  work: (
    tx: Database,
    cursor: z.infer<typeof cursorSchema>,
  ) => Promise<{ result: T; next: string | null }>,
) {
  return repositoryTransactionDatabase(db, async (tx) => {
    await repositoryQueries(tx)
      .insert(appSettings)
      .values({ id: CURSOR_ID, metadata: {} })
      .onConflictDoNothing();
    const [row] = await repositoryQueries(tx)
      .select({ metadata: appSettings.metadata })
      .from(appSettings)
      .where(eq(appSettings.id, CURSOR_ID))
      .for("update");
    const { result, next } = await work(
      tx,
      cursorSchema.parse(row?.metadata ?? {}),
    );
    await repositoryQueries(tx)
      .update(appSettings)
      .set({
        metadata: { after: next, nextAt: result.nextAt?.toISOString() ?? null },
        updatedAt: new Date(),
      })
      .where(eq(appSettings.id, CURSOR_ID));
    return result;
  });
}
