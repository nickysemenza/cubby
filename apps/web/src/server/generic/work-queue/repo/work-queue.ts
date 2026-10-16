import { suggestionStatus } from "@cubby/schemas/ai";
import {
  dataCheck,
  scoredEntities,
  type ScoredEntity,
} from "@cubby/schemas/data-quality";
import { entityRefKey, entitySchema, type Entity } from "@cubby/schemas/entity";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import {
  shortcodeEntities,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  financialTransactionStatus,
  financialTransactionKind,
  financialTransactionFiltersSchema,
} from "@cubby/schemas/financial-transaction";
import type { LedgerPartyId } from "@cubby/schemas/identifiers";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party";
import { normalizeSorts } from "@cubby/schemas/pagination";
import { photoGroupProposalState } from "@cubby/schemas/photo-import-run";
import { productFiltersSchema } from "@cubby/schemas/product";
import { expenseFiltersSchema } from "@cubby/schemas/project";
import { purchaseFiltersSchema } from "@cubby/schemas/purchase";
import { proposedImportFix } from "@cubby/schemas/purchase-import";
import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
import { vendorFiltersSchema } from "@cubby/schemas/vendor";
import {
  workQueueGapChecks,
  workQueueGapViews,
  workQueueHouseholdInput,
  workQueueKindSchema,
  workQueueSourceSchema,
  workQueueSortSchema,
  workWaitingForSchema,
  workQueueOutSchema,
  type WorkQueueGap,
  type WorkQueueRow,
} from "@cubby/schemas/work-queue";
import { parseShortcode } from "@cubby/shared";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { problemQueryDeclarations } from "~/entity/problems/problem-registry";
import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { getDb, ilikeContains } from "~/server/db/helpers";
import {
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
import { obsoleteExecutionFindingSql } from "~/server/domains/purchase-import/repo/run-retirement";
import { buildPurchaseWhereClause } from "~/server/domains/purchase/repo/purchase";
import {
  awaitingPostingSql,
  purchasePostingStartSql,
  transactionPostingStartSql,
} from "~/server/domains/purchase/repo/settlement-grace";
import { buildVendorWhereClause } from "~/server/domains/vendor/repo/vendor";
import { resolvePublicEntityDisplayImageLists } from "~/server/entity-kernel/repo/entity-display-image";
import { reviewableSuggestionSql } from "~/server/generic/assessment/repo/suggestion-review";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import {
  gapCondition,
  qualityFilterSource,
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
} from "~/server/generic/work-queue/repo/work-queue-routing";

const either = workWaitingForSchema.options[0].shape.kind.value;
const members = workWaitingForSchema.options[1].shape.kind.value;
const unresolved = workWaitingForSchema.options[2].shape.kind.value;
// RunFinding's retained status column has no generated vocabulary schema.
const openFindingStatus = "open";

type QueueInput = z.infer<typeof workQueueHouseholdInput>;
type Candidate = Pick<
  WorkQueueRow,
  "source" | "kind" | "reason" | "nextAction"
>;

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

/** One read-only relation, shared by household routing and member eligibility. */
/** Diagnostic-backed queue branches; supplied by `service/work-queue-read`. */
export type WorkProblemSelections = (
  db: Database,
  scope: WorkQueueScope,
) => Promise<SQL[]>;

async function workQueueProjection(
  db: Database,
  scope: WorkQueueScope,
  problemSelections: WorkProblemSelections,
): Promise<SQL> {
  const selections: SQL[] = [];
  // Skips building a branch the scope would drop anyway.
  const admits = (entity: Entity, carriesGaps = false) =>
    (!scope.check || carriesGaps) &&
    (!scope.record || scope.record.entity === entity);
  const research = {
    source: "research",
    kind: "research",
    reason: "Research queue",
    nextAction: "Review missing facts and add verified evidence.",
  } satisfies Candidate;
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
        details: research,
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
        details: research,
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
        where: await buildPurchaseWhereClause(
          db,
          purchaseFiltersSchema.parse(purchaseGaps),
        ),
        details: research,
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
        details: research,
        key: "research:expense",
        carriesGaps: true,
      }),
    );
  const emailGaps = gapViewFilters(scope, "email");
  if (emailGaps && admits("email", true))
    selections.push(
      ...workQueueCandidate(scope, {
        entity: "email",
        table: qualityFilterSource("email"),
        id: sql`"Email".shortcode`,
        name: sql`coalesce("Email".subject, 'Email')`,
        owners: sql`ARRAY["Email"."ledgerPartyId"]`,
        where: buildEmailWhere(emailGaps),
        details: {
          source: "email",
          kind: "review",
          // Replaced by the row's own pipeline gaps after paging.
          reason: "Email pipeline gap",
          nextAction: "Review relevance, retained original and import status.",
        },
        key: "email",
        carriesGaps: true,
      }),
    );
  // One row per suggested field, never one per Suggestion: the Review list
  // is where each is accepted or rejected. It names no record, so a record
  // read never includes it.
  if (scopeAdmitsUnrecorded(scope))
    selections.push(sql`SELECT ${suggestionTable.entity}::text AS entity, NULL::text AS id,
    ${suggestionTable.entity} || '.' || ${suggestionTable.field} AS name,
    'suggestion:' || ${suggestionTable.entity} || '.' || ${suggestionTable.field} AS key,
    ${workQueueSourceSchema.enum.suggestion}::text AS source, ${workQueueKindSchema.enum.review}::text AS kind,
    count(*)::text || CASE WHEN count(*) = 1 THEN ' pending suggestion' ELSE ' pending suggestions' END AS reason,
    'Accept or reject them in AI Review.'::text AS "nextAction",
    ARRAY[]::uuid[] AS owners, true AS shared, NULL::text AS "problemKey", ${NO_FACT_COLUMNS}
    FROM ${suggestionTable} LEFT JOIN ${runTable} ON ${runTable.id} = ${suggestionTable.runId}
    WHERE ${suggestionTable.status} = ${suggestionStatus.enum.pending} AND ${suggestionTable.family} = ${"field"} AND ${reviewableSuggestionSql}
    GROUP BY ${suggestionTable.entity}, ${suggestionTable.field}`);

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
        where: sql`(${await buildPurchaseWhereClause(db, purchaseFiltersSchema.parse(viewFilters("purchase", "unsettled")))})
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
          where: await buildPurchaseWhereClause(
            db,
            purchaseFiltersSchema.parse(filters),
          ),
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
  const findingSources = sql`CASE WHEN finding."proposedFix"->>'kind' = ${productRelinkIntent.shape.kind.value}
    THEN CASE WHEN finding."entityKind" = ${entitySchema.enum.expense}
      AND finding."proposedFix"->>'expenseId' = finding."entityId"::text
      THEN ${workExpenseSourceOwners(sql`finding."entityId"`)}
      ELSE ARRAY[NULL::uuid] END
    ELSE CASE finding."entityKind"
    WHEN ${entitySchema.enum.purchase} THEN ${workPurchaseOwners(sql`finding."entityId"`)}
    WHEN ${entitySchema.enum.expense} THEN ${workExpenseOwners(sql`finding."entityId"`)}
    WHEN ${entitySchema.enum.email} THEN ARRAY(SELECT e."ledgerPartyId" FROM "Email" e WHERE e.id = finding."entityId" AND e."deletedAt" IS NULL)
    ELSE ${workRunReviewOwners(sql`finding."runId"`)} END END`;
  const findingRecord = scope.record
    ? sql` AND identity.kind = ${scope.record.entity} AND identity.shortcode = ${scope.record.id}`
    : sql``;
  if (!scope.check)
    selections.push(sql`SELECT identity.kind AS entity, identity.shortcode AS id,
    finding.summary AS name, 'finding:' || finding.id::text AS key,
    ${workQueueSourceSchema.enum.finding}::text AS source, ${workQueueKindSchema.enum.review}::text AS kind, finding.summary AS reason,
    'Open the retained source and review the proposed correction.'::text AS "nextAction",
    CASE WHEN cardinality(authority.owners) > 0 AND NOT EXISTS (
      SELECT 1 FROM unnest(authority.owners) owner WHERE owner IS NULL OR owner <> finding."ledgerPartyId"
    ) THEN ARRAY[finding."ledgerPartyId"] ELSE ARRAY[NULL::uuid] END AS owners,
    false AS shared, NULL::text AS "problemKey",
    ${workRecordFactColumns(sql`identity.kind`, sql`finding."entityId"`, scope.facts)}
    FROM "RunFinding" finding
    JOIN "Entity" identity ON identity.id = finding."entityId" AND identity.kind = finding."entityKind" AND identity."deletedAt" IS NULL
    CROSS JOIN LATERAL (SELECT ${findingSources} AS owners) authority
    WHERE finding.status = ${openFindingStatus} AND NOT ${obsoleteExecutionFindingSql("finding")} AND (finding."expiresAt" IS NULL OR finding."expiresAt" > now())${findingRecord}
  `);
  selections.push(
    ...workQueueCandidate(scope, {
      entity: "run",
      table: sql`"Run"`,
      id: sql`"Run".shortcode`,
      name: sql`"Run".purpose || ' · ' || "Run".status`,
      owners: workRunReviewOwners(sql`"Run".id`),
      where: sql`"Run"."deletedAt" IS NULL AND (
        (${attentionStatePredicate(sql`"Run".status`)} AND "Run".status <> ${runStatus.enum.needs_review}
          AND NOT EXISTS (SELECT 1 FROM "RunFinding" finding WHERE finding."runId" = "Run".id AND finding.status = ${openFindingStatus} AND (finding."expiresAt" IS NULL OR finding."expiresAt" > now())))
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
  selections.push(...(await problemSelections(db, scope)));
  // A scope that admits no branch still yields a typed, empty relation.
  if (selections.length === 0)
    return sql`SELECT NULL::text AS entity, NULL::text AS id, NULL::text AS name,
      NULL::text AS key, NULL::text AS source, NULL::text AS kind, NULL::text AS reason,
      NULL::text AS "nextAction", ARRAY[]::uuid[] AS owners, false AS shared,
      NULL::text AS "problemKey", ${NO_FACT_COLUMNS} WHERE false`;
  return sql.join(selections, sql` UNION ALL `);
}

