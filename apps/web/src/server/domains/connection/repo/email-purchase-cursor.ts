import { emailLinkEvidenceKind } from "@cubby/schemas/email-fields";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { emailPurchaseEvidenceSql } from "~/server/domains/email/repo/email-purchase-links";

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
