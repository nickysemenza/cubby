import { HOUSEHOLD_PROJECT_SHORTCODE } from "@cubby/schemas/project-fields";
import {
  workDiagnosticFacts,
  type WorkDiagnosticFacts,
} from "@cubby/schemas/work-diagnostic-facts";
import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import { notDeleted } from "~/server/db/helpers/predicates";
import { financialAccount } from "~/server/db/schema";
import { workExpenseOwners } from "~/server/domains/expense/repo/work-owners";
import { workPurchaseOwners } from "~/server/domains/purchase/repo/work-owners";
import { SHORTCODE_TABLE } from "~/server/generic/shortcode/repo/shortcode-tables";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";
type PrivateReference =
  WorkDiagnosticFacts["privateEntries"][string][number]["refs"][number];
const privateOwnerRelation = (ref: {
  type: PrivateReference["type"];
  shortcode: string | SQL;
}): SQL => {
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
    case "financialAccount":
      owners = sql`ARRAY["FinancialAccount"."ledgerPartyId"]`;
      break;
    case "financialTransaction":
      owners = sql`ARRAY(SELECT account."ledgerPartyId" FROM "FinancialAccount" account WHERE account.id = "FinancialTransaction"."accountId" AND ${notDeleted(alias(financialAccount, "account"))})`;
      break;
  }
  // A missing private record or owner poisons the group, rather than making it shared.
  return sql`coalesce((SELECT CASE WHEN cardinality(authority.owners) > 0 THEN authority.owners ELSE ARRAY[NULL::uuid] END FROM ${table} CROSS JOIN LATERAL (SELECT ${owners} AS owners) authority WHERE ${scope}), ARRAY[NULL::uuid])`;
};

/** One public diagnostic row represents its complete published reason count. */
export const diagnosticWorkCandidates = (
  db: Database,
  source: WorkSource,
  entry: { key: string; name: string; reason: string },
) => ({
  query: selectWorkCandidates(db, source, {
    entity: null,
    id: null,
    key: entry.key,
    name: sql`${entry.name}`,
    reason: entry.reason,
    reasonKeys: [source.id],
    owners: sql`ARRAY[]::uuid[]`,
    shared: true,
  }).from(sql`(SELECT 1) diagnostic`),
});

/** Stored private findings stay in SQL through current-owner filtering, totals, search and pagination. */
export const storedPrivateDiagnosticCandidates = (
  db: Database,
  source: WorkSource,
  publication: { id: string },
) => {
  const ownerCases = [
    "financialAccount",
    "financialTransaction",
    "expense",
    "purchase",
  ] as const;
  const referenceKeys =
    workDiagnosticFacts.shape.privateEntries.valueType.element.shape.refs.element.keyof()
      .enum;
  const owners = sql`ARRAY(
    SELECT owner FROM jsonb_array_elements(finding.refs) ref
    CROSS JOIN LATERAL unnest(CASE ${sql.join(
      ownerCases.map(
        (type) => sql`
      WHEN ref->>${referenceKeys.type} = ${type} THEN ${privateOwnerRelation({ type, shortcode: sql`ref->>${referenceKeys.shortcode}` })}`,
      ),
      sql` `,
    )}
      ELSE ARRAY[NULL::uuid] END) owner
  )`;
  return {
    query: selectWorkCandidates(db, source, {
      entity: null,
      id: null,
      key: sql`finding.key`,
      name: sql`finding.name`,
      reason: sql`finding.reason`,
      reasonKeys: [source.id],
      owners,
      shared: false,
    }).from(sql`"Project" anchor
      INNER JOIN "DerivedValue" publication ON publication."entityId" = anchor.id AND publication.key = 'workDiagnosticFacts'
      CROSS JOIN LATERAL jsonb_to_recordset(publication.value->'privateEntries'->${source.id})
        AS finding(key text, name text, reason text, refs jsonb)`)
      .where(sql`anchor.id = ${publication.id}::uuid AND anchor.shortcode = ${HOUSEHOLD_PROJECT_SHORTCODE}
        AND ${notDeleted("anchor")} AND publication."computedAt" IS NOT NULL
        AND publication."decidedBy"#>>'{outcome,kind}' = 'value'`),
  };
};
