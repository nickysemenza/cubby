import { suggestionStatus } from "@cubby/schemas/ai";
import {
  suggestionFamily,
  suggestionJudgments,
  mailDecisionFamily,
  type SuggestionFamily,
  type MailDecisionFamily,
} from "@cubby/schemas/suggestion";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import {
  statementTransactionAction,
  statementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import { suggestionRecordRef } from "@cubby/schemas/suggestion-list";
import { parseShortcode } from "@cubby/shared";
import {
  and,
  eq,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db";
import { hasTextSql } from "~/server/db/computed/text-whitespace";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { outer, type RelatedColumns } from "~/server/db/helpers/related";
import { suggestionTable, run } from "~/server/db/schema";
import { financialSourceReferenceRows } from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import { transactionImportMembers } from "~/server/domains/transaction-import/repo/transaction-import-membership";
import {
  recommendationScopes,
  type SuggestionRecordSelection,
} from "~/server/generic/suggestions/repo/pending-admission";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
export { pendingRecommendationEligibility } from "~/server/generic/suggestions/repo/pending-admission";

const reviewSuggestion = alias(suggestionTable, "s");
const reviewState = reviewSuggestion;

const referenceEntity = z.enum(shortcodeEntities);
const entities = referenceEntity.enum;
type DecisionValue = z.infer<ReturnType<typeof z.json>>;
const ref = (entity: SQL, id: SQL) =>
  sql`jsonb_build_object('entity', (${entity})::text, 'id', (${id})::text)`;
const primary = ref(sql`s.entity`, sql`s."recordId"::text`);
const one = sql`jsonb_build_array(${primary})`;
const reviewQueryBuilder = new QueryBuilder();
/** Match stored UUID/shortcode references without constructing display JSON. */
function relatedRecordMatch(
  scope: SuggestionRecordScope,
  entity: string | SQL,
  id: SQL<string>,
): SQL | undefined {
  if (typeof entity === "string") {
    if (scope.entity && scope.entity !== entity) return undefined;
    const records = scope.records?.filter((record) => record.entity === entity);
    if (records?.length === 0) return undefined;
    return records
      ? inArray(
          id,
          records.flatMap((record) => [record.id, record.code]),
        )
      : isNotNull(id);
  }
  // One ID predicate per kind keeps both composite-index keys in the scan.
  // Pairwise ORs can leave batch IDs as filters over every wide evidence row.
  const idsByEntity = new Map<string, string[]>();
  for (const record of scope.records ?? []) {
    const ids = idsByEntity.get(record.entity) ?? [];
    ids.push(record.id, record.code);
    idsByEntity.set(record.entity, ids);
  }
  return and(
    isNotNull(id),
    scope.entity ? eq(entity, scope.entity) : undefined,
    scope.records
      ? or(
          ...Array.from(idsByEntity, ([kind, ids]) =>
            and(eq(entity, kind), inArray(id, ids)),
          ),
        )
      : undefined,
  );
}

function fieldReferenceMatch(scope: SuggestionRecordScope) {
  return or(
    ...Object.entries(entityFieldModels).flatMap(([entity, model]) =>
      model.fields.flatMap((field) => {
        const target = referenceEntity.safeParse(field.reference?.entity);
        if (!target.success) return [];
        const match = relatedRecordMatch(
          scope,
          target.data,
          sql<string>`COALESCE(v->>'id', v #>> '{}')`,
        );
        if (!match) return [];
        const values = (value: SQL) =>
          sql`CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE jsonb_build_array(${value}) END`;
        return [
          and(
            eq(reviewState.entity, entity),
            eq(reviewState.field, field.key),
            sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${values(sql`s."suggestedValue"`)} || ${values(sql`s."currentValue"`)}) v WHERE ${match})`,
          )!,
        ];
      }),
    ),
  );
}

const fieldReferencesFor = (requested?: readonly string[]) => {
  const referenceFields = Object.entries(entityFieldModels).flatMap(
    ([entity, model]) =>
      model.fields.flatMap((field) => {
        const target = referenceEntity.safeParse(field.reference?.entity);
        if (!target.success || (requested && !requested.includes(target.data)))
          return [];
        const values = (value: SQL) =>
          sql`CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE jsonb_build_array(${value}) END`;
        return [
          sql`WHEN s.entity = ${entity} AND s.field = ${field.key} THEN COALESCE((SELECT jsonb_agg(${ref(sql`${target.data}`, sql`COALESCE(v->>'id', v #>> '{}')`)})
    FROM jsonb_array_elements(${values(sql`s."suggestedValue"`)} || ${values(sql`s."currentValue"`)}) v), '[]'::jsonb)`,
        ];
      }),
  );
  return referenceFields.length
    ? sql`CASE ${sql.join(referenceFields, sql` `)} ELSE '[]'::jsonb END`
    : sql`'[]'::jsonb`;
};
const fieldRecords = (requested?: readonly string[]) =>
  sql`${one} || ${fieldReferencesFor(requested)}`;

const endpoint = (end: "source" | "target") =>
  ref(
    sql`s.evidence->'candidate'->${end}->>'entityKind'`,
    sql`s.evidence->'candidate'->${end}->>'entityId'`,
  );
const leg = (end: "outflow" | "inflow") => sql`jsonb_build_array(
  ${ref(sql`${entities.financialAccount}`, sql`s.judgment->${end}->>'accountId'`)},
  ${ref(sql`${entities.financialTransaction}`, sql`s.judgment->${end}->>'transactionId'`)},
  ${ref(sql`${entities.ledgerParty}`, sql`s.judgment->${end}->'owner'->>'id'`)})`;

const statementSettlementRelation = sql`"FinancialTransaction" settled
  JOIN "FinancialAccount" account ON account.id=settled."accountId"
  LEFT JOIN "FinancialTransactionAllocation" allocation ON allocation."transactionId"=settled.id AND ${notDeleted("allocation")}
  LEFT JOIN "Purchase" booked ON booked.id=allocation."purchaseId" AND ${notDeleted("booked")}
  LEFT JOIN "Expense" line ON line."purchaseId"=booked.id AND ${notDeleted("line")}`;
const statementSettlementEligibility = notDeleted("settled");
const statementSettlementFrom = sql`FROM ${statementSettlementRelation}
  JOIN ${financialSourceReferenceRows} evidence ON evidence.owner=settled.id`;
const statementSettlementScope = sql`${statementSettlementEligibility}
  AND evidence.source=s.judgment #>> '{create,sourceRef,source}'
  AND evidence."externalId"=s.judgment #>> '{create,sourceRef,externalId}'`;
// Consolidation retires an old SOC handle; the primary record still reaches its accepted survivor.
const statementAcceptedSettlementFrom = sql`FROM "SourceTransactionRecord" anchor
  JOIN "SourceOccurrence" owner ON owner.id=anchor."occurrenceId"
  JOIN (${statementSettlementRelation}) ON settled.id=owner."acceptedTransactionId"`;
const statementAcceptedSettlementScope = sql`anchor.id=s."recordId" AND ${statementSettlementEligibility}`;
const statementSettlementRefs = [
  { entity: entities.financialTransaction, id: sql<string>`settled.id` },
  { entity: entities.purchase, id: sql<string>`booked.id` },
  { entity: entities.expense, id: sql<string>`line.id` },
  { entity: entities.vendor, id: sql<string>`booked."vendorId"` },
  { entity: entities.ledgerParty, id: sql<string>`account."ledgerPartyId"` },
];

/** Narrow requested reference kinds before expanding candidate and settlement graphs. */
function statementRecordParts(
  requested?: readonly string[],
  withSettlements = true,
) {
  const includes = (entity: string) => !requested || requested.includes(entity);
  const parts: SQL[] = [];
  const add = (entity: string, id: SQL) => {
    if (includes(entity))
      parts.push(sql`jsonb_build_array(${ref(sql`${entity}`, id)})`);
  };
  // recordId remains authoritative when retained advice still stores a legacy charge key.
  const sourceFrom = sql`FROM "SourceTransactionRecord" anchor
    JOIN "SourceTransactionRecord" observed ON observed."occurrenceId" = anchor."occurrenceId"
    WHERE anchor.id = s."recordId" AND ${notDeleted("observed")}`;
  if (includes(entities.sourceTransactionRecord))
    parts.push(sql`COALESCE((SELECT jsonb_agg(${ref(sql`${entities.sourceTransactionRecord}`, sql`observed.id::text`)})
      ${sourceFrom}), '[]'::jsonb)`);
  if (includes(entities.sourceOccurrence))
    parts.push(sql`COALESCE((SELECT jsonb_build_array(${ref(sql`${entities.sourceOccurrence}`, sql`anchor."occurrenceId"::text`)})
      FROM "SourceTransactionRecord" anchor WHERE anchor.id = s."recordId"), '[]'::jsonb)`);
  if (includes(entities.transactionImport))
    parts.push(sql`COALESCE((SELECT jsonb_agg(DISTINCT ${ref(sql`${entities.transactionImport}`, sql`member."importId"::text`)})
      FROM "SourceTransactionRecord" anchor
      JOIN "SourceTransactionRecord" observed ON observed."occurrenceId" = anchor."occurrenceId"
      JOIN ${transactionImportMembers} member ON member."statementRowId" = observed.id
      WHERE anchor.id = s."recordId" AND ${notDeleted("observed")}), '[]'::jsonb)`);
  add(entities.financialAccount, sql`s.data->>'accountId'`);
  add(
    entities.financialTransaction,
    sql`s.judgment->${statementTransactionAction.enum.supersede}->>'pendingTransactionId'`,
  );
  add(
    entities.financialTransaction,
    sql`s.judgment->${statementTransactionAction.enum.void}->>'transactionId'`,
  );
  add(entities.financialTransaction, sql`s.judgment->>'matchedTransactionId'`);
  add(
    entities.vendor,
    sql`(SELECT v.id::text FROM "Vendor" v WHERE v.shortcode=s.judgment->${statementTransactionJudgment.keyof().enum.spending}->>'vendorId' AND ${notDeleted("v")})`,
  );
  add(
    entities.spendingCategory,
    sql`(SELECT category.id::text FROM "SpendingCategory" category WHERE category.shortcode=s.judgment->${statementTransactionJudgment.keyof().enum.spending}->>'spendingCategoryId' AND ${notDeleted("category")})`,
  );
  const related = statementSettlementRefs.filter(
    ({ entity }) => withSettlements && includes(entity),
  );
  if (related.length) {
    parts.push(sql`COALESCE((SELECT jsonb_agg(${ref(sql`related.kind`, sql`related.id`)})
        ${statementSettlementFrom}
        CROSS JOIN LATERAL (VALUES ${sql.join(
          related.map(({ entity, id }) => sql`(${entity},${id})`),
          sql`, `,
        )}) related(kind,id)
        WHERE ${statementSettlementScope}
          AND related.id IS NOT NULL), '[]'::jsonb)`);
    parts.push(sql`COALESCE((SELECT jsonb_agg(${ref(sql`related.kind`, sql`related.id`)})
        ${statementAcceptedSettlementFrom}
        CROSS JOIN LATERAL (VALUES ${sql.join(
          related.map(({ entity, id }) => sql`(${entity},${id})`),
          sql`, `,
        )}) related(kind,id)
        WHERE ${statementAcceptedSettlementScope}
          AND related.id IS NOT NULL), '[]'::jsonb)`);
  }
  if (includes(entities.purchase))
    parts.push(sql`COALESCE((SELECT jsonb_agg(${ref(sql`${entities.purchase}`, sql`p.id::text`)})
        FROM jsonb_array_elements(COALESCE(s.judgment->${statementTransactionJudgment.keyof().enum.spending}->'candidates','[]'::jsonb)) candidate
        JOIN "Purchase" p ON p.shortcode=candidate->>'purchaseId' AND ${notDeleted("p")}), '[]'::jsonb)`);
  if (includes(entities.financialTransaction))
    parts.push(
      sql`COALESCE((SELECT jsonb_agg(${ref(sql`${entities.financialTransaction}`, sql`c->>'transactionId'`)}) FROM jsonb_array_elements(s.judgment->'candidates') c), '[]'::jsonb)`,
    );
  return parts;
}

function statementRecords(requested?: readonly string[]) {
  const parts = statementRecordParts(requested);
  return parts.length ? sql.join(parts, sql` || `) : sql`'[]'::jsonb`;
}

/** Reference expansion and settlement joins stay owned by the Statement reader. */
function recordRefsMatch(scope: SuggestionRecordScope, refs: SQL) {
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${refs}) r
    WHERE ${relatedRecordMatch(scope, sql`r->>'entity'`, sql<string>`r->>'id'`)})`;
}

function statementSettlementMatch(scope: SuggestionRecordScope) {
  const settled = statementSettlementRefs.flatMap(({ entity, id }) => {
    if (scope.entity && scope.entity !== entity) return [];
    const records = scope.records?.filter((record) => record.entity === entity);
    if (records?.length === 0) return [];
    // Resolved UUIDs keep the relation's primary-key lookup available. Display
    // JSON instead casts every linked id to text before applying the scope.
    return [
      records
        ? sql`${id} = ANY(${uuidArrayParam(records.map((record) => record.id))})`
        : isNotNull(id),
    ];
  });
  return or(...settled);
}

/** Reverse collection reach starts with physical membership, never every suggestion's observation projection. */
function statementSourceMatch(scope: SuggestionRecordScope) {
  const branches = [
    entities.sourceTransactionRecord,
    entities.sourceOccurrence,
    entities.transactionImport,
  ].flatMap((entity) => {
    if (scope.entity && scope.entity !== entity) return [];
    const records = scope.records?.filter((record) => record.entity === entity);
    if (records?.length === 0) return [];
    const id =
      entity === entities.transactionImport
        ? sql`member."importId"`
        : entity === entities.sourceOccurrence
          ? sql`seed."occurrenceId"`
          : sql`seed.id`;
    const match = records
      ? sql`${id} = ANY(${uuidArrayParam(records.map((record) => record.id))})`
      : sql`${id} IS NOT NULL`;
    return [
      sql`s."recordId" IN (
      SELECT sibling.id FROM ${entity === entities.transactionImport ? sql`${transactionImportMembers} member JOIN "SourceTransactionRecord" seed ON seed.id = member."statementRowId"` : sql`"SourceTransactionRecord" seed`}
      JOIN "SourceTransactionRecord" sibling ON sibling."occurrenceId" = seed."occurrenceId"
      WHERE ${match} AND ${notDeleted("seed")})`,
    ];
  });
  return branches;
}

function statementReferenceMatch(
  scope: SuggestionRecordScope,
  withSettlements = true,
) {
  const sourceEntities: readonly string[] = [
    entities.sourceTransactionRecord,
    entities.sourceOccurrence,
    entities.transactionImport,
  ];
  const requested = scope.entity
    ? [scope.entity]
    : scope.records?.map((r) => r.entity);
  const direct = statementRecordParts(
    (requested ?? shortcodeEntities).filter(
      (entity) => !sourceEntities.includes(entity),
    ),
    false,
  );
  const settled = withSettlements ? statementSettlementMatch(scope) : undefined;
  return [
    ...statementSourceMatch(scope),
    direct.length
      ? recordRefsMatch(scope, sql.join(direct, sql` || `))
      : undefined,
    settled
      ? sql`EXISTS (SELECT 1 ${statementSettlementFrom}
          WHERE ${statementSettlementScope} AND ${settled})`
      : undefined,
    settled
      ? sql`EXISTS (SELECT 1 ${statementAcceptedSettlementFrom}
      WHERE ${statementAcceptedSettlementScope} AND ${settled})`
      : undefined,
  ];
}

/**
 * Families reviewed as Suggestions. Problems findings, grading rosters and mail
 * decisions have their own owners.
 */
export type ReviewFamily = Exclude<
  keyof typeof suggestionReviewFamilies,
  MailDecisionFamily
>;

export const isReviewFamily = (
  family: SuggestionFamily,
): family is ReviewFamily =>
  Object.hasOwn(suggestionReviewFamilies, family) &&
  !mailDecisionFamily.safeParse(family).success;

/** Family declarations own affected roles and both directions of record discovery. */
function declareAffectedRecords(spec: {
  roles: readonly string[];
  forward: (requested?: readonly string[]) => SQL;
  reverse: (scope: SuggestionRecordScope) => readonly (SQL | undefined)[];
}) {
  return {
    affectedRecords: spec,
    records: spec.forward(),
  };
}

function primaryRecordMatch(scope: SuggestionRecordScope) {
  return and(
    scope.entity ? eq(reviewState.entity, scope.entity) : undefined,
    scope.records
      ? or(
          ...scope.records.map((record) =>
            and(
              eq(reviewState.entity, record.entity),
              eq(reviewState.recordId, record.id),
            ),
          ),
        )
      : sql`true`,
  );
}

export const reviewFamilyDeclarations = {
  field: {
    ...suggestionReviewFamilies.field,
    ...declareAffectedRecords({
      roles: ["subject", "current", "proposed"],
      forward: fieldRecords,
      reverse: (scope) => [
        primaryRecordMatch(scope),
        fieldReferenceMatch(scope),
      ],
    }),
    actionable: sql`true`,
    summarize: (value: unknown) =>
      `Set field to ${JSON.stringify(suggestionJudgments.field.parse(value).value)}`,
  },
  recommendation: {
    ...suggestionReviewFamilies.recommendation,
    scopes: recommendationScopes,
    ...declareAffectedRecords({
      roles: ["subject", "source", "target", "retained"],
      forward: () => sql`${one} || CASE WHEN ${recommendationScopes.connection}
      THEN jsonb_build_array(${endpoint("source")}, ${endpoint("target")})
      ELSE COALESCE(s.evidence->'records', '[]'::jsonb) END`,
      reverse: (scope) => {
        let retained: SQL | undefined;
        if (scope.records?.length) {
          const indexed = alias(suggestionTable, "retained_indexed");
          const requestedName = sql.identifier("retained_requested");
          const valueName = sql.identifier("value");
          const membershipName = sql.identifier("retained_membership");
          const needles = scope.records.flatMap((record) =>
            [record.id, record.code].map(
              (id) =>
                sql`${JSON.stringify([{ entity: record.entity, id }])}::jsonb`,
            ),
          );
          const pointQuery = reviewQueryBuilder
            .select({ id: indexed.id })
            .from(indexed)
            .where(
              and(
                indexed.served,
                sql`${indexed.evidence}->'records' @> ${requestedName}.${valueName}`,
              ),
            );
          // One fenced GIN probe per reference avoids scanning every pending
          // recommendation's evidence when the combined OR is estimated broadly.
          const membershipIds = reviewQueryBuilder
            .select({
              id: sql<string>`${membershipName}.${sql.identifier("id")}`,
            })
            .from(
              sql`unnest(ARRAY[${sql.join(needles, sql`, `)}]::jsonb[]) AS ${requestedName}(${valueName})`,
            )
            .innerJoinLateral(
              sql`(${pointQuery.getSQL()} OFFSET 0) AS ${membershipName}`,
              sql`true`,
            );
          retained = inArray(reviewSuggestion.id, membershipIds);
        } else if (!scope.records) {
          retained = sql`EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(s.evidence->'records', '[]'::jsonb)) r
            WHERE ${relatedRecordMatch(scope, sql`r->>'entity'`, sql<string>`r->>'id'`)})`;
        }
        return [
          primaryRecordMatch(scope),
          ...[
            {
              entity: sql<string>`s.evidence #>> '{candidate,source,entityKind}'`,
              id: sql<string>`s.evidence #>> '{candidate,source,entityId}'`,
            },
            {
              entity: sql<string>`s.evidence #>> '{candidate,target,entityKind}'`,
              id: sql<string>`s.evidence #>> '{candidate,target,entityId}'`,
            },
          ].map(({ entity, id }) =>
            and(
              recommendationScopes.connection,
              relatedRecordMatch(scope, entity, id),
            ),
          ),
          retained
            ? and(
                sql`(${recommendationScopes.connection}) IS NOT TRUE`,
                retained,
              )
            : undefined,
        ];
      },
    }),
    actionable: sql`(${sql.join(Object.values(recommendationScopes), sql` OR `)})`,
  },
  product_pair: {
    ...suggestionReviewFamilies.product_pair,
    ...declareAffectedRecords({
      roles: ["subject", "other"],
      forward: () =>
        sql`${one} || jsonb_build_array(${ref(sql`${entities.product}`, sql`s.data->>'otherId'`)})`,
      reverse: (scope) => [
        primaryRecordMatch(scope),
        relatedRecordMatch(
          scope,
          entities.product,
          sql<string>`s.data->>'otherId'`,
        ),
      ],
    }),
    actionable: sql`s.judgment->'actionable' = 'true'::jsonb`,
  },
  image_description: {
    ...suggestionReviewFamilies.image_description,
    ...declareAffectedRecords({
      roles: ["subject"],
      forward: () => one,
      reverse: (scope) => [primaryRecordMatch(scope)],
    }),
    actionable: sql`jsonb_typeof(s.judgment) = 'string' AND ${hasTextSql(sql`s.judgment #>> '{}'`)}`,
  },
  statement_transaction: {
    ...suggestionReviewFamilies.statement_transaction,
    ...declareAffectedRecords({
      roles: [
        "source",
        "occurrence",
        "import",
        "account",
        "candidate",
        "settlement",
      ],
      forward: statementRecords,
      reverse: statementReferenceMatch,
    }),
    actionable: sql`true`,
    summarize: (value: unknown) => {
      const decision = suggestionJudgments.statement_transaction.parse(value);
      return `Statement transaction: ${decision.recommended}`;
    },
  },
  transfer_pair: {
    ...suggestionReviewFamilies.transfer_pair,
    ...declareAffectedRecords({
      roles: ["outflow", "inflow", "account", "transaction", "owner"],
      forward: () => sql`${leg("outflow")} || ${leg("inflow")}`,
      reverse: (scope) =>
        (["outflow", "inflow"] as const).flatMap((end) => [
          relatedRecordMatch(
            scope,
            entities.financialAccount,
            sql<string>`s.judgment->${end}->>'accountId'`,
          ),
          relatedRecordMatch(
            scope,
            entities.financialTransaction,
            sql<string>`s.judgment->${end}->>'transactionId'`,
          ),
          relatedRecordMatch(
            scope,
            entities.ledgerParty,
            sql<string>`s.judgment->${end}->'owner'->>'id'`,
          ),
        ]),
    }),
    actionable: sql`true`,
  },
} satisfies Record<
  ReviewFamily,
  {
    kind: "proposal" | "automatic_decision";
    label: string;
    affectedRecords: Parameters<typeof declareAffectedRecords>[0];
    records: SQL;
    actionable: SQL;
    scopes?: typeof recommendationScopes;
    summarize?: (value: DecisionValue) => string;
  }
