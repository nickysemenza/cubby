import { financialAccountIdentityKind } from "@cubby/schemas/financial-account";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party";
import { and, eq, sql, type SQL } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { financialAccount, ledgerParty } from "~/server/db/retained-tables";

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

export const accountPurchaserKey = (accountId: string, date: string | null) =>
  `${accountId}:${date ?? ""}`;

/** One query for the page's account/date pairs; no primary-cardholder relation is required. */
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
  const date = sql<string | null>`purchaser_date.date::text`;
  const rows = unique.size
    ? await repositoryQueries(db)
        .select({
          accountId: financialAccount.id,
          date,
          primaryCardholder: {
            id: ledgerParty.id,
            shortcode: ledgerParty.shortcode,
          },
          soleAccess: soleCardAccessSql(
            sql`${financialAccount.authorizedUsers}`,
            sql`purchaser_date.date`,
          ),
        })
        .from(financialAccount)
        .innerJoin(
          sql`(VALUES ${sql.join(
            [...unique.values()].map(
              (input) => sql`(${input.accountId}::uuid, ${input.date}::date)`,
            ),
            sql`, `,
          )}) AS purchaser_date("accountId", date)`,
          sql`purchaser_date."accountId" = ${financialAccount.id}`,
        )
        .leftJoin(
          ledgerParty,
          and(
            eq(ledgerParty.id, financialAccount.primaryCardholderId),
            eq(ledgerParty.kind, ledgerPartyKind.enum.member),
            notDeleted(ledgerParty),
          ),
        )
        .where(notDeleted(financialAccount))
    : [];
  return new Map(
    rows.map((row) => [accountPurchaserKey(row.accountId, row.date), row]),
  );
}

/** Purchaser authority is independent of dated funding attribution. */
export function financialAccountPurchaser(
  account: typeof financialAccount.$inferSelect & {
    ledgerParty: typeof ledgerParty.$inferSelect | null;
  },
  proof: ReturnType<
    Awaited<ReturnType<typeof loadAccountPurchaserProofs>>["get"]
  >,
) {
  if (account.deletedAt || account.provisional) return null;
  if (
    account.ledgerParty?.kind === ledgerPartyKind.enum.member &&
    !account.ledgerParty.deletedAt
  )
    return account.ledgerParty;
  if (
    account.identity.kind === financialAccountIdentityKind.enum.credit_card &&
    proof?.soleAccess
  )
    return proof.primaryCardholder;
  return null;
}