const fieldLabel = (entity: Entity, field: string) => {
  const suggested = z.enum(shortcodeEntities).safeParse(entity);
  return (
    (suggested.success
      ? entityFieldByKey(suggested.data, field)?.label
      : undefined) ?? field
  );
};

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
  const qualities = await loadDataQualities(db, entity, [...ids.values()]);
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

async function queryWorkQueue(
  db: Database,
  problemSelections: WorkProblemSelections,
  currentPartyId: LedgerPartyId | null,
  input: QueueInput,
  memberOnly: boolean,
  record?: WorkQueueScope["record"],
) {
  const sorts = workQueueSortSchema.parse(
    normalizeSorts(input.sort ?? [{ orderBy: "kind", direction: "asc" }]),
  );
  const facts = (["amount", "date", "vendor"] as const).filter(
    (fact) =>
      sorts.some((sort) => sort.orderBy === fact) ||
      (fact === "vendor" && input.vendor !== undefined),
  );
  const candidateConditions: SQL[] = [];
  if (input.source) candidateConditions.push(sql`source = ${input.source}`);
  if (input.kind) candidateConditions.push(sql`kind = ${input.kind}`);
  const projection = await workQueueProjection(
    db,
    {
      source: input.source,
      kind: input.kind,
      check: input.check === undefined ? undefined : [input.check].flat(),
      record,
      facts,
    },
    problemSelections,
  );
  // All sources, including findings, defer planned purchases before counts
  // and paging. An empty purchase is unknown, not implicitly planned.
  const conditions: SQL[] = [
    sql`(routed.entity IS DISTINCT FROM ${entitySchema.enum.purchase} OR NOT EXISTS (
    SELECT 1 FROM "Purchase" planned WHERE planned.shortcode = routed.id AND planned."deletedAt" IS NULL
      AND (planned.date > ${householdLocalDate(new Date())}::date OR (
        EXISTS (SELECT 1 FROM "Expense" line WHERE line."purchaseId" = planned.id AND line."deletedAt" IS NULL)
        AND NOT EXISTS (SELECT 1 FROM "Expense" line WHERE line."purchaseId" = planned.id AND line."deletedAt" IS NULL AND line.future = false)
      ))
  ))`,
  ];
  if (memberOnly)
    conditions.push(
      sql`(waiting_kind = ${either} OR (waiting_kind = ${members} AND ${currentPartyId}::uuid = ANY(owners) AND NOT EXISTS (SELECT 1 FROM unnest(owners) owner WHERE owner <> ${currentPartyId}::uuid)))`,
    );
  else if (input.waitingFor === "me")
    conditions.push(
      sql`(waiting_kind = ${either} OR (waiting_kind = ${members} AND ${currentPartyId}::uuid = ANY(owners)))`,
    );
  else if (input.waitingFor === "either" || input.waitingFor === "unresolved")
    conditions.push(sql`waiting_kind = ${input.waitingFor}`);
  else if (input.waitingFor !== "all")
    conditions.push(
      sql`waiting_kind = ${members} AND EXISTS (SELECT 1 FROM members member WHERE member.shortcode = ${input.waitingFor} AND member.id = ANY(owners))`,
    );
  if (input.vendor)
    conditions.push(
      sql`vendor_id = (SELECT v.id FROM "Vendor" v WHERE v.shortcode = ${input.vendor})`,
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
    vendor: sql`(SELECT v.name FROM "Vendor" v WHERE v.id = eligible.vendor_id AND v."deletedAt" IS NULL)`,
  };
  // Every sort places nulls last in both directions; name and key break ties.
  const orderBy = sql.join(
    [
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
    WITH members AS (
      SELECT id, shortcode, name FROM "LedgerParty" WHERE kind = ${ledgerPartyKind.enum.member} AND "deletedAt" IS NULL
    ), candidates AS (${projection}), routed AS MATERIALIZED (
      SELECT candidates.*, CASE
        WHEN shared THEN ${either}
        WHEN cardinality(owners) > 0 AND NOT EXISTS (
          SELECT 1 FROM unnest(owners) owner WHERE owner IS NULL OR NOT EXISTS (SELECT 1 FROM members member WHERE member.id = owner)
        ) THEN ${members} ELSE ${unresolved} END AS waiting_kind
      FROM candidates ${candidateConditions.length ? sql`WHERE ${sql.join(candidateConditions, sql` AND `)}` : sql``}
    ), eligible AS (SELECT * FROM routed WHERE ${sql.join(conditions, sql` AND `)}), ordered AS (
      SELECT * FROM eligible ORDER BY ${orderBy} LIMIT ${input.pageSize} OFFSET ${input.pageIndex * input.pageSize}
    ), page AS (
      SELECT entity, id, name, key, source, kind, reason, "nextAction", owners, shared, "problemKey", waiting_kind,
        row_number() OVER (ORDER BY ${orderBy}) AS position,
        ${workRecordFactColumns(sql`eligible.entity`, sql`eligible.id`, undefined, "shortcode")}
      FROM ordered eligible
    ) SELECT
      (SELECT count(*)::int FROM eligible) AS total,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id', shortcode, 'name', name) ORDER BY name, shortcode) FROM members), '[]'::jsonb) AS members,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'entity', entity, 'id', id, 'name', name, 'key', key, 'source', source, 'kind', kind,
        'reason', reason, 'gaps', '[]'::jsonb, 'dataQuality', 'null'::jsonb, 'amount', amount, 'date', date, 'vendor', ${vendorOf(sql`page.vendor_id`)},
        'nextAction', "nextAction", 'displayImages', '[]'::jsonb, 'waitingFor', CASE waiting_kind
          WHEN ${either} THEN jsonb_build_object('kind', ${either}::text)
          WHEN ${members} THEN jsonb_build_object('kind', ${members}::text, 'members', (SELECT jsonb_agg(jsonb_build_object('id', member.shortcode, 'name', member.name) ORDER BY member.name, member.shortcode) FROM members member WHERE member.id = ANY(page.owners)))
          ELSE jsonb_build_object('kind', ${unresolved}::text, 'reason', 'Current private source ownership is not established.') END
      ) || CASE WHEN "problemKey" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('problemKey', "problemKey") END
        || CASE WHEN source = ${workQueueSourceSchema.enum.suggestion} THEN jsonb_build_object('suggestionField', split_part(key, '.', 2)) ELSE '{}'::jsonb END ORDER BY position) FROM page), '[]'::jsonb) AS items
  `);
  const row = z
    .object({
      total: z.number(),
      members: workQueueOutSchema.shape.members,
      items: workQueueOutSchema.shape.items,
    })
    .parse(result.rows[0]);
  await stateRowQualities(db, row.items);
  for (const item of row.items)
    if (item.entity && item.suggestionField)
      item.name = `${entitySummary[item.entity].singular} · ${fieldLabel(item.entity, item.suggestionField)}`;
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
) => queryWorkQueue(db, problemSelections, currentPartyId, input, memberOnly);

/** One record's rows of the same projection and routing. The record filter is
 * pushed into each branch, so this never plans the whole queue. */
export async function readRecordWorkQueueWith(
  problemSelections: WorkProblemSelections,
  db: Database,
  currentPartyId: LedgerPartyId | null,
  id: string,
  memberOnly: boolean,
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
  );
}