>;

/** Rule applications leave pending and name the rule that applied them. */
export function automaticSuggestionEligibility(appliedRule: SQL) {
  return and(
    inArray(
      reviewSuggestion.family,
      Object.keys(reviewFamilyDeclarations).map((family) =>
        suggestionFamily.parse(family),
      ),
    ),
    ne(reviewState.status, suggestionStatus.enum.pending),
    isNotNull(appliedRule),
  );
}

const suggestionRecordsSql = (
  entities?: readonly string[],
  familyColumn: SQL = sql`s.family`,
) =>
  sql`CASE ${sql.join(
    Object.entries(reviewFamilyDeclarations).map(
      ([family, spec]) =>
        sql`WHEN ${familyColumn} = ${family} THEN ${spec.affectedRecords.forward(entities)}`,
    ),
    sql` `,
  )} ELSE '[]'::jsonb END`;

/** The Work reason key suffix for an explicit correction that was never applied. */
export const UNAPPLIED_CORRECTION_REASON = "unapplied_correction";

/**
 * Record tokens per pending suggestion for Work. The large families read only
 * Suggestion columns; small families use their declared records. Tokens are UUIDs
 * or shortcodes, as stored. Current evidence is rechecked when a row is opened.
 */
export function pendingSuggestionRecordsSql(ids?: readonly string[]) {
  const pending = (families: readonly SuggestionFamily[]) =>
    sql`s.family IN (${sql.join(
      families.map((family) => sql`${family}`),
      sql`, `,
    )}) AND s.active AND s.status = ${suggestionStatus.enum.pending}
      ${ids ? sql`AND s.id = ANY(${uuidArrayParam(ids)})` : sql``}`;
  const { recommendation, statement_transaction } = suggestionFamily.enum;
  return sql`SELECT s.family, s.entity, s."recordId"::text AS token
      FROM "Suggestion" s WHERE ${pending([recommendation])}
    UNION ALL
    SELECT s.family, s.data #>> '{connectionTarget,entityKind}', s.data #>> '{connectionTarget,entityId}'
      FROM "Suggestion" s
      WHERE ${pending([recommendation])} AND jsonb_typeof(s.data->'connectionTarget') = 'object'
    -- Statement review belongs to the account, not every settlement reference.
    UNION ALL
    SELECT s.family, ${entities.financialAccount}::text, s.data->>'accountId'
      FROM "Suggestion" s WHERE ${pending([statement_transaction])}
    -- An explicit correction its Suggestion never applied stays a manual notice.
    UNION ALL
    SELECT ${UNAPPLIED_CORRECTION_REASON}::text, s.entity, s."recordId"::text
      FROM "Suggestion" s
      WHERE s.status = ${suggestionStatus.enum.superseded}
        AND s.decisions @> ${JSON.stringify([{ authority: "member", correction: { present: true } }])}::jsonb
        ${ids ? sql`AND s.id = ANY(${uuidArrayParam(ids)})` : sql``}
    UNION ALL
    SELECT s.family, record->>'entity', record->>'id'
      FROM "Suggestion" s
      CROSS JOIN LATERAL jsonb_array_elements(${suggestionRecordsSql(undefined, sql`s.family`)}) record
      WHERE s.served AND ${pending([
        suggestionFamily.enum.field,
        suggestionFamily.enum.transfer_pair,
        suggestionFamily.enum.product_pair,
        suggestionFamily.enum.image_description,
      ])} AND (s.family NOT IN (${suggestionFamily.enum.product_pair}, ${suggestionFamily.enum.image_description}) OR s.suppression IS NULL)`;
}

