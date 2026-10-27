import type { ParsedShortcode } from "@cubby/shared";
import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import { notDeleted } from "~/server/db/helpers/predicates";
import { financialAccount } from "~/server/db/schema";
import { workExpenseOwners } from "~/server/domains/expense/repo/work-owners";
import { workPurchaseOwners } from "~/server/domains/purchase/repo/work-owners";
import { workRunOwners } from "~/server/domains/run/repo/work-owners";
import { SHORTCODE_TABLE } from "~/server/generic/shortcode/repo/shortcode-tables";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";
const privateOwnerRelation = (ref: ParsedShortcode): SQL | null => {
  if (ref.type === "job") return null;
  const table = SHORTCODE_TABLE[ref.type];
  const id = sql`${table.id}`;
  const scope = sql`${table.shortcode} = ${ref.shortcode} AND ${table.deletedAt} IS NULL`;
  let owners: SQL;
  switch (ref.type) {
    case "purchase":
      owners = workPurchaseOwners(id);
      break;
    case "expense":
      owners = workExpenseOwners(id);
      break;
    case "run":
      owners = workRunOwners(id);
      break;
    case "financialAccount":
      owners = sql`ARRAY["FinancialAccount"."ledgerPartyId"]`;
      break;
    case "financialTransaction":
      owners = sql`ARRAY(SELECT account."ledgerPartyId" FROM "FinancialAccount" account WHERE account.id = "FinancialTransaction"."accountId" AND ${notDeleted(alias(financialAccount, "account"))})`;
      break;
    case "vendorAccount":
      owners = sql`ARRAY["VendorAccount"."ledgerPartyId"]`;
      break;
    case "email":
      owners = sql`ARRAY["Email"."ledgerPartyId"]`;
      break;
    default:
      return null;
  }
  // A missing private record or owner poisons the group, rather than making it shared.
  return sql`coalesce((SELECT CASE WHEN cardinality(authority.owners) > 0 THEN authority.owners ELSE ARRAY[NULL::uuid] END FROM ${table} CROSS JOIN LATERAL (SELECT ${owners} AS owners) authority WHERE ${scope}), ARRAY[NULL::uuid])`;
};

export const diagnosticWorkCandidates = (
  db: Database,
  source: WorkSource,
  entries: readonly {
    key: string;
    name: string;
    reason: string;
    refs: readonly ParsedShortcode[];
  }[],
) => {
  const queries = entries.map((entry) => {
    const relations = entry.refs.flatMap(
      (ref) => privateOwnerRelation(ref) ?? [],
    );
    return selectWorkCandidates(db, source, {
      entity: null,
      id: null,
      key: entry.key,
      name: sql`${entry.name}`,
      reason: entry.reason,
      reasonKeys: [source.reasons[0]!.key],
      owners: relations.length
        ? sql.join(relations, sql` || `)
        : sql`ARRAY[]::uuid[]`,
      shared: relations.length === 0,
    }).from(sql`(SELECT 1) diagnostic`);
  });
  return queries.length
    ? {
        query: sql.join(
          queries.map((query) => sql`(${query})`),
          sql` UNION ALL `,
        ),
      }
    : null;
};
