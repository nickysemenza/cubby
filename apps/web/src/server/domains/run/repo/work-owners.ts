import { ledgerPartyKind } from "@cubby/schemas/ledger-party";
import { isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import { ledgerParty, run, vendorAccount } from "~/server/db/schema";

/** A bound, deleted account stays unresolved rather than falling back to its actor. */
export const workRunOwners = (id: SQL): SQL => sql`ARRAY(
  SELECT CASE WHEN work_source_run."vendorAccountId" IS NOT NULL THEN account."ledgerPartyId"
    ELSE work_source_run."ledgerPartyId" END
  FROM "Run" work_source_run
  LEFT JOIN "VendorAccount" account ON account.id = work_source_run."vendorAccountId" AND ${notDeleted(alias(vendorAccount, "account"))}
  WHERE work_source_run.id = ${id} AND ${notDeleted(alias(run, "work_source_run"))}
)`;

/** Retained Run controls require the live member/login and current source account
 * to agree. Both bulk candidates and per-finding lookups use this policy. */
const runReviewAuthority = (aliasName: string) => {
  const source = sql.identifier(aliasName);
  return {
    source,
    table: sql`"Run" ${source}
      LEFT JOIN "LedgerParty" work_review_member ON work_review_member.id = ${source}."ledgerPartyId"
        AND work_review_member.kind = ${ledgerPartyKind.enum.member} AND ${notDeleted(alias(ledgerParty, "work_review_member"))}
      LEFT JOIN "VendorAccount" work_review_account ON work_review_account.id = ${source}."vendorAccountId"
        AND ${notDeleted(alias(vendorAccount, "work_review_account"))}`,
    owner: sql`CASE WHEN work_review_member."userId" = ${source}."actorUserId"
      AND (CASE WHEN ${source}."vendorAccountId" IS NOT NULL THEN work_review_account."ledgerPartyId"
        ELSE ${source}."ledgerPartyId" END) = ${source}."ledgerPartyId"
      THEN ${source}."ledgerPartyId" ELSE NULL::uuid END`,
  };
};

export const workRunReviewOwners = (id: SQL): SQL => {
  const { source, table, owner } = runReviewAuthority("work_review_run");
  return sql`ARRAY(SELECT ${owner} FROM ${table}
    WHERE ${source}.id = ${id} AND ${isNull(sql`${source}."deletedAt"`)})`;
};

/** Unique member/account joins preserve one row per Run without a correlated
 * Run reread. The candidate predicate still owns Run liveness and attention. */
export const workRunReviewRead = () => {
  const { table, owner } = runReviewAuthority("Run");
  return { table, owners: sql`ARRAY[${owner}]` };
};
