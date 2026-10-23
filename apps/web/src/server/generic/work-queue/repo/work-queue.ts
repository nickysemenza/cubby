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
import { expenseFiltersSchema } from "@cubby/schemas/project";
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
import {
  email,
  expense,
  financialAccount,
  financialTransaction,
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
  suggestionField,
} from "~/server/domains/transaction-import/repo/statement-charge";
import { buildVendorWhereClause } from "~/server/domains/vendor/repo/vendor";
import { resolvePublicEntityDisplayImageLists } from "~/server/entity-kernel/repo/entity-display-image";
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
  workRecordFactColumns,
  type WorkQueueScope,
} from "~/server/generic/work-queue/repo/work-queue-projection";
import {
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
  if (!scope.check) return filters;
  const requested = new Set(scope.check);
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

/** One read-only relation, shared by household routing and member eligibility. */
/** Diagnostic-backed queue branches; supplied by `service/work-queue-read`. */
export type WorkProblemSelections = (
  db: Database,
  scope: WorkQueueScope,
  readContexts?: Partial<Record<Entity, QualityReadContext>>,
) => Promise<SQL[]>;

async function workQueueProjection(
  db: Database,
  scope: WorkQueueScope,
  problemSelections: WorkProblemSelections,
  readContexts: Partial<Record<Entity, QualityReadContext>>,
  searched: boolean,
): Promise<SQL> {
  const selections: SQL[] = [];
  if (!scope.check) {
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
      ARRAY[]::uuid[] AS owners, true AS shared, NULL::text AS "problemKey", ${NO_FACT_COLUMNS}
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
      ARRAY[]::uuid[] AS owners, true AS shared, NULL::text AS "problemKey", ${NO_FACT_COLUMNS}
      FROM "AssessmentState" current
      JOIN work_connection_prediction prediction ON prediction.id = current.id
      JOIN "Entity" root ON root.id = current."recordId" AND root.kind = current.entity
      WHERE ${reviewable}
      HAVING count(*) > 0`);
  }
  // Skips building a branch the scope would drop anyway.
  const admits = (entity: Entity, carriesGaps = false) =>
    (!scope.check || carriesGaps) &&
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
  const productGaps = gapViewFilters(scope, "product");
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
        shared: true,
        carriesGaps: true,
      }),
    );
  const vendorGaps = gapViewFilters(scope, "vendor");
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
        shared: true,
        carriesGaps: true,
      }),
    );
  const purchaseGaps = gapViewFilters(scope, "purchase");
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
        carriesGaps: true,
      }),
    );
  const expenseGaps = gapViewFilters(scope, "expense");
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
        carriesGaps: true,
      }),
    );
  const emailGaps = gapViewFilters(scope, "email");
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
        carriesGaps: true,
      }),
    );
  if (scopeAdmitsUnrecorded(scope))
    selections.push(sql`SELECT NULL::text AS entity, NULL::text AS id,
    'Transaction suggestions'::text AS name,
    'suggestions:' || ${assessmentFamily.enum.statement_transaction}::text AS key,
    ${workQueueSourceSchema.enum.suggestion}::text AS source, ${workQueueKindSchema.enum.review}::text AS kind,
    count(*)::text || CASE WHEN count(*) = 1 THEN ' transaction suggestion' ELSE ' transaction suggestions' END
      || ' (' || count(*) FILTER (WHERE (${suggestionField("clean")})::boolean) || ' ready to accept)' AS reason,
    'Review them on the Suggestions page; accept the clean ones as a group.'::text AS "nextAction",
    ARRAY[]::uuid[] AS owners, true AS shared, NULL::text AS "problemKey", ${NO_FACT_COLUMNS}
    FROM "AssessmentState" s WHERE ${pendingSuggestion()}
    HAVING count(*) > 0`);
  if (scopeAdmitsUnrecorded(scope))
    selections.push(sql`SELECT NULL::text AS entity, NULL::text AS id,
    'Transfer-pair suggestions'::text AS name,
    'suggestions:' || ${assessmentFamily.enum.transfer_pair}::text AS key,
    ${workQueueSourceSchema.enum.suggestion}::text AS source, ${workQueueKindSchema.enum.review}::text AS kind,
    count(*)::text || CASE WHEN count(*) = 1 THEN ' transfer pair' ELSE ' transfer pairs' END
      || ' (' || count(*) FILTER (WHERE (s.data->>'clean')::boolean) || ' ready to accept)' AS reason,
    'Review both legs and owners on the Suggestions page.'::text AS "nextAction",
    ARRAY[]::uuid[] AS owners, true AS shared, NULL::text AS "problemKey", ${NO_FACT_COLUMNS}
    FROM "AssessmentState" s WHERE s.family = ${assessmentFamily.enum.transfer_pair}
      AND s.active AND s.status = ${suggestionStatus.enum.pending}
    HAVING count(*) > 0`);
  // One row for the whole family, never one per Suggestion: the Suggestions
  // page is where each is reviewed. A record's own Work counts its own.
  if (scopeAdmitsUnrecorded(scope) || (scope.record && !scope.check)) {
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
    ARRAY[]::uuid[] AS owners, true AS shared, NULL::text AS "problemKey", ${NO_FACT_COLUMNS}
    FROM ${suggestionTable} LEFT JOIN ${runTable} ON ${runTable.id} = ${suggestionTable.runId}
    WHERE ${suggestionTable.active} AND ${suggestionTable.status} = ${suggestionStatus.enum.pending} AND ${suggestionTable.family} = ${assessmentFamily.enum.field} AND ${reviewableSuggestionSql}
      ${own}
    HAVING count(*) > 0`);
  }

  // The declared unsettled view owns missing payment evidence. Receipt
  // research remains independent; settlement authority includes every tender.
  if (
    admits("purchase", true) &&
    (!scope.check || scope.check.includes("settlement_reference"))
  ) {
    const deferred = awaitingPostingSql(purchasePostingStartSql('"Purchase"'));
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
          reason: "No settlement evidence",
          nextAction: sql`CASE WHEN ${deferred} THEN 'Wait through two complete business days for settlement evidence.' ELSE 'Investigate missing settlement against source coverage; do not infer a missing charge.' END`,
        },
        key: "reconciliation:purchase-unsettled",
        carriesGaps: true,
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
      !admits(source.entity)
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
        ? awaitingPostingSql(purchasePostingStartSql('"Purchase"'))
        : null;
    const settlementDetails = deferred
      ? {
          ...details,
          kind: sql`CASE WHEN ${deferred} THEN ${workQueueKindSchema.enum.awaiting_posting} ELSE ${details.kind} END`,
          reason: sql`CASE WHEN ${deferred} THEN 'Awaiting posting; recorded settlement amounts differ.' ELSE ${details.reason} END`,
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
        }),
      );
  }
  selections.push(
    ...workQueueCandidate(scope, {
      entity: "run",
      ...workRunReviewRead(),
      id: sql`"Run".shortcode`,
      name: sql`"Run".purpose || ' · ' || "Run".status`,
      where: sql`"Run"."deletedAt" IS NULL AND (("Run".status = ${runStatus.enum.running} AND ("Run".purpose IN (${sql.join(
        // A running maintenance pass or Sweep is not member work; its failed
        // or stalled outcomes still surface through the failure paths.
        EXECUTED_RUN_PURPOSES.filter(
          (purpose) => !isStepRunPurpose(purpose),
        ).map((purpose) => sql`${purpose}`),
        sql`, `,
      )}) OR "Run"."dispatchEventId" IS NOT NULL)) OR ("Run".status = ${runStatus.enum.needs_review} AND "Run"."failureCode" IN ('execution_limit')))`,
      details: {
        source: "execution",
        kind: "repair",
        reason: "Authorized execution or prerequisite wait",
        nextAction: "Inspect current progress and retained execution evidence.",
      },
      key: "execution:run",
    }),
    ...workQueueCandidate(scope, {
      entity: "financialAccount",
      table: sql`${financialAccount}`,
      id: sql`"FinancialAccount".shortcode`,
      name: sql`"FinancialAccount".name`,
      owners: sql`ARRAY["FinancialAccount"."ledgerPartyId"]`,
      where: sql`"FinancialAccount"."deletedAt" IS NULL AND ${gapCondition("financialAccount", "financial_account_unclaimed")}`,
      details: {
        source: "account",
        kind: "review",
        reason: "Provisional financial account",
        nextAction: "Claim the account using provider evidence.",
      },
      key: "account:provisional",
    }),
    // An account's own Work counts its Transaction suggestions; the global
    // view has one row for the family, below.
    ...(scope.record
      ? workQueueCandidate(scope, {
          entity: "financialAccount",
          table: sql`"FinancialAccount" JOIN (
        SELECT (${suggestionField("accountId")})::uuid AS account,
          count(*)::int AS total,
          count(*) FILTER (WHERE (${suggestionField("clean")})::boolean)::int AS clean
        FROM "AssessmentState" s WHERE ${pendingSuggestion()}
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
        })
      : []),
  );

  if (admits("financialTransaction")) {
    const deferred = awaitingPostingSql(
      transactionPostingStartSql('"FinancialTransaction"'),
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
          reason: sql`CASE WHEN ${deferred} THEN 'Awaiting posting of transfer evidence.' ELSE 'Account transfer has no confirmed transfer evidence.' END`,
          nextAction: sql`CASE WHEN ${deferred} THEN 'Wait two business days for the counterpart to post.' ELSE 'Review transfer pairing candidates and confirm the transfer from evidence.' END`,
        },
        key: "reconciliation:transfer",
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
  if (!scope.check)
    selections.push(sql`SELECT identity.kind AS entity, identity.shortcode AS id,
    finding.data->>${"summary"} AS name, 'finding:' || finding.id::text AS key,
    ${workQueueSourceSchema.enum.finding}::text AS source, ${workQueueKindSchema.enum.review}::text AS kind, finding.data->>${"summary"} AS reason,
    'Open the retained source and review the proposed correction.'::text AS "nextAction",
    CASE WHEN cardinality(authority.owners) > 0 AND NOT EXISTS (
      SELECT 1 FROM unnest(authority.owners) owner WHERE owner IS NULL OR owner <> finding."ledgerPartyId"
    ) THEN ARRAY[finding."ledgerPartyId"] ELSE ARRAY[NULL::uuid] END AS owners,
    false AS shared, NULL::text AS "problemKey",
    ${workRecordFactColumns(sql`identity.kind`, sql`finding."recordId"`, scope.facts)}
    FROM "AssessmentState" finding
    JOIN "Entity" identity ON identity.id = finding."recordId" AND identity.kind = finding.entity AND identity."deletedAt" IS NULL
    CROSS JOIN LATERAL (SELECT ${findingSources} AS owners) authority
    WHERE ${activeFindingSql("finding")} AND NOT ${obsoleteExecutionFindingSql("finding")}${findingRecord}
  `);
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
        reason: "Run needs attention",
        nextAction:
          "Inspect retained Run status and transcript. Choose any retry or continuation explicitly.",
      },
      key: "account:run",
    }),
  );
  selections.push(...(await problemSelections(db, scope, readContexts)));
  // A scope that admits no branch still yields a typed, empty relation.
  if (selections.length === 0)
    return sql`SELECT NULL::text AS entity, NULL::text AS id, NULL::text AS name,
      NULL::text AS key, NULL::text AS source, NULL::text AS kind, NULL::text AS reason,
      NULL::text AS "nextAction", ARRAY[]::uuid[] AS owners, false AS shared,
      NULL::text AS "problemKey", ${NO_FACT_COLUMNS} WHERE false`;
  return sql.join(selections, sql` UNION ALL `);
}

/** Each row carries its source record's quality score, and a gap row states
 * its own gaps (an Email's missing original, a Purchase's missing item lines)
 * as check ids with messages, not a generic reason. */
async function stateRowQuality<E extends ScoredEntity & ShortcodeEntity>(
  db: Database,
  entity: E,
  rows: WorkQueueRow[],
) {
  const ids = await resolveLiveShortcodes(
    db,
    rows.flatMap((item) => (item.id ? [item.id] : [])),
    entity,
  );
  const qualities = await loadDataQualities(
    db,
    entity,
    [...ids.values()],
    "stored",
  );
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
    // Messages are sentences, so the plain-text reason reads as prose.
    if (item.gaps.length)
      item.reason = [...new Set(item.gaps.map((gap) => gap.message))].join(" ");
  }
}

async function stateRowQualities(db: Database, items: WorkQueueRow[]) {
  for (const entity of scoredEntities) {
    const rows = items.filter((item) => item.entity === entity);
    if (rows.length > 0) await stateRowQuality(db, entity, rows);
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
        (input.vendor !== undefined || input.group === "vendor")),
  );
  const candidateConditions: SQL[] = [];
  const sources = oneOrManyValues(input.source);
  if (sources?.length)
    candidateConditions.push(sql`source IN (${textList(sources)})`);
  const recordTypes = oneOrManyValues(input.entity);
  if (recordTypes?.length)
    candidateConditions.push(sql`entity IN (${textList(recordTypes)})`);
  const kinds = oneOrManyValues(input.kind);
  if (kinds?.length)
    candidateConditions.push(sql`kind IN (${textList(kinds)})`);
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
  const projection = await workQueueProjection(
    db,
    {
      sources,
      kinds,
      check: input.check === undefined ? undefined : [input.check].flat(),
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
    const waitingFor = oneOrManyValues(input.waitingFor) ?? [];
    const codes = waitingFor.filter(
      (value) => value !== CURRENT_MEMBER_FILTER && value !== either,
    );
    // Me is the work I can do (mine or Either); a picked member is only the
    // work routed to them; Either is shared work.
    const routed = or(
      waitingFor.includes(CURRENT_MEMBER_FILTER)
        ? sql`(waiting_kind = ${either} OR (waiting_kind = ${members} AND ${currentPartyId}::uuid = ANY(owners)))`
        : undefined,
      waitingFor.includes(either) ? sql`waiting_kind = ${either}` : undefined,
      codes.length
        ? sql`(waiting_kind = ${members} AND EXISTS (SELECT 1 FROM members member WHERE member.shortcode IN (${textList(codes)}) AND member.id = ANY(owners)))`
        : undefined,
      input.waitingForPresence === "none"
        ? sql`waiting_kind = ${unresolved}`
        : input.waitingForPresence === "has"
          ? sql`waiting_kind <> ${unresolved}`
          : undefined,
    );
    if (routed) conditions.push(routed);
  }
  const vendors = oneOrManyValues(input.vendor);
  if (vendors?.length)
    candidateConditions.push(
      sql`vendor_id IN (SELECT v.id FROM "Vendor" v WHERE v.shortcode IN (${textList(vendors)}))`,
    );
  if (input.query)
    conditions.push(
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
  // Keep routed candidates behind a statement-local boundary before eligibility:
  // search pushdown can turn bulk quality joins into repeated nested-loop work.
  // Only sort/filter facts enter that population; page facts share their declaration.
  // Limit the correctly filtered/sorted population before assigning JSON order,
  // rather than window-sorting every eligible row and sorting again by position.
  // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- JSON property names below are the response contract, not vocabulary values.
  const result = await getDb(db).execute(sql`
    WITH
    ${needsOnHandEvidence ? sql`work_product_on_hand AS MATERIALIZED (${onHandUnitsReadSql()}),` : sql``}
    ${needsExpectedEvidence ? sql`work_product_expected AS MATERIALIZED (${expectedQuantityReadSql()}),` : sql``}
    work_connection_prediction AS MATERIALIZED (
      SELECT a.id, a.subject, a.fingerprint, a.evidence->'candidate'->'target' AS target
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
      SELECT entity, id, name, key, source, kind, reason, "nextAction", owners, shared, "problemKey", waiting_kind,
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
        'reason', reason, 'gaps', '[]'::jsonb, 'dataQuality', 'null'::jsonb, 'amount', amount, 'date', date, 'vendor', ${vendorOf(sql`page.vendor_id`)},
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
  await stateRowQualities(db, row.items);
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
  return queryWorkQueue(
    db,
    problemSelections,
    currentPartyId,
    workQueueHouseholdInput.parse({
      pageSize: 100,
      sort: [{ orderBy: "kind", direction: "asc" }],
    }),
    memberOnly,
    { entity: parsed.type, id: parsed.shortcode },
    actor,
  );
}
