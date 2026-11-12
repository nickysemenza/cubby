import { entitySchema } from "@cubby/schemas/entity";
import {
  proposedImportFix,
  RUN_FINDING_ROUTING,
  type RunFindingRoutingKind,
} from "@cubby/schemas/purchase-import";
import { decisionExecutor, workExecutor } from "@cubby/schemas/work-queue";
import { isNull, and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import { textArrayParam } from "~/server/db/helpers/query";
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
const fixIntent = (kind: string) => {
  const intent = proposedImportFix.options.find(
    (option) => option.shape.kind.value === kind,
  );
  if (!intent)
    throw new Error(`Import fix ${kind} is missing from the contract`);
  return intent.shape.kind.value;
};
// oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- 'kind' is the stored fix's JSON discriminator property, not a vocabulary value.
const findingSources = sql`CASE WHEN finding."proposedFix"->>'kind' = ${fixIntent("relink_product")}
    THEN CASE WHEN finding."entityKind" = ${entitySchema.enum.expense}
      AND finding."proposedFix"->>'expenseId' = finding."entityId"::text
      THEN ${workExpenseSourceOwners(sql`finding."entityId"`)}
      ELSE ARRAY[NULL::uuid] END
    ELSE CASE finding."entityKind"
    WHEN ${entitySchema.enum.purchase} THEN ${workPurchaseOwners(sql`finding."entityId"`)}
    WHEN ${entitySchema.enum.expense} THEN ${workExpenseOwners(sql`finding."entityId"`)}
    WHEN ${entitySchema.enum.email} THEN ARRAY(SELECT e."ledgerPartyId" FROM "Email" e WHERE e.id = finding."entityId" AND ${notDeleted(alias(email, "e"))})
    ELSE ${workRunReviewOwners(sql`finding."runId"`)} END END`;

// SAFETY: the keys of a const object literal are exactly its key union.
const routingKinds = Object.keys(
  RUN_FINDING_ROUTING,
) as RunFindingRoutingKind[];
const sourceConflictFix = fixIntent("reconcile_source_order");
/**
 * The finding's routing kind. A source-order conflict and an Email relevance
 * conflict are filed as `other`; their fix and record tell them apart.
 */
// oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- 'kind' is the stored fix's JSON discriminator property, not a vocabulary value.
const routingKind = sql`CASE
    WHEN finding.kind = ${"other" satisfies RunFindingRoutingKind} AND finding."proposedFix"->>'kind' = ${sourceConflictFix} THEN ${"source_conflict" satisfies RunFindingRoutingKind}
    WHEN finding.kind = ${"other" satisfies RunFindingRoutingKind} AND finding."entityKind" = ${entitySchema.enum.email} THEN ${"relevance_conflict" satisfies RunFindingRoutingKind}
    WHEN finding.kind = ANY(${textArrayParam(routingKinds)}) THEN finding.kind
    ELSE ${"other" satisfies RunFindingRoutingKind} END`;
const memberKinds = routingKinds.filter(
  (kind) => decisionExecutor(RUN_FINDING_ROUTING[kind].decision) === "human",
);

/**
 * Each open finding is one item named by its kind. Member decisions go to
 * Needs you, the rest to the agent backlog. A Run's unresolved-targets finding
 * is no item: every Email it names is its own `email:import-gap` item.
 */
const source: WorkSource = {
  id: "finding",
  family: "finding",
  executor: "dynamic",
  entity: null,
  link: { kind: "record" },
  reasons: routingKinds.map((kind) => ({
    key: `finding:${kind}`,
    label: RUN_FINDING_ROUTING[kind].label,
  })),
  candidates: async (db, scope) => ({
    query: selectWorkCandidates(db, source, {
      entity: sql`identity.kind`,
      id: sql`identity.shortcode`,
      name: sql`finding.summary`,
      key: sql`'finding:' || finding.id::text`,
      executor: sql`CASE WHEN (${routingKind}) = ANY(${textArrayParam(memberKinds)}) THEN ${workExecutor.enum.human} ELSE ${workExecutor.enum.agent} END`,
      reason: sql`CASE (${routingKind}) ${sql.join(
        routingKinds.map(
          (kind) => sql`WHEN ${kind} THEN ${RUN_FINDING_ROUTING[kind].label}`,
        ),
        sql` `,
      )} END`,
      reasonKeys: sql`ARRAY['finding:' || (${routingKind})]`,
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
          sql`NOT (finding."entityKind" = ${entitySchema.enum.run} AND finding.kind = ${"unresolved_targets" satisfies RunFindingRoutingKind})`,
          scope.record
            ? sql`identity.kind = ${scope.record.entity} AND identity.shortcode = ${scope.record.id}`
            : undefined,
        ),
      ),
  }),
};
export const findingWorkSources = [source];
