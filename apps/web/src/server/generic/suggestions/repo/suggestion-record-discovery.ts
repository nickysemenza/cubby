import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import {
  statementTransactionAction,
  statementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import {
  mailDecisionFamily,
  type SuggestionFamily,
  type MailDecisionFamily,
} from "@cubby/schemas/suggestion";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { isNotNull, or, sql, type SQL } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db";
import { notDeleted } from "~/server/db/helpers/predicates";
import { requested } from "~/server/db/helpers/requested";
import { transactionImportRecord } from "~/server/db/retained-tables";
import { suggestionTable } from "~/server/db/schema";
import { financialSourceReferenceRows } from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import type { SuggestionRecordScope } from "~/server/generic/suggestions/repo/suggestion-touching";

export const reviewSuggestion = alias(suggestionTable, "s");

const referenceEntity = z.enum(shortcodeEntities);

export const entities = referenceEntity.enum;

export const ref = (entity: SQL, id: SQL) =>
  sql`jsonb_build_object('entity', (${entity})::text, 'id', (${id})::text)`;

const primary = ref(sql`s.entity`, sql`s."recordId"::text`);

export const one = sql`jsonb_build_array(${primary})`;

export const reviewQueryBuilder = new QueryBuilder();

export const referenceFields = Object.entries(entityFieldModels).flatMap(
  ([entity, model]) =>
    model.fields.flatMap((field) => {
      const target = referenceEntity.safeParse(field.reference?.entity);
      return target.success
        ? [{ entity, field: field.key, target: target.data }]
        : [];
    }),
);
const fieldValues = (value: SQL) =>
  sql`CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE jsonb_build_array(${value}) END`;
const referenceValues = sql`${fieldValues(sql`s."suggestedValue"`)} || ${fieldValues(sql`s."currentValue"`)}`;

const fieldReferencesFor = (requested?: readonly string[]) => {
  const references = referenceFields
    .filter(({ target }) => !requested || requested.includes(target))
    .map(
      ({ entity, field, target }) =>
        sql`WHEN s.entity = ${entity} AND s.field = ${field} THEN COALESCE((SELECT jsonb_agg(${ref(sql`${target}`, sql`COALESCE(v->>'id', v #>> '{}')`)})
    FROM jsonb_array_elements(${referenceValues}) v), '[]'::jsonb)`,
    );
  return references.length
    ? sql`CASE ${sql.join(references, sql` `)} ELSE '[]'::jsonb END`
    : sql`'[]'::jsonb`;
};

export const fieldRecords = (requested?: readonly string[]) =>
  sql`${one} || ${fieldReferencesFor(requested)}`;

export const endpoint = (end: "source" | "target") =>
  ref(
    sql`s.evidence->'candidate'->${end}->>'entityKind'`,
    sql`s.evidence->'candidate'->${end}->>'entityId'`,
  );

export const leg = (end: "outflow" | "inflow") => sql`jsonb_build_array(
  ${ref(sql`${entities.financialAccount}`, sql`s.judgment->${end}->>'accountId'`)},
  ${ref(sql`${entities.financialTransaction}`, sql`s.judgment->${end}->>'transactionId'`)},
  ${ref(sql`${entities.ledgerParty}`, sql`s.judgment->${end}->'owner'->>'id'`)})`;

export const statementSettlementRelation = sql`"FinancialTransaction" settled
  JOIN "FinancialAccount" account ON account.id=settled."accountId"
  LEFT JOIN "FinancialTransactionAllocation" allocation ON allocation."transactionId"=settled.id AND ${notDeleted("allocation")}
  LEFT JOIN "Purchase" booked ON booked.id=allocation."purchaseId" AND ${notDeleted("booked")}
  LEFT JOIN "Expense" line ON line."purchaseId"=booked.id AND ${notDeleted("line")}`;

export const statementSettlementEligibility = notDeleted("settled");

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

export const settlementPaths = [
  [statementSettlementFrom, statementSettlementScope],
  [statementAcceptedSettlementFrom, statementAcceptedSettlementScope],
] as const;

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
      JOIN ${transactionImportRecord} member ON member."statementRowId" = observed.id
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
    for (const [from, where] of settlementPaths)
      parts.push(sql`COALESCE((SELECT jsonb_agg(${ref(sql`related.kind`, sql`related.id`)})
        ${from}
        CROSS JOIN LATERAL (VALUES ${sql.join(
          related.map(({ entity, id }) => sql`(${entity},${id})`),
          sql`, `,
        )}) related(kind,id)
        WHERE ${where}
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

export function statementRecords(requested?: readonly string[]) {
  const parts = statementRecordParts(requested);
  return parts.length ? sql.join(parts, sql` || `) : sql`'[]'::jsonb`;
}

export function statementSettlementMatch(scope: SuggestionRecordScope) {
  const settled = statementSettlementRefs.flatMap(({ entity, id }) => {
    if (scope.entity && scope.entity !== entity) return [];
    const records = scope.records?.filter((record) => record.entity === entity);
    if (records?.length === 0) return [];
    // Resolved UUIDs keep the relation's primary-key lookup available. Display
    // JSON instead casts every linked id to text before applying the scope.
    return [records ? requested(records).match({ entity, id }) : isNotNull(id)];
  });
  return or(...settled);
}

/** Reverse collection reach starts with physical membership, never every suggestion's observation projection. */
export function statementSourceMatch(scope: SuggestionRecordScope) {
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
      ? requested(records).match({ entity, id })
      : sql`${id} IS NOT NULL`;
    return [
      sql`s."recordId" IN (
      SELECT sibling.id FROM ${entity === entities.transactionImport ? sql`${transactionImportRecord} member JOIN "SourceTransactionRecord" seed ON seed.id = member."statementRowId"` : sql`"SourceTransactionRecord" seed`}
      JOIN "SourceTransactionRecord" sibling ON sibling."occurrenceId" = seed."occurrenceId"
      WHERE ${match} AND ${notDeleted("seed")})`,
    ];
  });
  return branches;
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

export type JsonPath = {
  column:
    | "data"
    | "evidence"
    | "judgment"
    | "subject"
    | "suggestedValue"
    | "currentValue";
  path?: readonly string[];
};
export type ReferenceGuard = {
  entity?: string;
  field?: string;
  scope?: string;
  negate?: boolean;
};
export type Reference =
  | { kind: "primary"; guard?: ReferenceGuard }
  | {
      kind: "value";
      at: JsonPath;
      entity: string | JsonPath;
      guard?: ReferenceGuard;
    }
  | {
      kind: "elements";
      at: JsonPath;
      entity: string | JsonPath;
      idPath?: readonly string[];
      scalar?: boolean;
      guard?: ReferenceGuard;
    }
  | { kind: "contains"; at: JsonPath; guard?: ReferenceGuard };

/** Families declare stored reference paths and forward presentation separately. */
export function declareAffectedRecords(spec: {
  roles: readonly string[];
  forward: (requested?: readonly string[]) => SQL;
  references: readonly Reference[];
  graph?: (
    db: Database,
    scope: SuggestionRecordScope,
    admission: (alias?: string) => SQL | undefined,
  ) => { matches: readonly (SQL | undefined)[]; query?: SQL };
}) {
  return { affectedRecords: spec };
}
