import { entitySchema } from "@cubby/schemas/entity";
import { proposedImportFix } from "@cubby/schemas/purchase-import";
import { isNull, and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import { email, entityIdentity, runFinding } from "~/server/db/schema";
import {
  workExpenseSourceOwners,
  workExpenseOwners,
} from "~/server/domains/expense/repo/work-owners";
import { obsoleteExecutionFindingSql } from "~/server/domains/purchase-import/repo/run-retirement";
import { workPurchaseOwners } from "~/server/domains/purchase/repo/work-owners";
import { activeFindingSql } from "~/server/domains/run/repo/finding-expiry";
import { workRunReviewOwners } from "~/server/domains/run/repo/work-owners";
import { workRecordFacts } from "~/server/domains/work/repo/record-facts";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

const finding = alias(runFinding, "finding");
const identity = alias(entityIdentity, "identity");
const productRelinkIntent = proposedImportFix.options.find(
  (intent) => intent.shape.kind.value === "relink_product",
);
if (!productRelinkIntent)
  throw new Error("Product relink intent is missing from the import contract");
// oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- 'kind' is the stored fix's JSON discriminator property, not a vocabulary value.
const findingSources = sql`CASE WHEN finding."proposedFix"->>'kind' = ${productRelinkIntent.shape.kind.value}
    THEN CASE WHEN finding."entityKind" = ${entitySchema.enum.expense}
      AND finding."proposedFix"->>'expenseId' = finding."entityId"::text
      THEN ${workExpenseSourceOwners(sql`finding."entityId"`)}
      ELSE ARRAY[NULL::uuid] END
    ELSE CASE finding."entityKind"
    WHEN ${entitySchema.enum.purchase} THEN ${workPurchaseOwners(sql`finding."entityId"`)}
    WHEN ${entitySchema.enum.expense} THEN ${workExpenseOwners(sql`finding."entityId"`)}
    WHEN ${entitySchema.enum.email} THEN ARRAY(SELECT e."ledgerPartyId" FROM "Email" e WHERE e.id = finding."entityId" AND ${notDeleted(alias(email, "e"))})
    ELSE ${workRunReviewOwners(sql`finding."runId"`)} END END`;

const source: WorkSource = {
  id: "finding",
  family: "finding",
  executor: "human",
  entity: null,
  link: { kind: "record" },
  reasons: [{ key: "finding", label: "Finding" }],
  candidates: async (db, scope) => ({
    query: selectWorkCandidates(db, source, {
      entity: sql`identity.kind`,
      id: sql`identity.shortcode`,
      name: sql`finding.summary`,
      key: sql`'finding:' || finding.id::text`,
      reason: "Finding",
      reasonKeys: ["finding"],
      owners: sql`CASE WHEN cardinality(${findingSources}) > 0 AND NOT EXISTS (SELECT 1 FROM unnest(${findingSources}) owner WHERE owner IS NULL OR owner <> finding."ledgerPartyId") THEN ARRAY[finding."ledgerPartyId"] ELSE ARRAY[NULL::uuid] END`,
      exclusiveOwner: sql`finding."ledgerPartyId"`,
      ...workRecordFacts(sql`identity.kind`, sql`finding."entityId"`),
    })
      .from(finding)
      .innerJoin(
        identity,
        and(
          eq(identity.id, finding.entityId),
          eq(identity.kind, finding.entityKind),
          sql`${isNull(sql`identity."deletedAt"`)}`,
        ),
      )
      .where(
        and(
          activeFindingSql("finding"),
          sql`NOT ${obsoleteExecutionFindingSql("finding")}`,
          scope.record
            ? sql`identity.kind = ${scope.record.entity} AND identity.shortcode = ${scope.record.id}`
            : undefined,
        ),
      ),
  }),
};
export const findingWorkSources = [source];
