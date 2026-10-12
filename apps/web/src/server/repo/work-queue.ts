import { suggestionStatus } from "@cubby/schemas/ai";
import { entityRefKey, entitySchema, type Entity } from "@cubby/schemas/entity";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { fieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import { financialTransactionFiltersSchema } from "@cubby/schemas/financial-transaction";
import type { LedgerPartyId } from "@cubby/schemas/identifiers";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party";
import { normalizeSorts } from "@cubby/schemas/pagination";
import { photoGroupProposalState } from "@cubby/schemas/photo-import-run";
import { productFiltersSchema } from "@cubby/schemas/product";
import { expenseFiltersSchema } from "@cubby/schemas/project";
import { purchaseFiltersSchema } from "@cubby/schemas/purchase";
import { proposedImportFix } from "@cubby/schemas/purchase-import";
import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
import {
  workQueueHouseholdInput,
  workQueueKindSchema,
  workQueueSourceSchema,
  workQueueSortSchema,
  workWaitingForSchema,
  workQueueOutSchema,
  type WorkQueueRow,
} from "@cubby/schemas/work-queue";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { compileProblemFilters } from "~/entity/problem-filter-semantics";
import { problemQueryDeclarations } from "~/entity/problem-registry";
import type { Database } from "~/server/db";
import {
  email,
  expense,
  financialAccount,
  financialTransaction,
  product,
  purchase,
  run as runTable,
  suggestion as suggestionTable,
} from "~/server/db/schema";
import { activityAttentionStatePredicate } from "~/server/repo/activity";
import { loadDataQualities } from "~/server/repo/data-quality/hydrate";
import { gapCondition } from "~/server/repo/data-quality/sql";
import { getDb, ilikeContains } from "~/server/repo/database-helpers";
import { buildEmailWhere } from "~/server/repo/email";
import { resolvePublicEntityDisplayImageLists } from "~/server/repo/entity-display-image";
import { buildExpenseWhereClause } from "~/server/repo/expense/lookup";
import { buildFinancialTransactionWhere } from "~/server/repo/financial-transaction";
import { buildProductWhere } from "~/server/repo/product/crud";
import { buildPurchaseWhereClause } from "~/server/repo/purchase";
import { purchaseEvidenceFieldResolutionsSql } from "~/server/repo/purchase-evidence-policy";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";
import { reviewableSuggestionSql } from "~/server/repo/suggestion-review";
import { additionalWorkProblemSelections } from "~/server/repo/work-queue-problems";
import {
  workExpenseOwners,
  workExpenseSourceOwners,
  workPurchaseOwners,
  workPurchaseSourceOwners,
  workRunReviewOwners,
} from "~/server/repo/work-queue-routing";

const either = workWaitingForSchema.options[0].shape.kind.value;
const members = workWaitingForSchema.options[1].shape.kind.value;
const unresolved = workWaitingForSchema.options[2].shape.kind.value;
// RunFinding's retained status column has no generated vocabulary schema.
const openFindingStatus = "open";

type QueueInput = z.infer<typeof workQueueHouseholdInput>;
import { workQueueCandidate } from "~/server/repo/work-queue-projection";
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

/** One read-only relation, shared by household routing and member eligibility. */
async function workQueueProjection(
  db: Database,
  input: QueueInput,
): Promise<SQL> {
  const selections: SQL[] = [];
  const research = {
    source: "research",
    kind: "research",
    reason: "Research queue",
    nextAction: "Review missing facts and add verified evidence.",
  } satisfies Candidate;
  selections.push(
    workQueueCandidate(
      "product",
      sql`${product}`,
      sql`"Product".shortcode`,
      sql`"Product".name`,
      sql`ARRAY[]::uuid[]`,
      await buildProductWhere(
        db,
        productFiltersSchema.parse(viewFilters("product", "research-queue")),
      ),
      research,
      "research:product",
      true,
    ),
  );
  selections.push(
    workQueueCandidate(
      "purchase",
      sql`${purchase}`,
      sql`"Purchase".shortcode`,
      sql`coalesce("Purchase"."displayLabel", "Purchase"."orderId", 'Purchase')`,
      workPurchaseSourceOwners(sql`"Purchase".id`),
      await buildPurchaseWhereClause(
        db,
        purchaseFiltersSchema.parse(viewFilters("purchase", "research-queue")),
      ),
      research,
      "research:purchase",
    ),
  );
  selections.push(
    workQueueCandidate(
      "expense",
      sql`${expense}`,
      sql`"Expense".shortcode`,
      sql`"Expense".name`,
      workExpenseSourceOwners(sql`"Expense".id`),
      await buildExpenseWhereClause(
        db,
        expenseFiltersSchema.parse(viewFilters("expense", "research-queue")),
      ),
      research,
      "research:expense",
    ),
  );
  selections.push(
    workQueueCandidate(
      "email",
      sql`${email}`,
      sql`"Email".shortcode`,
      sql`coalesce("Email".subject, 'Email')`,
      sql`ARRAY["Email"."ledgerPartyId"]`,
      buildEmailWhere(viewFilters("email", "pipeline-worklist")),
      {
        source: "email",
        kind: "review",
        // Replaced by the row's own pipeline gaps after paging.
        reason: "Email pipeline gap",
        nextAction: "Review relevance, retained original and import status.",
      },
      "email",
    ),
  );
  // One row per suggested field, never one per Suggestion: the Review list
  // is where each is accepted or rejected.
  selections.push(sql`SELECT ${suggestionTable.entity}::text AS entity, NULL::text AS id,
    ${suggestionTable.entity} || '.' || ${suggestionTable.field} AS name,
    'suggestion:' || ${suggestionTable.entity} || '.' || ${suggestionTable.field} AS key,
    ${workQueueSourceSchema.enum.suggestion}::text AS source, ${workQueueKindSchema.enum.review}::text AS kind,
    count(*)::text || CASE WHEN count(*) = 1 THEN ' pending suggestion' ELSE ' pending suggestions' END AS reason,
    'Accept or reject them in AI Review.'::text AS "nextAction",
    ARRAY[]::uuid[] AS owners, true AS shared, NULL::text AS "problemKey"
    FROM ${suggestionTable} JOIN ${runTable} ON ${runTable.id} = ${suggestionTable.runId}
    WHERE ${suggestionTable.status} = ${suggestionStatus.enum.pending} AND ${reviewableSuggestionSql}
    GROUP BY ${suggestionTable.entity}, ${suggestionTable.field}`);

  for (const definition of problemQueryDeclarations()) {
    const source = definition.source;
    if (
      source.kind !== "entity" ||
      !["purchase", "expense", "financialTransaction"].includes(source.entity)
    )
      continue;
    const details = {
      source: "reconciliation",
      kind: "repair",
      reason: definition.title,
      nextAction: definition.description,
    } satisfies Candidate;
    const filters = compileProblemFilters(source.entity, source.filters);
    if (source.entity === "purchase")
      selections.push(
        workQueueCandidate(
          "purchase",
          sql`${purchase}`,
          sql`"Purchase".shortcode`,
          sql`coalesce("Purchase"."displayLabel", "Purchase"."orderId", 'Purchase')`,
          workPurchaseOwners(sql`"Purchase".id`),
          await buildPurchaseWhereClause(
            db,
            purchaseFiltersSchema.parse(filters),
          ),
          details,
          definition.key,
        ),
      );
    else if (source.entity === "expense")
      selections.push(
        workQueueCandidate(
          "expense",
          sql`${expense}`,
          sql`"Expense".shortcode`,
          sql`"Expense".name`,
          workExpenseOwners(sql`"Expense".id`),
          await buildExpenseWhereClause(
            db,
            expenseFiltersSchema.parse(filters),
          ),
          details,
          definition.key,
        ),
      );
    else
      selections.push(
        workQueueCandidate(
          "financialTransaction",
          sql`${financialTransaction}`,
          sql`"FinancialTransaction".shortcode`,
          sql`coalesce("FinancialTransaction".merchant, "FinancialTransaction"."rawDescription", 'Financial transaction')`,
          sql`ARRAY(SELECT account."ledgerPartyId" FROM "FinancialAccount" account WHERE account.id = "FinancialTransaction"."accountId" AND account."deletedAt" IS NULL)`,
          await buildFinancialTransactionWhere(
            db,
            financialTransactionFiltersSchema.parse(filters),
          ),
          details,
          definition.key,
        ),
      );
  }
  selections.push(
    workQueueCandidate(
      "financialAccount",
      sql`${financialAccount}`,
      sql`"FinancialAccount".shortcode`,
      sql`"FinancialAccount".name`,
      sql`ARRAY["FinancialAccount"."ledgerPartyId"]`,
      sql`"FinancialAccount"."deletedAt" IS NULL AND ${gapCondition("financialAccount", "financial_account_unclaimed")}`,
      {
        source: "account",
        kind: "review",
        reason: "Provisional financial account",
        nextAction: "Claim the account using provider evidence.",
      },
      "account:provisional",
    ),
  );

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
  selections.push(sql`SELECT identity.kind AS entity, identity.shortcode AS id,
    finding.summary AS name, 'finding:' || finding.id::text AS key,
    ${workQueueSourceSchema.enum.finding}::text AS source, ${workQueueKindSchema.enum.review}::text AS kind, finding.summary AS reason,
    'Open the retained source and review the proposed correction.'::text AS "nextAction",
    CASE WHEN cardinality(authority.owners) > 0 AND NOT EXISTS (
      SELECT 1 FROM unnest(authority.owners) owner WHERE owner IS NULL OR owner <> finding."ledgerPartyId"
    ) THEN ARRAY[finding."ledgerPartyId"] ELSE ARRAY[NULL::uuid] END AS owners,
    false AS shared, NULL::text AS "problemKey"
    FROM "RunFinding" finding
    JOIN "Entity" identity ON identity.id = finding."entityId" AND identity.kind = finding."entityKind" AND identity."deletedAt" IS NULL
    CROSS JOIN LATERAL (SELECT ${findingSources} AS owners) authority
    WHERE finding.status = ${openFindingStatus} AND (finding."expiresAt" IS NULL OR finding."expiresAt" > now())
  `);
  selections.push(
    workQueueCandidate(
      "run",
      sql`"Run"`,
      sql`"Run".shortcode`,
      sql`"Run".purpose || ' · ' || "Run".status`,
      workRunReviewOwners(sql`"Run".id`),
      sql`"Run"."deletedAt" IS NULL AND (
        (${activityAttentionStatePredicate(sql`"Run".status`)} AND "Run".status <> ${runStatus.enum.needs_review}
          AND NOT EXISTS (SELECT 1 FROM "RunFinding" finding WHERE finding."runId" = "Run".id AND finding.status = ${openFindingStatus} AND (finding."expiresAt" IS NULL OR finding."expiresAt" > now())))
        OR ("Run".purpose = ${runPurpose.enum.photo_inventory} AND EXISTS (
          SELECT 1 FROM "PhotoGroupProposal" proposal WHERE proposal."runId" = "Run".id AND proposal.state = ${photoGroupProposalState.enum.proposed}
        ))
      )`,
      {
        source: "account",
        kind: "review",
        reason: "Run needs attention",
        nextAction:
          "Inspect retained Run status and transcript. Choose any retry or continuation explicitly.",
      },
      "account:run",
    ),
  );
  selections.push(...(await additionalWorkProblemSelections(db, input)));
  return sql.join(selections, sql` UNION ALL `);
}

const GAP_ROWS = [
  { entity: "product", source: "research", view: "research-queue" },
  { entity: "purchase", source: "research", view: "research-queue" },
  { entity: "expense", source: "research", view: "research-queue" },
  { entity: "email", source: "email", view: "pipeline-worklist" },
] as const;

const fieldLabel = (entity: Entity, field: string) => {
  const suggested = z.enum(shortcodeEntities).safeParse(entity);
  return (
    (suggested.success
      ? entityFieldByKey(suggested.data, field)?.label
      : undefined) ?? field
  );
};

/** Each row states its own gaps (an Email's missing original, a Purchase's
 * required receipt and the policy that requires it), not a generic reason. */
async function stateRowGaps(db: Database, items: WorkQueueRow[]) {
  for (const { entity, source, view } of GAP_ROWS) {
    const rows = items.filter(
      (item) => item.entity === entity && item.source === source,
    );
    if (rows.length === 0) continue;
    const ids = await resolveLiveShortcodes(
      db,
      rows.flatMap((item) => (item.id ? [item.id] : [])),
      entity,
    );
    const qualities = await loadDataQualities(db, entity, [...ids.values()]);
    const relevantChecks = new Set([viewFilters(entity, view).dataGap].flat());
    const policies =
      entity === "purchase"
        ? await purchaseEvidencePolicies(db, [...ids.values()])
        : new Map<string, string>();
    for (const item of rows) {
      const id = item.id ? ids.get(item.id) : undefined;
      const quality = id ? qualities.get(id) : undefined;
      if (!id || !quality) continue;
      const messages = [...quality.gaps, ...quality.relatedGaps]
        .filter((gap) => relevantChecks.has(gap.check))
        .map((gap) =>
          gap.check === "primary_document"
            ? (policies.get(id) ?? gap.message)
            : gap.message,
        );
      if (messages.length) item.reason = [...new Set(messages)].join("; ");
    }
  }
}

const POLICY_SOURCE_TEXT = {
  "purchase override": "set on this purchase",
  "vendor policy": "inherited from Vendor",
  "spending category policy": "inherited from Spending category",
  "unclassified policy": "no policy source",
} as const;

/** "Receipt required — inherited from Spending category Hardware": only a
 * `required` expectation raises `primary_document`, so the row names where
 * that expectation came from. */
async function purchaseEvidencePolicies(db: Database, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const result = await getDb(db).execute(sql`
    SELECT "Purchase".id::text AS id, ${purchaseEvidenceFieldResolutionsSql("Purchase")} AS resolutions
    FROM "Purchase" WHERE "Purchase".id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`);
  const rows = z
    .array(z.object({ id: z.string(), resolutions: fieldResolutionsSchema }))
    .parse(result.rows);
  return new Map(
    rows.flatMap(({ id, resolutions }) => {
      const policy = resolutions.evidenceExpectation;
      if (!policy || policy.value !== "required") return [];
      const origin =
        new Map<string, string>(Object.entries(POLICY_SOURCE_TEXT)).get(
          policy.source,
        ) ?? policy.source;
      // An override's sourceEntity is the fallback it overrides, not its origin.
      const name =
        policy.mode === "explicit" ? null : policy.sourceEntity?.name;
      return [
        [
          id,
          `Receipt required — ${origin}${name ? ` ${name}` : ""}; none is attached.`,
        ],
      ];
    }),
  );
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

/** Authority is an implicit argument supplied only by the authenticated operation context. */
export async function readWorkQueue(
  db: Database,
  currentPartyId: LedgerPartyId | null,
  input: QueueInput,
  memberOnly: boolean,
) {
  const projection = await workQueueProjection(db, input);
  const conditions: SQL[] = [sql`true`];
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
  if (input.kind) conditions.push(sql`kind = ${input.kind}`);
  if (input.source) conditions.push(sql`source = ${input.source}`);
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
  };
  const sorts = workQueueSortSchema.parse(
    normalizeSorts(input.sort ?? [{ orderBy: "kind", direction: "asc" }]),
  );
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
  // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- JSON property names below are the response contract, not vocabulary values.
  const result = await getDb(db).execute(sql`
    WITH members AS (
      SELECT id, shortcode, name FROM "LedgerParty" WHERE kind = ${ledgerPartyKind.enum.member} AND "deletedAt" IS NULL
    ), candidates AS (${projection}), routed AS (
      SELECT candidates.*, CASE
        WHEN shared THEN ${either}
        WHEN cardinality(owners) > 0 AND NOT EXISTS (
          SELECT 1 FROM unnest(owners) owner WHERE owner IS NULL OR NOT EXISTS (SELECT 1 FROM members member WHERE member.id = owner)
        ) THEN ${members} ELSE ${unresolved} END AS waiting_kind
      FROM candidates
    ), eligible AS (SELECT * FROM routed WHERE ${sql.join(conditions, sql` AND `)}), ordered AS (
      SELECT *, row_number() OVER (ORDER BY ${orderBy}) AS position FROM eligible
    ), page AS (
      SELECT * FROM ordered ORDER BY position LIMIT ${input.pageSize} OFFSET ${input.pageIndex * input.pageSize}
    ) SELECT
      (SELECT count(*)::int FROM eligible) AS total,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id', shortcode, 'name', name) ORDER BY name, shortcode) FROM members), '[]'::jsonb) AS members,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'entity', entity, 'id', id, 'name', name, 'key', key, 'source', source, 'kind', kind,
        'reason', reason, 'nextAction', "nextAction", 'displayImages', '[]'::jsonb, 'waitingFor', CASE waiting_kind
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
  await stateRowGaps(db, row.items);
  for (const item of row.items)
    if (item.entity && item.suggestionField)
      item.name = `${entitySummary[item.entity].singular} · ${fieldLabel(item.entity, item.suggestionField)}`;
  // Member routing fences rows, not imagery borrowed through linked records
  // (a transaction's purchase receipts), so member reads carry none.
  if (!memberOnly) await attachDisplayImages(db, row.items);
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