/** A typed entity plus UUID or shortcode; stored families predate a shared reference representation. */
const storedRef = z.object({
  entity: z.enum(shortcodeEntities),
  id: z.string().min(1),
});
export async function readSuggestionRecordRefs(
  db: Database,
  ids: readonly string[],
  entities?: readonly string[],
) {
  if (!ids.length)
    return new Map<string, z.infer<typeof suggestionRecordRef>[]>();
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    refs: unknown;
  }>(sql`
    SELECT s.id, ${suggestionRecordsSql(entities)} AS refs FROM "Suggestion" s
    WHERE s.id = ANY(${uuidArrayParam(ids)})`);
  return resolveStoredRecordRefs(db, rows);
}

export async function resolveStoredRecordRefs(
  db: Database,
  rows: readonly { id: string; refs: unknown }[],
) {
  const parsed = rows.map((row) => ({
    id: row.id,
    refs: z
      .array(z.unknown())
      .parse(row.refs)
      .flatMap((value) => {
        const result = storedRef.safeParse(value);
        return result.success ? [result.data] : [];
      }),
  }));
  const uuids = parsed.flatMap((row) =>
    row.refs
      .filter((value) => !parseShortcode(value.id))
      .flatMap((value) => {
        const uuid = z.uuid().safeParse(value.id);
        return uuid.success ? [parseEntityRef(value.entity, uuid.data)] : [];
      }),
  );
  const codes = await lookupShortcodes(db, uuids);
  return new Map(
    parsed.map((row) => [
      row.id,
      row.refs
        .flatMap((value) => {
          const code =
            parseShortcode(value.id)?.shortcode ??
            codes.get(entityRefKey(value.entity, value.id));
          const result = suggestionRecordRef.safeParse({
            entity: value.entity,
            id: code,
          });
          return result.success ? [result.data] : [];
        })
        .filter(
          (value, index, all) =>
            all.findIndex(
              (other) => other.entity === value.entity && other.id === value.id,
            ) === index,
        ),
    ]),
  );
}

