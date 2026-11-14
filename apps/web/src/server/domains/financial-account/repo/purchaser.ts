import { eq, sql, type SQL } from "drizzle-orm";

import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { requestedRows } from "~/server/db/helpers/requested";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { financialAccount, ledgerParty } from "~/server/db/retained-tables";
import { accountPurchaserKey } from "~/server/domains/financial-account/policy/purchaser";

/** Any authorized access covering the date, including either bound, defeats sole use. */
export const soleCardAccessSql = (
  authorizedUsers: SQL,
  date: SQL,
) => sql<boolean>`(
  ${date} IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(${authorizedUsers}) membership
    WHERE (membership->>'validFrom' IS NULL OR (membership->>'validFrom')::date <= ${date})
      AND (membership->>'validTo' IS NULL OR ${date} <= (membership->>'validTo')::date)
  )
)`;

/** Batch raw holder evidence, including invalid holders so null-to-null changes invalidate approval. */
export async function loadAccountPurchaserProofs(
  db: Database,
  inputs: readonly {
    accountId: (typeof financialAccount.$inferSelect)["id"];
    date: string | null;
  }[],
) {
  const unique = new Map(
    inputs.map((input) => [
      accountPurchaserKey(input.accountId, input.date),
      input,
    ]),
  );
  const dates = requestedRows(
    [...unique.values()],
    { accountId: "uuid", date: "text" },
    "purchaser_date",
  );
  const date = sql<string | null>`purchaser_date.date::date::text`;
  const rows = unique.size
    ? await repositoryQueries(db)
        .select({
          accountId: financialAccount.id,
          date,
          primaryCardholder: {
            id: ledgerParty.id,
            shortcode: ledgerParty.shortcode,
            kind: ledgerParty.kind,
            deletedAt: ledgerParty.deletedAt,
          },
          soleAccess: soleCardAccessSql(
            sql`${financialAccount.authorizedUsers}`,
            sql`purchaser_date.date::date`,
          ),
        })
        .from(financialAccount)
        .innerJoin(
          dates.from,
          sql`purchaser_date."accountId" = ${financialAccount.id}`,
        )
        .leftJoin(
          ledgerParty,
          eq(
            ledgerParty.id,
            effectiveFieldSql("financialAccount", "primaryCardholderId"),
          ),
        )
        .where(notDeleted(financialAccount))
    : [];
  return new Map(
    rows.map((row) => [accountPurchaserKey(row.accountId, row.date), row]),
  );
}
