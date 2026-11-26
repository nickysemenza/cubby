import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { emailSuggestedEvidenceSql } from "~/server/domains/email/repo/email-purchase-links";

export const EMAIL_PURCHASE_PAGE = 50;

/** Walk Email UUIDs first. The cursor advances even through pages without suggestions. */
export async function readEmailPurchaseDiscoveryPage(
  db: Database,
  after: string | null,
) {
  const rows = await getDb(db).execute(
    sql`
      WITH page AS MATERIALIZED (
        SELECT "id", "shortcode", "orderMailId", "ledgerPartyId", "receivedAt", "deletedAt"
        FROM "Email"
        ${after ? sql`WHERE "id" > ${after}::uuid` : sql``}
        ORDER BY "id" LIMIT ${EMAIL_PURCHASE_PAGE}
      )
      SELECT "Email"."id", "Email"."shortcode",
        CASE WHEN ${notDeleted("Email")} THEN EXISTS (${emailSuggestedEvidenceSql()})
          ELSE false END AS suggested
      FROM page "Email" ORDER BY "Email"."id"
    `,
    "objects",
  );
  const page = z
    .array(
      z.object({ id: z.uuid(), shortcode: z.string(), suggested: z.boolean() }),
    )
    .parse(rows);
  return {
    emails: page.filter((row) => row.suggested),
    after: page.length === EMAIL_PURCHASE_PAGE ? page.at(-1)!.id : null,
  };
}