type SuggestionEligibility =
  | {
      kind: "suggestions";
      families: readonly ReviewFamily[];
      status: z.infer<typeof suggestionStatus>;
      runCode?: string;
    }
  | {
      kind: "automatic";
      family?: ReviewFamily;
      /** The caller's applied-rule expression for an Suggestion id; null when none applied. */
      appliedRule: (suggestionId: SQL) => SQL;
    };

export type SuggestionRecordScope = SuggestionRecordSelection & {
  eligibility: SuggestionEligibility;
};

function suggestionStateAdmission(
  db: Database,
  eligibility: SuggestionEligibility,
  s: Pick<
    RelatedColumns<typeof suggestionTable>,
    "family" | "status" | "active" | "runId"
  > = {
    family: outer(reviewState.family),
    status: outer(reviewState.status),
    active: outer(reviewState.active),
    runId: outer(reviewState.runId),
  },
) {
  if (eligibility.kind === "automatic")
    return and(
      inArray(
        s.family,
        Object.keys(reviewFamilyDeclarations).map((family) =>
          suggestionFamily.parse(family),
        ),
      ),
      eligibility.family ? eq(s.family, eligibility.family) : undefined,
    );
  return and(
    inArray(s.family, [...eligibility.families]),
    eq(s.status, eligibility.status),
    eligibility.status === suggestionStatus.enum.pending ? s.active : undefined,
    eligibility.runCode
      ? eq(
          s.runId,
          unwrapDb(db)
            .select({ id: run.id })
            .from(run)
            .where(eq(run.shortcode, eligibility.runCode)),
        )
      : undefined,
  );
}

