import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentFamily,
  feedbackAuthority,
  feedbackVerdict,
} from "@cubby/schemas/assessment";
import type { ActorContext } from "@cubby/schemas/context";
import {
  dataCheck,
  dataCheckMessage,
  dataChecksByEntity,
  scoredEntities,
  type DataCheck,
  type ScoredEntity,
} from "@cubby/schemas/data-quality";
import { entityRefKey, entitySchema, type Entity } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import {
  financialTransactionStatus,
  financialTransactionKind,
  financialTransactionFiltersSchema,
} from "@cubby/schemas/financial-transaction";
import type { LedgerPartyId } from "@cubby/schemas/identifiers";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party";
import { normalizeSorts, oneOrManyValues } from "@cubby/schemas/pagination";
import { photoGroupProposalState } from "@cubby/schemas/photo-import-run";
import { productFiltersSchema } from "@cubby/schemas/product";
import {
  expenseFiltersSchema,
  type ProjectAttentionIncompleteIds,
} from "@cubby/schemas/project";
import { purchaseFiltersSchema } from "@cubby/schemas/purchase";
import { proposedImportFix } from "@cubby/schemas/purchase-import";
import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
import { vendorFiltersSchema } from "@cubby/schemas/vendor";
import {
  workExplanationSchema,
  workQueueGapChecks,
  workQueueGapViews,
  workQueueHouseholdInput,
  workQueueKindOptions,
  workQueueKindSchema,
  workQueueList,
  workQueueReasonLabels,
  workQueueRecordTypeOptions,
  workQueueSourceOptions,
  workQueueSourceSchema,
  workQueueSortSchema,
  workWaitingForSchema,
  workQueueOutSchema,
  type WorkQueueGap,
  type WorkQueueGroup,
  type WorkQueueRow,
} from "@cubby/schemas/work-queue";
import { CURRENT_MEMBER_FILTER, parseShortcode } from "@cubby/shared";
import { or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { problemQueryDeclarations } from "~/entity/problems/problem-registry";
import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { getDb, ilikeContains } from "~/server/db/helpers";
import { actualExpenseSql } from "~/server/db/helpers/predicates";
import { outer, quotedTable, related } from "~/server/db/helpers/related";
import {
  email,
  expense,
  financialTransaction,
  image,
  product,
  purchase,
  vendor,
  run as runTable,
  assessmentState as suggestionTable,
} from "~/server/db/schema";
import { buildEmailWhere } from "~/server/domains/email/repo/email";
import { buildExpenseWhereClause } from "~/server/domains/expense/repo/lookup";
import { buildFinancialTransactionWhere } from "~/server/domains/financial-transaction/repo/financial-transaction";
import { buildProductWhere } from "~/server/domains/product/repo/crud";
import {
  expectedQuantityReadSql,
  onHandUnitsReadSql,
} from "~/server/domains/product/repo/quantity-ledger";
import { activeFindingSql } from "~/server/domains/purchase-import/repo/finding-expiry";
import { obsoleteExecutionFindingSql } from "~/server/domains/purchase-import/repo/run-retirement";
import { buildPurchaseWhereClause } from "~/server/domains/purchase/repo/purchase";
import {
  awaitingPostingSql,
  purchasePostingStartSql,
  transactionPostingStartSql,
} from "~/server/domains/purchase/repo/settlement-grace";
import {
  pendingSuggestion,
  pendingStatementStateSql,
  suggestionField,
} from "~/server/domains/transaction-import/repo/statement-charge";
import { buildVendorWhereClause } from "~/server/domains/vendor/repo/vendor";
import { resolvePublicEntityDisplayImageLists } from "~/server/entity-kernel/repo/entity-display-image";
import { pendingImageDescriptionEligibility } from "~/server/generic/assessment/repo/review-families";
import { reviewableSuggestionSql } from "~/server/generic/assessment/repo/suggestion-review";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import type { QualityReadContext } from "~/server/generic/data-quality/repo/registry";
import {
  gapCondition,
  relatedGapCondition,
} from "~/server/generic/data-quality/repo/sql";
import { resolveLiveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { attentionStatePredicate } from "~/server/generic/work-queue/repo/work-attention";
import {
  NO_FACT_COLUMNS,
  scopeAdmitsUnrecorded,
  workQueueCandidate,
  workQueueAdmits,
  workRecordFactColumns,
  type WorkQueueScope,
} from "~/server/generic/work-queue/repo/work-queue-projection";
import {
  workImageOwners,
  workImageIsShared,
  workExpenseOwners,
  workExpenseSourceOwners,
  workPurchaseOwners,
  workPurchaseSourceOwners,
  workRunReviewOwners,
  workRunReviewRead,
} from "~/server/generic/work-queue/repo/work-queue-routing";
import {
  isStepRunPurpose,
  EXECUTED_RUN_PURPOSES,
} from "~/server/workflows/runs/contract";

import { loadWorkContexts } from "./work-context";
import { projectWorkExplanations } from "./work-explanation";
import { workExecutorSql } from "./work-routing";

const either = workWaitingForSchema.options[0].shape.kind.value;
const members = workWaitingForSchema.options[1].shape.kind.value;
const unresolved = workWaitingForSchema.options[2].shape.kind.value;

type QueueInput = z.infer<typeof workQueueHouseholdInput>;
const optionLabel = (
  column: SQL,
  options: readonly { value: string; label: string }[],
) =>
  sql`CASE ${column} ${sql.join(
    options.map(({ value, label }) => sql`WHEN ${value} THEN ${label}`),
    sql` `,
  )} END`;
const vendorColumn = (column: "shortcode" | "name") =>
  sql`(SELECT v.${sql.identifier(column)} FROM "Vendor" v WHERE v.id = eligible.vendor_id AND v."deletedAt" IS NULL)`;
const ownerColumn = (column: "shortcode" | "name") =>
  sql`(SELECT string_agg(member.${sql.identifier(column)}, ', ' ORDER BY member.${sql.identifier(column)}) FROM members member WHERE member.id = ANY(eligible.owners))`;
/** Each choice's section key is the value its declared filter selects (a
 * record type, `either`, a source, a vendor code); a null key is the choice's
 * no-value section. Several members' work is one section keyed by their codes. */
const GROUP_SECTIONS = {
  recordType: {
    key: sql`entity`,
    label: optionLabel(sql`entity`, workQueueRecordTypeOptions),
  },
  waitingFor: {
    key: sql`CASE waiting_kind WHEN ${either} THEN ${either}::text WHEN ${members} THEN ${ownerColumn("shortcode")} END`,
    label: sql`CASE waiting_kind WHEN ${either} THEN 'Either' WHEN ${members} THEN ${ownerColumn("name")} END`,
  },
  source: {
    key: sql`source`,
    label: optionLabel(sql`source`, workQueueSourceOptions),
  },
  kind: { key: sql`kind`, label: optionLabel(sql`kind`, workQueueKindOptions) },
  vendor: { key: vendorColumn("shortcode"), label: vendorColumn("name") },
  nextAction: {
    key: sql`nullif("nextAction", '')`,
    label: sql`nullif("nextAction", '')`,
  },
} satisfies Record<WorkQueueGroup, { key: SQL; label: SQL }>;
type Candidate = Pick<WorkQueueRow, "source" | "kind" | "nextAction"> & {
  reason: string | SQL;
};

const viewFilters = (entity: Entity, id: string) => {
  const view = entitySummary[entity].list.savedViews.find(
    (view) => view.id === id,
  );
  if (!view)
    throw new Error(`Work queue saved view ${entity}.${id} is missing`);
  return compileProblemFilters(entity, view.filters);
};

/** A gap view's filters narrowed to the scope's checks, or null when none of
 * its checks remain: an empty `dataGap` list would widen the view instead. */
const gapViewFilters = (
  scope: WorkQueueScope,
  entity: (typeof workQueueGapViews)[number]["entity"],
) => {
  const gapView = workQueueGapViews.find((view) => view.entity === entity);
  if (!gapView) throw new Error(`Work queue has no gap view for ${entity}`);
  const filters = viewFilters(entity, gapView.view);
  if (scope.record?.entity === entity && scope.record.quality) {
    const checks = new Set<string>(
      workQueueGapChecks(gapView).filter(
        (check) => !scope.gapChecks || scope.gapChecks.includes(check),
      ),
    );
    const quality = scope.record.quality;
    const missing = [...quality.gaps, ...quality.relatedGaps].some((gap) =>
      checks.has(gap.check),
    );
    // Record strips use current evidence for both admission and counts. Broad
    // queues retain indexed published predicates; this read publishes nothing.
    return missing ? { ...filters, dataGap: undefined } : null;
  }
  if (!scope.reasons?.length && !scope.gapChecks) return filters;
  const requested = new Set(scope.reasons ?? scope.gapChecks);
  const checks = workQueueGapChecks(gapView).filter((check) =>
    requested.has(check),
  );
  return checks.length > 0 ? { ...filters, dataGap: checks } : null;
};

/** A gap row's reason as `stateRowQuality` displays it, for search: its live
 * own gap messages in check order, then its related records' (a view may list
 * a related entity's check), deduplicated, else the branch's fallback. */
const gapReasonSql = (
  entity: (typeof workQueueGapViews)[number]["entity"],
  fallback: string,
): SQL => {
  const gapView = workQueueGapViews.find((view) => view.entity === entity);
  if (!gapView) throw new Error(`Work queue has no gap view for ${entity}`);
  const viewChecks = workQueueGapChecks(gapView);
  const own = new Set<DataCheck>(dataChecksByEntity[entity].options);
  const byMessage = new Map<string, SQL[]>();
  for (const check of [
    ...dataChecksByEntity[entity].options.filter((check) =>
      viewChecks.includes(check),
    ),
    ...viewChecks.filter((check) => !own.has(check)),
  ]) {
    const message = dataCheckMessage[check];
    byMessage.set(message, [
      ...(byMessage.get(message) ?? []),
      own.has(check)
        ? gapCondition(entity, check)
        : relatedGapCondition(entity, check),
    ]);
  }
  const parts = [...byMessage].map(
    ([message, conditions]) =>
      sql`CASE WHEN ${sql.join(conditions, sql` OR `)} THEN ${message}::text END`,
  );
  return parts.length
    ? sql`coalesce(nullif(concat_ws(' ', ${sql.join(parts, sql`, `)}), ''), ${fallback}::text)`
    : sql`${fallback}::text`;
};

const gapReasonKeys = (
  scope: WorkQueueScope,
  entity: (typeof workQueueGapViews)[number]["entity"],
): SQL => {
  const view = workQueueGapViews.find((view) => view.entity === entity);
  if (!view) throw new Error(`Work queue has no gap view for ${entity}`);
  const checks = workQueueGapChecks(view).filter((check) =>
    scope.reasonChecks?.includes(check),
  );
  if (!checks.length) return sql`ARRAY[]::text[]`;
  const own = new Set<DataCheck>(dataChecksByEntity[entity].options);
  return sql`array_remove(ARRAY[${sql.join(
    checks.map(
      (check) =>
        sql`CASE WHEN ${own.has(check) ? gapCondition(entity, check) : relatedGapCondition(entity, check)} THEN ${check}::text END`,
    ),
    sql`, `,
  )}], NULL)`;
};

/** One read-only relation, shared by household routing and member eligibility. */
/** Diagnostic-backed queue branches; supplied by `service/work-queue-read`. */
export type WorkProblemSelections = (
  db: Database,
  scope: WorkQueueScope,
  readContexts?: Partial<Record<Entity, QualityReadContext>>,
) => Promise<{
  selections: SQL[];
  incompleteProjectIds: ProjectAttentionIncompleteIds;
}>;

// oxlint-disable-next-line complexity -- Source branches share one exact-count population and must reject excluded work before preparing it.
async function workQueueProjection(
  db: Database,
  scope: WorkQueueScope,
  problemSelections: WorkProblemSelections,
  readContexts: Partial<Record<Entity, QualityReadContext>>,
  searched: boolean,
): Promise<{
  relation: SQL;
  incompleteProjectIds: ProjectAttentionIncompleteIds;
}> {
  const selections: SQL[] = [];
  const branch = (
    source: WorkQueueRow["source"],
    kinds: readonly WorkQueueRow["kind"][],
    ...reasons: string[]
  ) => workQueueAdmits(scope, { source, kinds, reasons });
  // A grouped suggestion has only counts in its dynamic text. For a search
  // without digits, representative singular/plural counts preserve every
  // possible match and can reject the branch before reading its evidence.
  // Record groups have dynamic titles; the final predicate handles those.
  const aggregateSearch = (
    name: string,
    reasons: readonly string[],
    nextAction: string,
  ): SQL => {
    const query = scope.query;
    if (!query || scope.record || /[0-9]/.test(query)) return sql`true`;
    return sql`(${sql.join(
      reasons.map(
        (reason) =>
          sql`concat_ws(' ', ${name}::text, ${reason}::text, ${nextAction}::text) ILIKE ${ilikeContains(query)}`,
      ),
      sql` OR `,
    )})`;
  };
  if (
    !scope.gapChecks &&
    branch("suggestion", ["review"], "suggestions:recommendation")
  ) {
    // Background retirement maintains pending state. Reads never rebuild the
    // population's evidence; application still revalidates inside its transaction.
    const target = (field: "entityId" | "entityKind") =>
      sql`prediction.target->>${field}`;
    const touches = scope.record
      ? sql`AND ((root.kind=${scope.record.entity} AND root.shortcode=${scope.record.id})
          OR (${target("entityKind")}=${scope.record.entity} AND ${target("entityId")}=${scope.record.id}))`
      : sql``;
    const reviewable = sql`current.family = ${assessmentFamily.enum.recommendation} AND current.active AND current.status = ${suggestionStatus.enum.pending}
        AND prediction.subject->>'scope' LIKE 'connection.%'
        AND root."deletedAt" IS NULL AND root."mergedIntoId" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "Feedback" reviewed WHERE reviewed."assessmentId" = prediction.id
          AND reviewed.authority = ${feedbackAuthority.enum.member} AND reviewed.verdict IN (${feedbackVerdict.enum.wrong}, ${feedbackVerdict.enum.dismissed}))
        AND NOT EXISTS (SELECT 1 FROM "AssessmentState" hidden WHERE hidden.active AND hidden.entity = current.entity
          AND hidden."recordId" = current."recordId" AND hidden.suppression->>'scope' = prediction.subject->>'scope'
          AND hidden.suppression->>'candidateKey' = prediction.subject->>'candidateKey'
          AND (hidden.suppression->>'fingerprint' IS NULL OR hidden.suppression->>'fingerprint' = prediction.fingerprint))
        AND EXISTS (SELECT 1 FROM "Entity" other WHERE other.shortcode = ${target("entityId")}
          AND other.kind = ${target("entityKind")} AND other."deletedAt" IS NULL AND other."mergedIntoId" IS NULL)`;
    if (scope.record) {
      const { entity, id } = scope.record;
      selections.push(sql`SELECT ${entity}::text AS entity, ${id}::text AS id,
      coalesce(max(document.title), ${id})::text AS name,
      'connection:' || ${id}::text AS key, ${workQueueSourceSchema.enum.suggestion}::text AS source, ${workQueueKindSchema.enum.review}::text AS kind,
      count(*)::text || CASE WHEN count(*) = 1 THEN ' pending connection suggestion' ELSE ' pending connection suggestions' END AS reason,
      'Review the proposed connections and their evidence on the Suggestions page.'::text AS "nextAction",
      ARRAY[]::uuid[] AS owners, true AS shared, NULL::text AS "problemKey", ARRAY[${"suggestions:recommendation"}::text] AS reason_keys, ${NO_FACT_COLUMNS}
      FROM "AssessmentState" current
      JOIN work_connection_prediction prediction ON prediction.id = current.id
      JOIN "Entity" root ON root.id = current."recordId" AND root.kind = current.entity
      LEFT JOIN "Entity" self ON self.kind = ${entity} AND self.shortcode = ${id}
      LEFT JOIN "SearchDocument" document ON document."entityId" = self.id AND document."entityKind" = self.kind AND document."deletedAt" IS NULL
      WHERE ${reviewable} ${touches}
      HAVING count(*) > 0`);
    } else
      selections.push(sql`SELECT NULL::text AS entity, NULL::text AS id,
      'Connection suggestions'::text AS name,
      'suggestions:' || ${assessmentFamily.enum.recommendation}::text AS key, ${workQueueSourceSchema.enum.suggestion}::text AS source, ${workQueueKindSchema.enum.review}::text AS kind,
      count(*)::text || CASE WHEN count(*) = 1 THEN ' pending connection suggestion' ELSE ' pending connection suggestions' END AS reason,
      'Review them on the Suggestions page.'::text AS "nextAction",
      ARRAY[]::uuid[] AS owners, true AS shared, NULL::text AS "problemKey", ARRAY[${"suggestions:recommendation"}::text] AS reason_keys, ${NO_FACT_COLUMNS}
      FROM "AssessmentState" current
      JOIN work_connection_prediction prediction ON prediction.id = current.id
      JOIN "Entity" root ON root.id = current."recordId" AND root.kind = current.entity
      WHERE ${reviewable} AND ${aggregateSearch("Connection suggestions", ["1 pending connection suggestion", "0 pending connection suggestions"], "Review them on the Suggestions page.")}
      HAVING count(*) > 0`);
  }
  // Skips building a branch the scope would drop anyway.
  const admits = (entity: Entity, carriesGaps = false) =>
    (!scope.gapChecks || carriesGaps) &&
    (!scope.record || scope.record.entity === entity);
  // Search runs before paging, so a searched gap row states its displayed
  // reason here; otherwise `stateRowQuality` fills it for the page alone.
  const gapReason = (
    entity: (typeof workQueueGapViews)[number]["entity"],
    fallback: string,
  ) => (searched ? gapReasonSql(entity, fallback) : fallback);
  const research = (entity: (typeof workQueueGapViews)[number]["entity"]) =>
    ({
      source: "research",
      kind: "research",
      reason: gapReason(entity, "Research queue"),
      nextAction: "Review missing facts and add verified evidence.",
    }) satisfies Candidate;
  const researchAdmitted = branch(
    "research",
    ["research"],
    ...workQueueGapViews
      .filter((view) => view.source === "research")
      .flatMap(workQueueGapChecks),
  );
  const productGaps = researchAdmitted
    ? gapViewFilters(scope, "product")
    : null;
  if (productGaps && admits("product", true))
    selections.push(
      ...workQueueCandidate(scope, {
        entity: "product",
        table: sql`${product}`,
        id: sql`"Product".shortcode`,
        name: sql`"Product".name`,
        owners: sql`ARRAY[]::uuid[]`,
        where: await buildProductWhere(
          db,
          productFiltersSchema.parse(productGaps),
        ),
        details: research("product"),
        key: "research:product",
        reasonKeys: gapReasonKeys(scope, "product"),
        shared: true,
        carriesGaps: true,
      }),
    );
  const vendorGaps = researchAdmitted ? gapViewFilters(scope, "vendor") : null;
  if (vendorGaps && admits("vendor", true))
    selections.push(
      ...workQueueCandidate(scope, {
        entity: "vendor",
        table: sql`${vendor}`,
        id: sql`"Vendor".shortcode`,
        name: sql`"Vendor".name`,
        owners: sql`ARRAY[]::uuid[]`,
        where: buildVendorWhereClause(vendorFiltersSchema.parse(vendorGaps)),
        details: research("vendor"),
        key: "research:vendor",
        reasonKeys: gapReasonKeys(scope, "vendor"),
        shared: true,
        carriesGaps: true,
      }),
    );
  const purchaseGaps = researchAdmitted
    ? gapViewFilters(scope, "purchase")
    : null;
  if (purchaseGaps && admits("purchase", true))
    selections.push(
      ...workQueueCandidate(scope, {
        entity: "purchase",
        table: sql`${purchase}`,
        id: sql`"Purchase".shortcode`,
        name: sql`coalesce("Purchase"."displayLabel", "Purchase"."orderId", 'Purchase')`,
        owners: workPurchaseSourceOwners(sql`"Purchase".id`),
        where: buildPurchaseWhereClause(
          purchaseFiltersSchema.parse(purchaseGaps),
        ),
        details: research("purchase"),
        key: "research:purchase",
        reasonKeys: gapReasonKeys(scope, "purchase"),
        carriesGaps: true,
      }),
    );
  const expenseGaps = researchAdmitted
    ? gapViewFilters(scope, "expense")
    : null;
  if (expenseGaps && admits("expense", true))
    selections.push(
      ...workQueueCandidate(scope, {
        entity: "expense",
        table: sql`${expense}`,
        id: sql`"Expense".shortcode`,
        name: sql`"Expense".name`,
        owners: workExpenseSourceOwners(sql`"Expense".id`),
        where: await buildExpenseWhereClause(
          db,
          expenseFiltersSchema.parse(expenseGaps),
        ),
        details: research("expense"),
        key: "research:expense",
        reasonKeys: gapReasonKeys(scope, "expense"),
        carriesGaps: true,
      }),
    );
  const emailGaps = branch(
    "email",
    ["review"],
    ...workQueueGapViews
      .filter((view) => view.entity === "email")
      .flatMap(workQueueGapChecks),
  )
    ? gapViewFilters(scope, "email")
    : null;
  if (emailGaps && admits("email", true))
    selections.push(
      ...workQueueCandidate(scope, {
        entity: "email",
        table: sql`${email}`,
        id: sql`"Email".shortcode`,
        name: sql`coalesce("Email".subject, 'Email')`,
        owners: sql`ARRAY["Email"."ledgerPartyId"]`,
        where: buildEmailWhere(emailGaps),
        details: {
          source: "email",
          kind: "review",
          reason: gapReason("email", "Email pipeline gap"),
          nextAction: "Review relevance, retained original and import status.",
        },
        key: "email",
        reasonKeys: gapReasonKeys(scope, "email"),
        carriesGaps: true,
      }),
    );
  if (
    scopeAdmitsUnrecorded(scope) &&
    branch("suggestion", ["review"], "suggestions:statement_transaction")
  )
    selections.push(sql`SELECT NULL::text AS entity, NULL::text AS id,
    'Transaction suggestions'::text AS name,
    'suggestions:' || ${assessmentFamily.enum.statement_transaction}::text AS key,
    ${workQueueSourceSchema.enum.suggestion}::text AS source, ${workQueueKindSchema.enum.review}::text AS kind,
    count(*)::text || CASE WHEN count(*) = 1 THEN ' transaction suggestion' ELSE ' transaction suggestions' END
      || ' (' || count(*) FILTER (WHERE (${suggestionField("clean")})::boolean) || ' ready to accept)' AS reason,
    'Review them on the Suggestions page; accept the clean ones as a group.'::text AS "nextAction",
    ARRAY[]::uuid[] AS owners, true AS shared, NULL::text AS "problemKey", ARRAY[${"suggestions:statement_transaction"}::text] AS reason_keys, ${NO_FACT_COLUMNS}
    FROM work_statement_state s WHERE ${pendingSuggestion("s", { populationRead: true })}
      AND ${aggregateSearch("Transaction suggestions", ["1 transaction suggestion (0 ready to accept)", "0 transaction suggestions (0 ready to accept)"], "Review them on the Suggestions page; accept the clean ones as a group.")}
    HAVING count(*) > 0`);
  if (
    scopeAdmitsUnrecorded(scope) &&
    branch("suggestion", ["review"], "suggestions:transfer_pair")
  )
    selections.push(sql`SELECT NULL::text AS entity, NULL::text AS id,
    'Transfer-pair suggestions'::text AS name,
    'suggestions:' || ${assessmentFamily.enum.transfer_pair}::text AS key,
    ${workQueueSourceSchema.enum.suggestion}::text AS source, ${workQueueKindSchema.enum.review}::text AS kind,
    count(*)::text || CASE WHEN count(*) = 1 THEN ' transfer pair' ELSE ' transfer pairs' END
      || ' (' || count(*) FILTER (WHERE (s.data->>'clean')::boolean) || ' ready to accept)' AS reason,
    'Review both legs and owners on the Suggestions page.'::text AS "nextAction",
    ARRAY[]::uuid[] AS owners, true AS shared, NULL::text AS "problemKey", ARRAY[${"suggestions:transfer_pair"}::text] AS reason_keys, ${NO_FACT_COLUMNS}
    FROM "AssessmentState" s WHERE s.family = ${assessmentFamily.enum.transfer_pair}
      AND s.active AND s.status = ${suggestionStatus.enum.pending}
      AND ${aggregateSearch("Transfer-pair suggestions", ["1 transfer pair (0 ready to accept)", "0 transfer pairs (0 ready to accept)"], "Review both legs and owners on the Suggestions page.")}
    HAVING count(*) > 0`);
  if (admits("image") && branch("suggestion", ["review"], "image-suggestions"))
    selections.push(
      ...workQueueCandidate(scope, {
        entity: "image",
        table: sql`${image} CROSS JOIN LATERAL (
          SELECT count(*)::int AS total FROM "Assessment" a
          JOIN "AssessmentState" s ON s.id = a.id
          WHERE s."recordId" = "Image".id AND ${pendingImageDescriptionEligibility()}
        ) descriptions`,
        id: sql`"Image".shortcode`,
        name: sql`"Image".filename`,
        owners: workImageOwners(sql`"Image".id`),
        shared: workImageIsShared(sql`"Image".id`),
        where: sql`"Image"."deletedAt" IS NULL AND descriptions.total > 0`,
        details: {
          source: "suggestion",
          kind: "review",
          reason: sql`descriptions.total || CASE WHEN descriptions.total = 1 THEN ' pending image description' ELSE ' pending image descriptions' END`,
          nextAction:
            "Open this image's Suggestions for current evidence and any held correction reason.",
        },
        key: "image-suggestions",
      }),
    );
  // One row for the whole family, never one per Suggestion: the Suggestions
  // page is where each is reviewed. A record's own Work counts its own.
  if (
    (scopeAdmitsUnrecorded(scope) || (scope.record && !scope.gapChecks)) &&
    branch("suggestion", ["review"], "suggestions:field")
  ) {
    const own = scope.record
      ? sql`AND ${suggestionTable.entity} = ${scope.record.entity} AND ${suggestionTable.recordId} = (
          SELECT self.id FROM "Entity" self WHERE self.kind = ${scope.record.entity} AND self.shortcode = ${scope.record.id})`
      : sql``;
    selections.push(sql`SELECT ${scope.record ? sql`${scope.record.entity}::text` : sql`NULL::text`} AS entity,
    ${scope.record ? sql`${scope.record.id}::text` : sql`NULL::text`} AS id,
    'Field suggestions'::text AS name,
    ${scope.record ? sql`'field-suggestions:' || ${scope.record.id}::text` : sql`'suggestions:' || ${assessmentFamily.enum.field}::text`} AS key,
    ${workQueueSourceSchema.enum.suggestion}::text AS source, ${workQueueKindSchema.enum.review}::text AS kind,
    count(*)::text || CASE WHEN count(*) = 1 THEN ' pending field suggestion' ELSE ' pending field suggestions' END AS reason,
    'Review them on the Suggestions page.'::text AS "nextAction",
    ARRAY[]::uuid[] AS owners, true AS shared, NULL::text AS "problemKey", ARRAY[${"suggestions:field"}::text] AS reason_keys, ${NO_FACT_COLUMNS}
    FROM ${suggestionTable} LEFT JOIN ${runTable} ON ${runTable.id} = ${suggestionTable.runId}
    WHERE ${suggestionTable.active} AND ${suggestionTable.status} = ${suggestionStatus.enum.pending} AND ${suggestionTable.family} = ${assessmentFamily.enum.field} AND ${reviewableSuggestionSql}
      ${own} AND ${aggregateSearch("Field suggestions", ["1 pending field suggestion", "0 pending field suggestions"], "Review them on the Suggestions page.")}
    HAVING count(*) > 0`);
  }

  // The declared unsettled view owns missing payment evidence. Receipt
  // research remains independent; settlement authority includes every tender.
  if (
    admits("purchase") &&
    branch(
      "reconciliation",
      ["repair", "awaiting_posting"],
      "reconciliation:purchase-unsettled",
      "awaiting_posting:reconciliation:purchase-unsettled",
    )
  ) {
    const deferred = awaitingPostingSql(
      purchasePostingStartSql(quotedTable(purchase)),
    );
    selections.push(
      ...workQueueCandidate(scope, {
        entity: "purchase",
        table: sql`${purchase}`,
        id: sql`"Purchase".shortcode`,
        name: sql`coalesce("Purchase"."displayLabel", "Purchase"."orderId", 'Purchase')`,
        owners: workPurchaseOwners(sql`"Purchase".id`),
        where: sql`(${buildPurchaseWhereClause(purchaseFiltersSchema.parse(viewFilters("purchase", "unsettled")))})
        AND NOT (${gapCondition("purchase", "settlement_mismatch")})`,
        details: {
          source: "reconciliation",
          kind: sql`CASE WHEN ${deferred} THEN ${workQueueKindSchema.enum.awaiting_posting} ELSE ${workQueueKindSchema.enum.repair} END`,
          reason: sql`CASE WHEN ${deferred} THEN ${workQueueReasonLabels["awaiting_posting:reconciliation:purchase-unsettled"]} ELSE ${workQueueReasonLabels["reconciliation:purchase-unsettled"]} END`,
          nextAction: sql`CASE WHEN ${deferred} THEN 'Wait through two complete business days for settlement evidence.' ELSE 'Investigate missing settlement against source coverage; do not infer a missing charge.' END`,
        },
        key: "reconciliation:purchase-unsettled",
        reasonKeys: sql`ARRAY[CASE WHEN ${deferred} THEN ${"awaiting_posting:reconciliation:purchase-unsettled"} ELSE ${"reconciliation:purchase-unsettled"} END]`,
      }),
    );
  }

  for (const definition of problemQueryDeclarations()) {
    const source = definition.source;
    if (
      source.kind !== "entity" ||
      !["purchase", "expense", "financialTransaction"].includes(
        source.entity,
      ) ||
      !admits(source.entity) ||
      !branch(
        "reconciliation",
        ["repair", "awaiting_posting"],
        definition.key,
        "awaiting_posting:" + definition.key,
      )
    )
      continue;
    const details = {
      source: "reconciliation",
      kind: "repair",
      reason: definition.title,
      nextAction: definition.description,
    } satisfies Candidate;
    const filters = compileProblemFilters(source.entity, source.filters);
    const deferred =
      definition.key === "purchaseFinancialSettlementMismatches"
        ? awaitingPostingSql(purchasePostingStartSql(quotedTable(purchase)))
        : null;
    const settlementDetails = deferred
      ? {
          ...details,
          kind: sql`CASE WHEN ${deferred} THEN ${workQueueKindSchema.enum.awaiting_posting} ELSE ${details.kind} END`,
          reason: sql`CASE WHEN ${deferred} THEN ${workQueueReasonLabels["awaiting_posting:purchaseFinancialSettlementMismatches"]} ELSE ${details.reason} END`,
          nextAction: sql`CASE WHEN ${deferred} THEN 'Wait two business days for remaining posting evidence.' ELSE ${details.nextAction} END`,
        }
      : details;
    if (source.entity === "purchase")
      selections.push(
        ...workQueueCandidate(scope, {
          entity: "purchase",
          table: sql`${purchase}`,
          id: sql`"Purchase".shortcode`,
          name: sql`coalesce("Purchase"."displayLabel", "Purchase"."orderId", 'Purchase')`,
          owners: workPurchaseOwners(sql`"Purchase".id`),
          where: buildPurchaseWhereClause(purchaseFiltersSchema.parse(filters)),
          details: settlementDetails,
          key: definition.key,
          reasonKeys: sql`ARRAY[${deferred ? sql`CASE WHEN ${deferred} THEN ${"awaiting_posting:" + definition.key} ELSE ${definition.key} END` : sql`${definition.key}::text`}]`,
        }),
      );
    else if (source.entity === "expense")
      selections.push(
        ...workQueueCandidate(scope, {
          entity: "expense",
          table: sql`${expense}`,
          id: sql`"Expense".shortcode`,
          name: sql`"Expense".name`,
          owners: workExpenseOwners(sql`"Expense".id`),
          where: await buildExpenseWhereClause(
            db,
            expenseFiltersSchema.parse(filters),
          ),
          details: settlementDetails,
          key: definition.key,
          reasonKeys: sql`ARRAY[${deferred ? sql`CASE WHEN ${deferred} THEN ${"awaiting_posting:" + definition.key} ELSE ${definition.key} END` : sql`${definition.key}::text`}]`,
        }),
      );
    else
      selections.push(
        ...workQueueCandidate(scope, {
          entity: "financialTransaction",
          table: sql`${financialTransaction}`,
          id: sql`"FinancialTransaction".shortcode`,
          name: sql`coalesce("FinancialTransaction".merchant, "FinancialTransaction"."rawDescription", 'Financial transaction')`,
          owners: sql`ARRAY(SELECT account."ledgerPartyId" FROM "FinancialAccount" account WHERE account.id = "FinancialTransaction"."accountId" AND account."deletedAt" IS NULL)`,
          where: await buildFinancialTransactionWhere(
            db,
            financialTransactionFiltersSchema.parse(filters),
          ),
          details: settlementDetails,
          key: definition.key,
          reasonKeys: sql`ARRAY[${deferred ? sql`CASE WHEN ${deferred} THEN ${"awaiting_posting:" + definition.key} ELSE ${definition.key} END` : sql`${definition.key}::text`}]`,
        }),
      );
  }
  if (branch("execution", ["repair"], "execution:run"))
    selections.push(
      ...workQueueCandidate(scope, {
        entity: "run",
        ...workRunReviewRead(),
        id: sql`"Run".shortcode`,
        name: sql`"Run".purpose || ' · ' || "Run".status`,
        // A funding-stopped predecessor whose work moved to a retry successor
        // is no longer waiting; the successor carries the execution.
        where: sql`"Run"."deletedAt" IS NULL AND (("Run".status = ${runStatus.enum.running} AND ("Run".purpose IN (${sql.join(
          // A running maintenance pass or Sweep is not member work; its failed
          // or stalled outcomes still surface through the failure paths.
          EXECUTED_RUN_PURPOSES.filter(
            (purpose) => !isStepRunPurpose(purpose),
          ).map((purpose) => sql`${purpose}`),
          sql`, `,
        )}) OR "Run"."dispatchEventId" IS NOT NULL)) OR ("Run".status = ${runStatus.enum.needs_review} AND "Run"."failureCode" IN ('execution_limit') AND NOT ${related(
          runTable,
          (successor) =>
            sql`${successor.predecessorRunId} = ${outer(runTable.id)}`,
          // The work moved even to a deleted successor.
          { includeDeleted: true },
        ).exists()}))`,
        details: {
          source: "execution",
          kind: "repair",
          reason: workQueueReasonLabels["execution:run"],
          nextAction:
            "Inspect current progress and retained execution evidence.",
        },
        key: "execution:run",
      }),
    );
  // An account's own Work counts its Transaction suggestions; the global
  // view has one row for the family, below.
  if (
    scope.record &&
    branch("suggestion", ["review"], "suggestions:statement_transaction")
  )
    selections.push(
      ...workQueueCandidate(scope, {
        entity: "financialAccount",
        table: sql`"FinancialAccount" JOIN (
        SELECT (${suggestionField("accountId")})::uuid AS account,
          count(*)::int AS total,
          count(*) FILTER (WHERE (${suggestionField("clean")})::boolean)::int AS clean
        FROM work_statement_state s WHERE ${pendingSuggestion("s", { populationRead: true })}
        GROUP BY 1
      ) statement_suggestions ON statement_suggestions.account = "FinancialAccount".id`,
        id: sql`"FinancialAccount".shortcode`,
        name: sql`"FinancialAccount".name`,
        owners: sql`ARRAY["FinancialAccount"."ledgerPartyId"]`,
        where: sql`"FinancialAccount"."deletedAt" IS NULL`,
        details: {
          source: "suggestion",
          kind: "review",
          reason: sql`statement_suggestions.total || CASE WHEN statement_suggestions.total = 1 THEN ' transaction suggestion' ELSE ' transaction suggestions' END || ' (' || statement_suggestions.clean || ' ready to accept)'`,
          nextAction:
            "Review this account's Transaction suggestions on the Suggestions page; accept the clean ones as a group.",
        },
        key: "statement_suggestion",
        reasonKeys: sql`ARRAY[${"suggestions:statement_transaction"}::text]`,
      }),
    );

  if (
    admits("financialTransaction") &&
    branch(
      "reconciliation",
      ["repair", "awaiting_posting"],
      "reconciliation:transfer",
      "awaiting_posting:reconciliation:transfer",
    )
  ) {
    const deferred = awaitingPostingSql(
      transactionPostingStartSql(quotedTable(financialTransaction)),
    );
    selections.push(
      ...workQueueCandidate(scope, {
        entity: "financialTransaction",
        table: sql`${financialTransaction}`,
        id: sql`"FinancialTransaction".shortcode`,
        name: sql`coalesce("FinancialTransaction".merchant, "FinancialTransaction"."rawDescription", 'Account transfer')`,
        owners: sql`ARRAY(SELECT account."ledgerPartyId" FROM "FinancialAccount" account WHERE account.id = "FinancialTransaction"."accountId" AND account."deletedAt" IS NULL)`,
        where: sql`"FinancialTransaction"."deletedAt" IS NULL AND "FinancialTransaction".status <> ${financialTransactionStatus.enum.void}
        AND "FinancialTransaction".kind = ${financialTransactionKind.enum.account_transfer} AND "FinancialTransaction"."ledgerTransferId" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "FinancialTransactionAllocation" allocation WHERE allocation."transactionId" = "FinancialTransaction".id AND allocation."deletedAt" IS NULL)`,
        details: {
          source: "reconciliation",
          kind: sql`CASE WHEN ${deferred} THEN ${workQueueKindSchema.enum.awaiting_posting} ELSE ${workQueueKindSchema.enum.repair} END`,
          reason: sql`CASE WHEN ${deferred} THEN ${workQueueReasonLabels["awaiting_posting:reconciliation:transfer"]} ELSE ${workQueueReasonLabels["reconciliation:transfer"]} END`,
          nextAction: sql`CASE WHEN ${deferred} THEN 'Wait two business days for the counterpart to post.' ELSE 'Review transfer pairing candidates and confirm the transfer from evidence.' END`,
        },
        key: "reconciliation:transfer",
        reasonKeys: sql`ARRAY[CASE WHEN ${deferred} THEN ${"awaiting_posting:reconciliation:transfer"} ELSE ${"reconciliation:transfer"} END]`,
      }),
    );
  }

  // Findings retain their owning member fence. Expired findings are omitted without dismissing them on a read.
  // The typed product-relink intent needs original item evidence; financial corrections retain combined authority.
  const productRelinkIntent = proposedImportFix.options.find(
    (intent) => intent.shape.kind.value === "relink_product",
  );
  if (!productRelinkIntent)
    throw new Error(
      "Product relink intent is missing from the import contract",
    );
  // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- 'kind' is the stored fix's JSON discriminator property, not a vocabulary value.
  const findingSources = sql`CASE WHEN finding.data->'proposedFix'->>'kind' = ${productRelinkIntent.shape.kind.value}
    THEN CASE WHEN finding.entity = ${entitySchema.enum.expense}
      AND finding.data->'proposedFix'->>'expenseId' = finding."recordId"::text
      THEN ${workExpenseSourceOwners(sql`finding."recordId"`)}
      ELSE ARRAY[NULL::uuid] END
    ELSE CASE finding.entity
    WHEN ${entitySchema.enum.purchase} THEN ${workPurchaseOwners(sql`finding."recordId"`)}
    WHEN ${entitySchema.enum.expense} THEN ${workExpenseOwners(sql`finding."recordId"`)}
    WHEN ${entitySchema.enum.email} THEN ARRAY(SELECT e."ledgerPartyId" FROM "Email" e WHERE e.id = finding."recordId" AND e."deletedAt" IS NULL)
    ELSE ${workRunReviewOwners(sql`finding."runId"`)} END END`;
  const findingRecord = scope.record
    ? sql` AND identity.kind = ${scope.record.entity} AND identity.shortcode = ${scope.record.id}`
    : sql``;
  if (!scope.gapChecks && branch("finding", ["review"], "finding"))
    selections.push(sql`SELECT identity.kind AS entity, identity.shortcode AS id,
    finding.data->>${"summary"} AS name, 'finding:' || finding.id::text AS key,
    ${workQueueSourceSchema.enum.finding}::text AS source, ${workQueueKindSchema.enum.review}::text AS kind, ${workQueueReasonLabels.finding}::text AS reason,
    'Open the retained source and review the proposed correction.'::text AS "nextAction",
    CASE WHEN cardinality(authority.owners) > 0 AND NOT EXISTS (
      SELECT 1 FROM unnest(authority.owners) owner WHERE owner IS NULL OR owner <> finding."ledgerPartyId"
    ) THEN ARRAY[finding."ledgerPartyId"] ELSE ARRAY[NULL::uuid] END AS owners,
    false AS shared, NULL::text AS "problemKey", ARRAY[${"finding"}::text] AS reason_keys,
    ${workRecordFactColumns(sql`identity.kind`, sql`finding."recordId"`, scope.facts)}
    FROM "AssessmentState" finding
    JOIN "Entity" identity ON identity.id = finding."recordId" AND identity.kind = finding.entity AND identity."deletedAt" IS NULL
    CROSS JOIN LATERAL (SELECT ${findingSources} AS owners) authority
    WHERE ${activeFindingSql("finding")} AND NOT ${obsoleteExecutionFindingSql("finding")}${findingRecord}
  `);
  if (branch("account", ["review"], "account:run"))
    selections.push(
      ...workQueueCandidate(scope, {
        entity: "run",
        ...workRunReviewRead(),
        id: sql`"Run".shortcode`,
        name: sql`"Run".purpose || ' · ' || "Run".status`,
        where: sql`"Run"."deletedAt" IS NULL AND "Run"."failureCode" IS DISTINCT FROM 'user_cancelled' AND "Run"."failureCode" IS DISTINCT FROM 'dispatch_aborted' AND (
        (${attentionStatePredicate(sql`"Run".status`)} AND "Run".status <> ${runStatus.enum.needs_review}
          AND NOT EXISTS (SELECT 1 FROM "AssessmentState" finding WHERE finding."runId" = "Run".id AND ${activeFindingSql("finding")}))
        OR ("Run".purpose = ${runPurpose.enum.photo_inventory} AND EXISTS (
          SELECT 1 FROM "PhotoGroupProposal" proposal WHERE proposal."runId" = "Run".id AND proposal.state = ${photoGroupProposalState.enum.proposed}
        ))
      )`,
        details: {
          source: "account",
          kind: "review",
          reason: workQueueReasonLabels["account:run"],
          nextAction:
            "Inspect retained Run status and transcript. Choose any retry or continuation explicitly.",
        },
        key: "account:run",
      }),
    );
  const problems = await problemSelections(db, scope, readContexts);
  selections.push(...problems.selections);
  // A scope that admits no branch still yields a typed, empty relation.
  if (selections.length === 0)
    return {
      incompleteProjectIds: problems.incompleteProjectIds,
      relation: sql`SELECT NULL::text AS entity, NULL::text AS id, NULL::text AS name,
      NULL::text AS key, NULL::text AS source, NULL::text AS kind, NULL::text AS reason,
      NULL::text AS "nextAction", ARRAY[]::uuid[] AS owners, false AS shared,
      NULL::text AS "problemKey", ARRAY[]::text[] AS reason_keys, ${NO_FACT_COLUMNS} WHERE false`,
    };
  return {
    relation: sql.join(selections, sql` UNION ALL `),
    incompleteProjectIds: problems.incompleteProjectIds,
  };
}

/** Each row carries its source record's quality score, and a gap row states
 * its own gaps (an Email's missing original, a Purchase's missing item lines)
 * as check ids with messages, not a generic reason. */
async function stateRowQuality<E extends ScoredEntity & ShortcodeEntity>(
  db: Database,
  entity: E,
  rows: WorkQueueRow[],
  record?: WorkQueueScope["record"],
) {
  const ids = await resolveLiveShortcodes(
    db,
    rows.flatMap((item) => (item.id ? [item.id] : [])),
    entity,
  );
  const liveId =
    record?.entity === entity && record.quality
      ? ids.get(record.id)
      : undefined;
  const qualities = await loadDataQualities(
    db,
    entity,
    [...ids.values()].filter((id) => id !== liveId),
    "stored",
  );
  if (liveId && record?.quality) qualities.set(liveId, record.quality);
  for (const item of rows) {
    const id = item.id ? ids.get(item.id) : undefined;
    const quality = id ? qualities.get(id) : undefined;
    if (!quality) continue;
    item.dataQuality = { status: quality.status, score: quality.score };
    const gapView = workQueueGapViews.find(
      (view) => view.entity === entity && view.source === item.source,
    );
    if (!gapView) continue;
    const relevantChecks = new Set(workQueueGapChecks(gapView));
    const gaps = new Map<string, WorkQueueGap>();
    for (const gap of [...quality.gaps, ...quality.relatedGaps]) {
      const check = dataCheck.safeParse(gap.check).data;
      if (check && relevantChecks.has(check) && !gaps.has(check))
        gaps.set(check, { check, message: gap.message });
    }
    item.gaps = [...gaps.values()];
    item.reasonKeys = item.gaps.map((gap) => gap.check);
    // Messages are sentences, so the plain-text reason reads as prose.
    if (item.gaps.length)
      item.reason = [...new Set(item.gaps.map((gap) => gap.message))].join(" ");
  }
}

async function stateRowQualities(
  db: Database,
  items: WorkQueueRow[],
  record?: WorkQueueScope["record"],
) {
  for (const entity of scoredEntities) {
    const rows = items.filter((item) => item.entity === entity);
    if (rows.length > 0) await stateRowQuality(db, entity, rows, record);
  }
}

async function attachDisplayImages(db: Database, items: WorkQueueRow[]) {
  const images = await resolvePublicEntityDisplayImageLists(
    db,
    items.flatMap((item) =>
      item.entity && item.id
        ? [{ entityKind: item.entity, entityId: item.id }]
        : [],
    ),
  );
  for (const item of items)
    if (item.entity && item.id)
      item.displayImages = images.get(entityRefKey(item.entity, item.id)) ?? [];
}

const vendorOf = (uuid: SQL) =>
  // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- 'id'/'name' are the response's JSON property names, not vocabulary values.
  sql`(SELECT jsonb_build_object('id', v.shortcode, 'name', v.name) FROM "Vendor" v WHERE v.id = ${uuid} AND v."deletedAt" IS NULL)`;

const textList = (values: readonly string[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

/** Include any requested value; exclude rows matching any forbidden value, including nullable predicates. */
const valueFilterConditions = (
  included: string | readonly string[] | undefined,
  excluded: string | readonly string[] | undefined,
  predicate: (values: readonly string[]) => SQL | undefined,
  presence?: SQL,
): SQL[] => {
  const include = included === undefined ? [] : [included].flat();
  const exclude = excluded === undefined ? [] : [excluded].flat();
  const positive = or(
    include.length ? predicate(include) : undefined,
    presence,
  );
  const negative = exclude.length ? predicate(exclude) : undefined;
  return [
    ...(positive ? [positive] : []),
    ...(negative ? [sql`NOT COALESCE((${negative}), false)`] : []),
  ];
};

async function queryWorkQueue(
  db: Database,
  problemSelections: WorkProblemSelections,
  currentPartyId: LedgerPartyId | null,
  input: QueueInput,
  memberOnly: boolean,
  record?: WorkQueueScope["record"],
  actor?: ActorContext,
) {
  const sorts = workQueueSortSchema.parse(
    normalizeSorts(input.sort ?? [{ orderBy: "kind", direction: "asc" }]),
  );
  const facts = (["amount", "date", "vendor"] as const).filter(
    (fact) =>
      sorts.some((sort) => sort.orderBy === fact) ||
      (fact === "vendor" &&
        (input.vendor !== undefined ||
          input.vendorExclude !== undefined ||
          input.group === "vendor")),
  );
  const candidateConditions: SQL[] = [];
  const sources = oneOrManyValues(input.source);
  candidateConditions.push(
    ...valueFilterConditions(
      input.source,
      input.sourceExclude,
      (values) => sql`source IN (${textList(values)})`,
    ),
  );
  const typePredicate = (values: readonly string[]) =>
    sql`entity IN (${textList(values)})`;
  const typePresence =
    input.entityPresence === "none"
      ? sql`entity IS NULL`
      : input.entityPresence === "has"
        ? sql`entity IS NOT NULL`
        : undefined;
  candidateConditions.push(
    ...valueFilterConditions(
      input.entity,
      input.entityExclude,
      typePredicate,
      typePresence,
    ),
  );
  const kinds = oneOrManyValues(input.kind);
  candidateConditions.push(
    ...valueFilterConditions(
      input.kind,
      input.kindExclude,
      (values) => sql`kind IN (${textList(values)})`,
    ),
  );
  let needsOnHandEvidence = false;
  let needsExpectedEvidence = false;
  const productReadContext: QualityReadContext = {
    derivedValue: record
      ? undefined
      : (field, entityId) => {
          if (field === "expectedQuantity") {
            needsExpectedEvidence = true;
            // Text keeps the double exact through the map; the catalog walk
            // replaces one kit recursion per stocked Product.
            return sql`((SELECT jsonb_object_agg("id", "value"::text) FROM work_product_expected) ->> ${entityId}::text)::double precision`;
          }
          if (field !== "onHandUnits") return undefined;
          needsOnHandEvidence = true;
          return sql`((SELECT jsonb_object_agg("productId", "onHandUnits") FROM work_product_on_hand) ->> ${entityId}::text)::double precision`;
        },
  };
  const reasonIncludes = oneOrManyValues(input.reason);
  const gapChecks = new Set<string>(
    workQueueGapViews.flatMap(workQueueGapChecks),
  );
  const { relation: projection, incompleteProjectIds } =
    await workQueueProjection(
      db,
      {
        sources,
        kinds,
        sourceExclude: oneOrManyValues(input.sourceExclude),
        kindExclude: oneOrManyValues(input.kindExclude),
        reasons: reasonIncludes,
        reasonExclude: oneOrManyValues(input.reasonExclude),
        query: input.query,
        gapChecks:
          reasonIncludes?.length &&
          reasonIncludes.every((key) => gapChecks.has(key))
            ? reasonIncludes.flatMap(
                (key) => dataCheck.safeParse(key).data ?? [],
              )
            : undefined,
        reasonChecks: [
          ...new Set([
            ...(reasonIncludes ?? []),
            ...(oneOrManyValues(input.reasonExclude) ?? []),
          ]),
        ].flatMap((key) =>
          gapChecks.has(key) ? (dataCheck.safeParse(key).data ?? []) : [],
        ),
        record,
        facts,
      },
      problemSelections,
      { product: productReadContext },
      Boolean(input.query),
    );
  // All sources, including findings, defer planned purchases before counts
  // and paging. An empty purchase is unknown, not implicitly planned.
  const conditions: SQL[] = [
    sql`(routed.entity IS DISTINCT FROM ${entitySchema.enum.purchase} OR NOT EXISTS (
    SELECT 1 FROM "Purchase" planned WHERE planned.shortcode = routed.id AND planned."deletedAt" IS NULL
      AND (planned.date > ${householdLocalDate(new Date())}::date OR (
        EXISTS (SELECT 1 FROM "Expense" line WHERE line."purchaseId" = planned.id AND line."deletedAt" IS NULL)
        AND NOT EXISTS (SELECT 1 FROM "Expense" line WHERE line."purchaseId" = planned.id AND line."deletedAt" IS NULL AND ${sql.raw(actualExpenseSql("line"))})
      ))
  ))`,
  ];
  candidateConditions.push(
    ...valueFilterConditions(
      input.reason,
      input.reasonExclude,
      (values) => sql`reason_keys && ARRAY[${textList(values)}]::text[]`,
    ),
  );
  const viewPredicates = {
    automatic: sql`(${workExecutorSql(sql`routed.source`, sql`routed.kind`)}) = ${workExplanationSchema.shape.executor.enum.automatic}`,
    research: sql`(${workExecutorSql(sql`routed.source`, sql`routed.kind`)}) = ${workExplanationSchema.shape.executor.enum.agent_session}`,
    review: sql`(${workExecutorSql(sql`routed.source`, sql`routed.kind`)}) = ${workExplanationSchema.shape.executor.enum.human}`,
    waiting: sql`(
      routed.kind = ${workQueueKindSchema.enum.awaiting_posting}
      OR routed.waiting_kind = ${unresolved}
      OR (routed.entity = ${entitySchema.enum.run} AND EXISTS (
        SELECT 1 FROM "Run" waiting
        WHERE waiting.shortcode = routed.id AND waiting."deletedAt" IS NULL
          AND (waiting.status IN (${runStatus.enum.paused}, ${runStatus.enum.paused_auth}, ${runStatus.enum.paused_offline})
            OR waiting."failureCode" IN ('execution_limit'))
      ))
    )`,
  };
  if (memberOnly)
    conditions.push(
      sql`(waiting_kind = ${either} OR (waiting_kind = ${members} AND ${currentPartyId}::uuid = ANY(owners) AND NOT EXISTS (SELECT 1 FROM unnest(owners) owner WHERE owner <> ${currentPartyId}::uuid)))`,
    );
  else {
    const waitingPredicate = (waitingFor: readonly string[]) => {
      const codes = waitingFor.filter(
        (value) => value !== CURRENT_MEMBER_FILTER && value !== either,
      );
      // Me is the work I can do (mine or Either); a picked member is only the
      // work routed to them; Either is shared work.
      return or(
        waitingFor.includes(CURRENT_MEMBER_FILTER)
          ? sql`(waiting_kind = ${either} OR (waiting_kind = ${members} AND ${currentPartyId}::uuid = ANY(owners)))`
          : undefined,
        waitingFor.includes(either) ? sql`waiting_kind = ${either}` : undefined,
        codes.length
          ? sql`(waiting_kind = ${members} AND EXISTS (SELECT 1 FROM members member WHERE member.shortcode IN (${textList(codes)}) AND member.id = ANY(owners)))`
          : undefined,
      );
    };
    const presence =
      input.waitingForPresence === "none"
        ? sql`waiting_kind = ${unresolved}`
        : input.waitingForPresence === "has"
          ? sql`waiting_kind <> ${unresolved}`
          : undefined;
    conditions.push(
      ...valueFilterConditions(
        input.waitingFor,
        input.waitingForExclude,
        waitingPredicate,
        presence,
      ),
    );
  }
  candidateConditions.push(
    ...valueFilterConditions(
      input.vendor,
      input.vendorExclude,
      (values) =>
        sql`vendor_id IN (SELECT v.id FROM "Vendor" v WHERE v.shortcode IN (${textList(values)}))`,
    ),
  );
  if (input.query)
    candidateConditions.push(
      sql`concat_ws(' ', name, reason, id, "nextAction") ILIKE ${ilikeContains(input.query)}`,
    );
  const sortExpressions = {
    name: sql`name`,
    entity: sql`CASE entity ${sql.join(
      Object.entries(entitySummary).map(
        ([entity, summary]) => sql`WHEN ${entity} THEN ${summary.singular}`,
      ),
      sql` `,
    )} ELSE 'Problem' END`,
    kind: sql`kind`,
    source: sql`source`,
    nextAction: sql`"nextAction"`,
    waitingFor: sql`CASE waiting_kind WHEN ${either} THEN 'Either' WHEN ${unresolved} THEN 'Unresolved' ELSE (SELECT string_agg(member.name, ', ' ORDER BY member.name, member.shortcode) FROM members member WHERE member.id = ANY(eligible.owners)) END`,
    amount: sql`amount`,
    date: sql`date`,
    vendor: vendorColumn("name"),
  };
  // A grouped read orders by its section first, in the summary's order (by
  // label, the no-value section last), so loaded rows are a prefix of its
  // sections.
  const section = input.group ? GROUP_SECTIONS[input.group] : undefined;
  const sectionLabel =
    section && sql`coalesce(nullif(${section.label}, ''), ${section.key})`;
  const noValueLabel = workQueueList.grouping.find(
    (choice) => choice.key === input.group,
  )?.noValueLabel;
  // Every sort places nulls last in both directions; name and key break ties.
  const orderBy = sql.join(
    [
      ...(section
        ? [
            sql`(${section.key}) IS NULL ASC`,
            sql`${sectionLabel} ASC`,
            sql`${section.key} ASC`,
          ]
        : []),
      ...sorts.map(
        (sort) =>
          sql`${sortExpressions[sort.orderBy]} ${sort.direction === "desc" ? sql`DESC` : sql`ASC`} NULLS LAST`,
      ),
      sql`name ASC`,
      sql`key ASC`,
    ],
    sql`, `,
  );
  // Narrow candidate membership before materializing ownership and routing.
  // Shared evidence retains its own bulk boundary; facts and enrichment that
  // cannot affect membership load only after the exact-count page is selected.
  // Limit the correctly filtered/sorted population before assigning JSON order,
  // rather than window-sorting every eligible row and sorting again by position.
  // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- JSON property names below are the response contract, not vocabulary values.
  const result = await getDb(db).execute(sql`
    WITH
    ${needsOnHandEvidence ? sql`work_product_on_hand AS MATERIALIZED (${onHandUnitsReadSql()}),` : sql``}
    ${needsExpectedEvidence ? sql`work_product_expected AS MATERIALIZED (${expectedQuantityReadSql()}),` : sql``}
    work_statement_state AS MATERIALIZED (${pendingStatementStateSql()}),
    work_connection_prediction AS MATERIALIZED (
      SELECT a.id, a.subject, a.fingerprint,
        coalesce(s.data->'connectionTarget', a.evidence->'candidate'->'target') AS target
      FROM "Assessment" a JOIN "AssessmentState" s ON s.id=a.id
      WHERE a.served AND s.family=${assessmentFamily.enum.recommendation} AND s.active AND s.status=${suggestionStatus.enum.pending}
        AND a.subject->>'scope' LIKE 'connection.%'
    ),
    members AS (
      SELECT id, shortcode, name FROM "LedgerParty" WHERE kind = ${ledgerPartyKind.enum.member} AND "deletedAt" IS NULL
    ), candidates AS (${projection}), routed AS MATERIALIZED (
      SELECT candidates.*, CASE
        WHEN shared THEN ${either}
        WHEN cardinality(owners) > 0 AND NOT EXISTS (
          SELECT 1 FROM unnest(owners) owner WHERE owner IS NULL OR NOT EXISTS (SELECT 1 FROM members member WHERE member.id = owner)
        ) THEN ${members} ELSE ${unresolved} END AS waiting_kind
      FROM candidates ${candidateConditions.length ? sql`WHERE ${sql.join(candidateConditions, sql` AND `)}` : sql``}
    ) , filtered AS MATERIALIZED (SELECT * FROM routed WHERE ${sql.join(conditions, sql` AND `)}), eligible AS (
      SELECT * FROM filtered routed ${input.view ? sql`WHERE ${viewPredicates[input.view]}` : sql``}
    ), ordered AS (
      SELECT * FROM eligible ORDER BY ${orderBy} LIMIT ${input.pageSize} OFFSET ${input.pageIndex * input.pageSize}
    ), page AS (
      SELECT entity, id, name, key, source, kind, reason, reason_keys, "nextAction", owners, shared, "problemKey", waiting_kind,
        row_number() OVER (ORDER BY ${orderBy}) AS position,
        ${workRecordFactColumns(sql`eligible.entity`, sql`eligible.id`, undefined, "shortcode")}
      FROM ordered eligible
    ) SELECT
      (SELECT count(*)::int FROM eligible) AS total,
      (SELECT jsonb_build_object('all', count(*)::int,
        ${sql.join(
          Object.entries(viewPredicates).flatMap(([view, predicate]) => [
            sql`${view}::text`,
            sql`count(*) FILTER (WHERE ${predicate})::int`,
          ]),
          sql`, `,
        )}
      ) FROM filtered routed) AS "viewCounts",
      ${
        section
          ? sql`(SELECT coalesce(jsonb_agg(to_jsonb(sections) ORDER BY sections.key = ${FILTER_NONE}, sections.label, sections.key), '[]'::jsonb) FROM (
              SELECT coalesce(section, ${FILTER_NONE}::text) AS key, coalesce(label, ${noValueLabel}::text) AS label, count(*)::int AS count
              FROM (SELECT ${section.key} AS section, ${sectionLabel} AS label FROM eligible) sectioned GROUP BY section, label
            ) sections)`
          : sql`NULL::jsonb`
      } AS groups,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id', shortcode, 'name', name) ORDER BY name, shortcode) FROM members), '[]'::jsonb) AS members,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'entity', entity, 'id', id, 'name', name, 'key', key, 'source', source, 'kind', kind,
        'reason', reason, 'reasonKeys', reason_keys, 'gaps', '[]'::jsonb, 'dataQuality', 'null'::jsonb, 'amount', amount, 'date', date, 'vendor', ${vendorOf(sql`page.vendor_id`)},
        'nextAction', "nextAction", 'displayImages', '[]'::jsonb, 'waitingFor', CASE waiting_kind
          WHEN ${either} THEN jsonb_build_object('kind', ${either}::text)
          WHEN ${members} THEN jsonb_build_object('kind', ${members}::text, 'members', (SELECT jsonb_agg(jsonb_build_object('id', member.shortcode, 'name', member.name) ORDER BY member.name, member.shortcode) FROM members member WHERE member.id = ANY(page.owners)))
          ELSE jsonb_build_object('kind', ${unresolved}::text, 'reason', 'Current private source ownership is not established.') END
      ) || CASE WHEN "problemKey" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('problemKey', "problemKey") END
        || CASE WHEN source = ${workQueueSourceSchema.enum.suggestion} AND key LIKE 'suggestions:%' THEN jsonb_build_object('suggestionFamily', split_part(key, ':', 2)) ELSE '{}'::jsonb END ORDER BY position) FROM page), '[]'::jsonb) AS items
  `);
  const row = z
    .object({
      total: z.number(),
      viewCounts: workQueueOutSchema.shape.meta.shape.viewCounts,
      groups: workQueueOutSchema.shape.meta.shape.groups.nullable(),
      members: workQueueOutSchema.shape.members,
      items: workQueueOutSchema.shape.items,
    })
    .parse(result.rows[0]);
  await stateRowQualities(db, row.items, record);
  const contexts = await loadWorkContexts(db, row.items, actor);
  for (const item of row.items) {
    item.explanations = projectWorkExplanations(item, contexts.get(item.key));
  }
  // Member routing fences rows, not imagery borrowed through linked records
  // (a transaction's purchase receipts), so member reads carry none. The
  // record strip sits on the record's own page and carries none either.
  if (!memberOnly && !record) await attachDisplayImages(db, row.items);
  return workQueueOutSchema.parse({
    items: row.items,
    members: row.members,
    meta: {
      pageIndex: input.pageIndex,
      pageSize: input.pageSize,
      totalCount: row.total,
      ...(incompleteProjectIds.length > 0 ? { incompleteProjectIds } : {}),
      viewCounts: row.viewCounts,
      ...(row.groups ? { groups: row.groups } : {}),
    },
  });
}

/** Authority is an implicit argument supplied only by the authenticated operation context. */
export const readWorkQueueWith = (
  problemSelections: WorkProblemSelections,
  db: Database,
  currentPartyId: LedgerPartyId | null,
  input: QueueInput,
  memberOnly: boolean,
  actor?: ActorContext,
) =>
  queryWorkQueue(
    db,
    problemSelections,
    currentPartyId,
    input,
    memberOnly,
    undefined,
    actor,
  );

/** One record's rows of the same projection and routing. The record filter is
 * pushed into each branch, so this never plans the whole queue. */
export async function readRecordWorkQueueWith(
  problemSelections: WorkProblemSelections,
  db: Database,
  currentPartyId: LedgerPartyId | null,
  id: string,
  memberOnly: boolean,
  actor?: ActorContext,
) {
  const parsed = parseShortcode(id);
  if (!parsed) throw new Error(`Work queue record ${id} is not a shortcode`);
  const record: NonNullable<WorkQueueScope["record"]> = {
    entity: parsed.type,
    id: parsed.shortcode,
  };
  const entity = scoredEntities.find((kind) => kind === parsed.type);
  if (entity) {
    const entityId = (
      await resolveLiveShortcodes(db, [parsed.shortcode], entity)
    ).get(parsed.shortcode);
    if (entityId)
      record.quality = (
        await loadDataQualities(db, entity, [entityId], "live")
      ).get(entityId);
  }
  return queryWorkQueue(
    db,
    problemSelections,
    currentPartyId,
    workQueueHouseholdInput.parse({
      pageSize: 100,
      sort: [{ orderBy: "kind", direction: "asc" }],
    }),
    memberOnly,
    record,
    actor,
  );
}