/** Settlement-only scopes can discover immutable identities from the graph first. */
function settlementSuggestionQuery(db: Database, scope: SuggestionRecordScope) {
  if (!scope.records?.length) return undefined;
  const match = statementSettlementMatch(scope);
  if (!match) return undefined;
  const keys = reviewQueryBuilder
    .selectDistinct({
      source: sql<string>`evidence.source`.as("source"),
      externalId: sql<string>`evidence."externalId"`.as("externalId"),
    })
    .from(statementSettlementRelation)
    .innerJoin(
      sql`${financialSourceReferenceRows} evidence`,
      sql`evidence.owner=settled.id`,
    )
    .where(and(statementSettlementEligibility, match));
  const keyName = sql.identifier("settlement_keys");
  const keySource = sql<string>`${keyName}.${sql.identifier("source")}`;
  const keyExternalId = sql<string>`${keyName}.${sql.identifier("externalId")}`;
  const indexed = alias(suggestionTable, "settlement_indexed");
  const source = sql<string>`${indexed.judgment} #>> '{create,sourceRef,source}'`;
  const externalId = sql<string>`${indexed.judgment} #>> '{create,sourceRef,externalId}'`;
  // Bounded hashes support unrestricted historical text. Exact comparisons
  // retain identity authority even if two extracted values hash alike.
  const publications = reviewQueryBuilder
    .select({
      id: indexed.id,
      family: indexed.family,
      status: indexed.status,
    })
    .from(indexed)
    .where(
      and(
        indexed.served,
        eq(indexed.family, suggestionFamily.enum.statement_transaction),
        suggestionStateAdmission(db, scope.eligibility, {
          family: outer(indexed.family),
          status: outer(indexed.status),
          active: outer(indexed.active),
          runId: outer(indexed.runId),
        }),
        isNotNull(source),
        isNotNull(externalId),
        eq(sql`md5(${source})`, sql`md5(${keySource})`),
        eq(sql`md5(${externalId})`, sql`md5(${keyExternalId})`),
        eq(source, keySource),
        eq(externalId, keyExternalId),
      ),
    );
  const matched = sql.identifier("settlement_matched");
  const column = (name: string) => sql`${matched}.${sql.identifier(name)}`;
  const retained = unwrapDb(db)
    .select({
      id: sql<string>`${column("id")}`.as("id"),
      family: sql<SuggestionFamily>`${column("family")}`.as("family"),
      immutableFamily: sql<SuggestionFamily>`${column("family")}`.as(
        "immutableFamily",
      ),
      status: sql<string>`${column("status")}`.as("status"),
    })
    .from(sql`(${keys.getSQL()}) AS ${keyName}`)
    .innerJoinLateral(
      sql`(${publications.getSQL()} OFFSET 0) AS ${matched}`,
      sql`true`,
    )
    .getSQL();
  const acceptedKeys = reviewQueryBuilder
    .selectDistinct({
      transactionId: sql<string>`settled.id`.as("transactionId"),
    })
    .from(statementSettlementRelation)
    .where(and(statementSettlementEligibility, match));
  const accepted = sql`SELECT s.id,s.family,s.family AS "immutableFamily",s.status
    FROM (${acceptedKeys.getSQL()}) accepted_keys
    JOIN "SourceOccurrence" owner ON owner."acceptedTransactionId"=accepted_keys."transactionId"
    JOIN "SourceTransactionRecord" anchor ON anchor."occurrenceId"=owner.id
    JOIN "Suggestion" s ON s."recordId"=anchor.id
    WHERE s.served AND s.family=${suggestionFamily.enum.statement_transaction}
      AND ${suggestionStateAdmission(db, scope.eligibility)}`;
  // Both arms start at the requested settlement graph and keep their own lookup indexes.
  return sql`${retained} UNION ALL ${accepted}`;
}

/** Scope identities before expensive automatic receipts; retain a statement-local barrier. */
function touchingSuggestionQuery(db: Database, scope: SuggestionRecordScope) {
  const client = unwrapDb(db);
  const s = reviewState;
  const families =
    scope.eligibility.kind === "suggestions"
      ? scope.eligibility.families
      : scope.eligibility.family
        ? [scope.eligibility.family]
        : Object.keys(reviewFamilyDeclarations)
            .map((family) => suggestionFamily.parse(family))
            .filter(isReviewFamily);
  const stateAdmission = suggestionStateAdmission(db, scope.eligibility);
  const branches = families.flatMap((family) => {
    const settlement =
      family === suggestionFamily.enum.statement_transaction
        ? settlementSuggestionQuery(db, scope)
        : undefined;
    // Candidate/direct reach remains independent when settlement discovery starts at requested FTXs.
    const matches = settlement
      ? statementReferenceMatch(scope, false)
      : reviewFamilyDeclarations[family].affectedRecords.reverse(scope);
    const direct = matches.flatMap((match) =>
      match
        ? [
            client
              .select({
                id: s.id,
                family: s.family,
                immutableFamily: sql<SuggestionFamily>`${s.family}`.as(
                  "immutableFamily",
                ),
                status: s.status,
              })
              .from(s)
              .where(and(s.served, stateAdmission, eq(s.family, family), match))
              .getSQL(),
          ]
        : [],
    );
    return settlement ? [...direct, settlement] : direct;
  });
  const matched = branches.length
    ? sql.join(branches, sql` UNION ALL `)
    : sql`SELECT NULL::uuid AS id, NULL::text AS family, NULL::text AS "immutableFamily", NULL::text AS status WHERE false`;
  if (scope.eligibility.kind === "suggestions") return matched;
  // Keep receipt validation outside identity discovery. Reading the scoped
  // family/status directly prevents the planner from scanning Suggestion again
  // and validating receipts before the matched-id join. Held pending corrections
  // still enter through the same candidate and authority checks.
  return sql`WITH matched AS MATERIALIZED (
    SELECT DISTINCT id, family, status FROM (${matched}) identities)
    SELECT DISTINCT matched.id, matched.family, matched.family AS "immutableFamily"
    FROM matched JOIN "Suggestion" s ON s.id = matched.id
    WHERE ${automaticSuggestionEligibility(scope.eligibility.appliedRule(sql`${s.id}`))}`;
}

/** Adapters use both State and immutable family authority after discovery. */
export async function touchingSuggestionFamilies(
  db: Database,
  scope: SuggestionRecordScope,
): Promise<Map<string, readonly SuggestionFamily[]> | null> {
  if (!scope.entity && !scope.records) return null;
  if (scope.records?.length === 0)
    return new Map<string, readonly SuggestionFamily[]>();
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    family: SuggestionFamily;
    immutableFamily: SuggestionFamily;
  }>(touchingSuggestionQuery(db, scope));
  return new Map(
    rows.map((row) => [row.id, [row.family, row.immutableFamily]]),
  );
}

export async function touchingSuggestionIds(
  db: Database,
  scope: SuggestionRecordScope,
): Promise<Set<string> | null> {
  const touching = await touchingSuggestionFamilies(db, scope);
  return touching ? new Set(touching.keys()) : null;
}

/** Pending image admission shared by Suggestions and record-scoped Work summaries.
 * Callers select from Suggestion s.
 */
export function pendingImageDescriptionEligibility() {
  return sql`s.family = ${suggestionFamily.enum.image_description} AND s.served
    AND s.active AND s.status = ${suggestionStatus.enum.pending}
    AND s.suppression IS NULL AND ${reviewFamilyDeclarations.image_description.actionable}
    AND EXISTS (SELECT 1 FROM "Image" i WHERE i.id = s."recordId" AND ${notDeleted("i")})`;
}
