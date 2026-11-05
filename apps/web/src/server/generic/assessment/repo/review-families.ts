import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentFamily,
  assessmentJudgments,
  mailDecisionFamily,
  type AssessmentFamily,
  type MailDecisionFamily,
} from "@cubby/schemas/assessment";
import { assessmentReviewFamilies } from "@cubby/schemas/assessment-review-family";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { entityExternalIdKind } from "@cubby/schemas/external-id";
import { financialTransactionSourceRef } from "@cubby/schemas/financial-transaction-fields";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import {
  statementTransactionAction,
  statementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import {
  suggestionRecordRef,
} from "@cubby/schemas/suggestion-list";
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
import {
  outer,
  type RelatedColumns,
} from "~/server/db/helpers/related";
import {
  suggestionTable,
  run,
} from "~/server/db/schema";
import { chargeKeyOf } from "~/server/domains/transaction-import/repo/statement-charge";
import { transactionImportMembers } from "~/server/domains/transaction-import/repo/transaction-import-membership";
import {
  recommendationScopes,
  type AssessmentRecordSelection,
} from "~/server/generic/assessment/repo/pending-admission";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
export { pendingRecommendationEligibility } from "~/server/generic/assessment/repo/pending-admission";

const reviewAssessment = alias(suggestionTable, "s");
const reviewState = reviewAssessment;

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
  scope: AssessmentRecordScope,
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

function fieldReferenceMatch(scope: AssessmentRecordScope) {
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

const statementSettlementRelation = sql`"EntityExternalId" evidence
  JOIN "FinancialTransaction" settled ON settled.id=evidence."entityId" AND ${notDeleted("settled")}
  JOIN "FinancialAccount" account ON account.id=settled."accountId"
  LEFT JOIN "FinancialTransactionAllocation" allocation ON allocation."transactionId"=settled.id AND ${notDeleted("allocation")}
  LEFT JOIN "Purchase" booked ON booked.id=allocation."purchaseId" AND ${notDeleted("booked")}
  LEFT JOIN "Expense" line ON line."purchaseId"=booked.id AND ${notDeleted("line")}`;
const statementSettlementFrom = sql`FROM ${statementSettlementRelation}`;
const statementSettlementEligibility = sql`evidence.kind=${entityExternalIdKind.enum.settlement_ref} AND ${notDeleted("evidence")}`;
const statementSettlementScope = sql`${statementSettlementEligibility}
  AND evidence.source=s.judgment #>> '{create,sourceRef,source}'
  AND evidence."externalId"=s.judgment #>> '{create,sourceRef,externalId}'`;
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
  // A proposal belongs to the charge, including retained predecessors and later memberships.
  const sourceScope = sql`observed.source = s.data->>${financialTransactionSourceRef.keyof().enum.source}
    AND ${chargeKeyOf("observed")} = s.data->>'chargeKey' AND ${notDeleted("observed")}`;
  if (includes(entities.sourceTransactionRecord))
    parts.push(sql`COALESCE((SELECT jsonb_agg(${ref(sql`${entities.sourceTransactionRecord}`, sql`observed.id::text`)})
      FROM "SourceTransactionRecord" observed WHERE ${sourceScope}), '[]'::jsonb)`);
  if (includes(entities.transactionImport))
    parts.push(sql`COALESCE((SELECT jsonb_agg(DISTINCT ${ref(sql`${entities.transactionImport}`, sql`member."importId"::text`)})
      FROM "SourceTransactionRecord" observed
      JOIN ${transactionImportMembers} member ON member."statementRowId" = observed.id
      WHERE ${sourceScope}), '[]'::jsonb)`);
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
  if (related.length)
    parts.push(sql`COALESCE((SELECT jsonb_agg(${ref(sql`related.kind`, sql`related.id`)})
        ${statementSettlementFrom}
        CROSS JOIN LATERAL (VALUES ${sql.join(
          related.map(({ entity, id }) => sql`(${entity},${id})`),
          sql`, `,
        )}) related(kind,id)
        WHERE ${statementSettlementScope}
          AND related.id IS NOT NULL), '[]'::jsonb)`);
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
function recordRefsMatch(scope: AssessmentRecordScope, refs: SQL) {
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${refs}) r
    WHERE ${relatedRecordMatch(scope, sql`r->>'entity'`, sql<string>`r->>'id'`)})`;
}

function statementSettlementMatch(scope: AssessmentRecordScope) {
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

function statementReferenceMatch(scope: AssessmentRecordScope) {
  const requested = scope.entity
    ? [scope.entity]
    : scope.records?.map((r) => r.entity);
  const direct = statementRecordParts(requested, false);
  const settled = statementSettlementMatch(scope);
  return or(
    direct.length
      ? recordRefsMatch(scope, sql.join(direct, sql` || `))
      : undefined,
    settled
      ? sql`EXISTS (SELECT 1 ${statementSettlementFrom}
          WHERE ${statementSettlementScope} AND ${settled})`
      : undefined,
  );
}

/**
 * Families reviewed as Suggestions. Problems findings, grading rosters and mail
 * decisions have their own owners.
 */
export type ReviewFamily = Exclude<
  keyof typeof assessmentReviewFamilies,
  MailDecisionFamily
>;

export const isReviewFamily = (
  family: AssessmentFamily,
): family is ReviewFamily =>
  Object.hasOwn(assessmentReviewFamilies, family) &&
  !mailDecisionFamily.safeParse(family).success;

/** Subject expansion and row admission belong to families; surfaces only intersect records. */
export const reviewFamilyDeclarations = {
  field: {
    ...assessmentReviewFamilies.field,
    records: fieldRecords(),
    recordsFor: fieldRecords,
    matchesRelatedRecords: fieldReferenceMatch,
    actionable: sql`true`,
    summarize: (value: unknown) =>
      `Set field to ${JSON.stringify(assessmentJudgments.field.parse(value).value)}`,
  },
  recommendation: {
    ...assessmentReviewFamilies.recommendation,
    scopes: recommendationScopes,
    // State holds the source and target, so a record badge never detoasts the
    // connection evidence. Rows published before connectionTarget still read it.
    records: sql`${one} || CASE WHEN jsonb_typeof(s.data->'connectionTarget') = 'object'
      THEN jsonb_build_array(${ref(sql`s.data #>> '{connectionTarget,entityKind}'`, sql`s.data #>> '{connectionTarget,entityId}'`)})
      WHEN ${recommendationScopes.connection}
      THEN jsonb_build_array(${endpoint("source")}, ${endpoint("target")})
      ELSE COALESCE(s.evidence->'records', '[]'::jsonb) END`,
    matchesRelatedRecords: (scope: AssessmentRecordScope) => {
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
        retained = inArray(reviewAssessment.id, membershipIds);
      } else if (!scope.records) {
        retained = sql`EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(s.evidence->'records', '[]'::jsonb)) r
            WHERE ${relatedRecordMatch(scope, sql`r->>'entity'`, sql<string>`r->>'id'`)})`;
      }
      return retained
        ? and(sql`(${recommendationScopes.connection}) IS NOT TRUE`, retained)
        : undefined;
    },
    actionable: sql`(${sql.join(Object.values(recommendationScopes), sql` OR `)})`,
  },
  product_pair: {
    ...assessmentReviewFamilies.product_pair,
    records: sql`${one} || jsonb_build_array(${ref(sql`${entities.product}`, sql`s.data->>'otherId'`)})`,
    matchesRelatedRecords: (scope: AssessmentRecordScope) =>
      relatedRecordMatch(
        scope,
        entities.product,
        sql<string>`s.data->>'otherId'`,
      ),
    actionable: sql`s.judgment->'actionable' = 'true'::jsonb`,
  },
  image_description: {
    ...assessmentReviewFamilies.image_description,
    records: one,
    primaryOnly: true,
    actionable: sql`jsonb_typeof(s.judgment) = 'string' AND ${hasTextSql(sql`s.judgment #>> '{}'`)}`,
  },
  statement_transaction: {
    ...assessmentReviewFamilies.statement_transaction,
    records: statementRecords(),
    recordsFor: statementRecords,
    matchesRelatedRecords: statementReferenceMatch,
    actionable: sql`true`,
    summarize: (value: unknown) => {
      const decision = assessmentJudgments.statement_transaction.parse(value);
      return `Statement transaction: ${decision.recommended}`;
    },
  },
  transfer_pair: {
    ...assessmentReviewFamilies.transfer_pair,
    records: sql`${leg("outflow")} || ${leg("inflow")}`,
    matchesRelatedRecords: (scope: AssessmentRecordScope) =>
      or(
        ...(["outflow", "inflow"] as const)
          .flatMap((end) => [
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
          ])
          .filter((match) => match !== undefined),
      ),
    actionable: sql`true`,
  },
} satisfies Record<
  ReviewFamily,
  {
    kind: "proposal" | "automatic_decision";
    label: string;
    records: SQL;
    primaryOnly?: boolean;
    recordsFor?: (entities: readonly string[]) => SQL;
    matchesRelatedRecords?: (scope: AssessmentRecordScope) => SQL | undefined;
    actionable: SQL;
    scopes?: typeof recommendationScopes;
    summarize?: (value: DecisionValue) => string;
  }
>;

/** Rule applications leave pending and name the rule that applied them. */
export function automaticAssessmentEligibility(appliedRule: SQL) {
  return and(
    inArray(
      reviewAssessment.family,
      Object.keys(reviewFamilyDeclarations).map((family) =>
        assessmentFamily.parse(family),
      ),
    ),
    ne(reviewState.status, suggestionStatus.enum.pending),
    isNotNull(appliedRule),
  );
}

const assessmentRecordsSql = (
  entities?: readonly string[],
  familyColumn: SQL = sql`s.family`,
) =>
  sql`CASE ${sql.join(
    Object.entries(reviewFamilyDeclarations).map(
      ([family, spec]) =>
        sql`WHEN ${familyColumn} = ${family} THEN ${entities && "recordsFor" in spec ? spec.recordsFor(entities) : spec.records}`,
    ),
    sql` `,
  )} ELSE '[]'::jsonb END`;

/** The Work reason key suffix for an explicit correction that was never applied. */
export const UNAPPLIED_CORRECTION_REASON = "unapplied_correction";

/**
 * Record tokens per pending suggestion for Work. The large families read only
 * AssessmentState; small families use their declared records. Tokens are UUIDs
 * or shortcodes, as stored. Current evidence is rechecked when a row is opened.
 */
export function pendingSuggestionRecordsSql(ids?: readonly string[]) {
  const pending = (families: readonly AssessmentFamily[]) =>
    sql`s.family IN (${sql.join(
      families.map((family) => sql`${family}`),
      sql`, `,
    )}) AND s.active AND s.status = ${suggestionStatus.enum.pending}
      ${ids ? sql`AND s.id = ANY(${uuidArrayParam(ids)})` : sql``}`;
  const { recommendation, statement_transaction } = assessmentFamily.enum;
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
      CROSS JOIN LATERAL jsonb_array_elements(${assessmentRecordsSql(undefined, sql`s.family`)}) record
      WHERE s.served AND ${pending([
        assessmentFamily.enum.field,
        assessmentFamily.enum.transfer_pair,
        assessmentFamily.enum.product_pair,
        assessmentFamily.enum.image_description,
      ])} AND (s.family NOT IN (${assessmentFamily.enum.product_pair}, ${assessmentFamily.enum.image_description}) OR s.suppression IS NULL)`;
}

/** A typed entity plus UUID or shortcode; stored families predate a shared reference representation. */
const storedRef = z.object({
  entity: z.enum(shortcodeEntities),
  id: z.string().min(1),
});
export async function readAssessmentRecordRefs(
  db: Database,
  ids: readonly string[],
) {
  if (!ids.length)
    return new Map<string, z.infer<typeof suggestionRecordRef>[]>();
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    refs: unknown;
  }>(sql`
    SELECT s.id, ${assessmentRecordsSql()} AS refs FROM "Suggestion" s
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

type AssessmentEligibility =
  | {
      kind: "suggestions";
      families: readonly ReviewFamily[];
      status: z.infer<typeof suggestionStatus>;
      runCode?: string;
    }
  | {
      kind: "automatic";
      family?: ReviewFamily;
      /** The caller's applied-rule expression for an Assessment id; null when none applied. */
      appliedRule: (assessmentId: SQL) => SQL;
    };

export type AssessmentRecordScope = AssessmentRecordSelection & {
  eligibility: AssessmentEligibility;
};

function assessmentStateAdmission(
  db: Database,
  eligibility: AssessmentEligibility,
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
          assessmentFamily.parse(family),
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

function assessmentRecordMatches(
  scope: AssessmentRecordScope,
): { match: SQL; stateFirst: boolean }[] {
  const primaryFamilies = Object.entries(reviewFamilyDeclarations).flatMap(
    ([family]) =>
      family !== assessmentFamily.enum.statement_transaction &&
      family !== assessmentFamily.enum.transfer_pair
        ? [assessmentFamily.parse(family)]
        : [],
  );
  const primaryMatch = and(
    inArray(reviewState.family, primaryFamilies),
    scope.entity ? eq(reviewState.entity, scope.entity) : undefined,
    scope.records
      ? or(
          ...scope.records.map((r) =>
            and(
              eq(reviewState.entity, r.entity),
              eq(reviewState.recordId, r.id),
            ),
          ),
        )
      : undefined,
  );
  // Fixed JSON paths and the literal predicate also match generic-plan indexes.
  // Immutable endpoints remain independent of the mutable primary reference.
  const connectionMatches = [
    {
      entity: sql<string>`s.evidence #>> '{candidate,source,entityKind}'`,
      id: sql<string>`s.evidence #>> '{candidate,source,entityId}'`,
    },
    {
      entity: sql<string>`s.evidence #>> '{candidate,target,entityKind}'`,
      id: sql<string>`s.evidence #>> '{candidate,target,entityId}'`,
    },
  ].map(
    ({ entity, id }) =>
      sql`${and(
        eq(reviewState.family, assessmentFamily.enum.recommendation),
        recommendationScopes.connection,
        relatedRecordMatch(scope, entity, id),
      )}`,
  );
  const secondary = Object.entries(reviewFamilyDeclarations).flatMap(
    ([family, spec]) => {
      if ("primaryOnly" in spec) return [];
      const match = spec.matchesRelatedRecords(scope);
      return match ? [{ family: assessmentFamily.parse(family), match }] : [];
    },
  );
  // Separate branches let Postgres narrow state identities/families before
  // joining immutable evidence. One CASE across families scanned every served
  // Assessment and spilled the pending-state join during ordinary list reads.
  return [
    { match: sql`${primaryMatch}`, stateFirst: false },
    ...connectionMatches.map((match) => ({ match, stateFirst: false })),
    ...secondary.map(({ family, match }) => ({
      match: sql`${and(eq(reviewState.family, family), match)}`,
      stateFirst: family === assessmentFamily.enum.statement_transaction,
    })),
  ];
}

/** Settlement-only scopes can discover immutable identities from the graph first. */
function settlementAssessmentQuery(db: Database, scope: AssessmentRecordScope) {
  if (!scope.records?.length) return undefined;
  const requested = scope.entity
    ? [scope.entity]
    : scope.records.map((r) => r.entity);
  if (statementRecordParts(requested, false).length) return undefined;
  const match = statementSettlementMatch(scope);
  if (!match) return undefined;
  const keys = reviewQueryBuilder
    .selectDistinct({
      source: sql<string>`evidence.source`.as("source"),
      externalId: sql<string>`evidence."externalId"`.as("externalId"),
    })
    .from(statementSettlementRelation)
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
        eq(indexed.family, assessmentFamily.enum.statement_transaction),
        assessmentStateAdmission(db, scope.eligibility, {
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
  return unwrapDb(db)
    .select({
      id: sql<string>`${column("id")}`.as("id"),
      family: sql<AssessmentFamily>`${column("family")}`.as("family"),
      immutableFamily: sql<AssessmentFamily>`${column("family")}`.as(
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
}

/** Scope identities before expensive automatic receipts; retain a statement-local barrier. */
function touchingAssessmentQuery(db: Database, scope: AssessmentRecordScope) {
  const client = unwrapDb(db);
  const s = reviewState;
  const branches = assessmentRecordMatches(scope);
  const stateAdmission = assessmentStateAdmission(db, scope.eligibility);
  const admission = and(s.served, stateAdmission);
  const matched = sql.join(
    branches.map(({ match, stateFirst }) => {
      const selection = {
        id: s.id,
        family: scope.eligibility.kind === "suggestions" ? s.family : s.family,
        immutableFamily: sql<AssessmentFamily>`${s.family}`.as(
          "immutableFamily",
        ),
        status: s.status,
      };
      if (stateFirst) {
        const settlement = settlementAssessmentQuery(db, scope);
        if (settlement) return settlement;
        return client
          .select(selection)
          .from(s)
          .where(and(s.served, stateAdmission, match))
          .getSQL();
      }
      return client
        .select(selection)
        .from(s)
        .where(and(admission, match))
        .getSQL();
    }),
    sql` UNION ALL `,
  );
  if (scope.eligibility.kind === "suggestions") return matched;
  // Keep receipt validation outside identity discovery. Reading the scoped
  // family/status directly prevents the planner from scanning Assessment again
  // and validating receipts before the matched-id join. Held pending corrections
  // still enter through the same candidate and authority checks.
  return sql`WITH matched AS MATERIALIZED (
    SELECT DISTINCT id, family, status FROM (${matched}) identities)
    SELECT DISTINCT matched.id, matched.family, matched.family AS "immutableFamily"
    FROM matched JOIN "Suggestion" s ON s.id = matched.id
    WHERE ${automaticAssessmentEligibility(scope.eligibility.appliedRule(sql`${s.id}`))}`;
}

/** Adapters use both State and immutable family authority after discovery. */
export async function touchingAssessmentFamilies(
  db: Database,
  scope: AssessmentRecordScope,
): Promise<Map<string, readonly AssessmentFamily[]> | null> {
  if (!scope.entity && !scope.records) return null;
  if (scope.records?.length === 0)
    return new Map<string, readonly AssessmentFamily[]>();
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    family: AssessmentFamily;
    immutableFamily: AssessmentFamily;
  }>(touchingAssessmentQuery(db, scope));
  return new Map(
    rows.map((row) => [row.id, [row.family, row.immutableFamily]]),
  );
}

export async function touchingAssessmentIds(
  db: Database,
  scope: AssessmentRecordScope,
): Promise<Set<string> | null> {
  const touching = await touchingAssessmentFamilies(db, scope);
  return touching ? new Set(touching.keys()) : null;
}

/** Pending image admission shared by Suggestions and record-scoped Work summaries.
 * Callers join immutable Assessment a and current AssessmentState s.
 */
export function pendingImageDescriptionEligibility() {
  return sql`s.family = ${assessmentFamily.enum.image_description} AND s.served
    AND s.active AND s.status = ${suggestionStatus.enum.pending}
    AND s.suppression IS NULL AND ${reviewFamilyDeclarations.image_description.actionable}
    AND EXISTS (SELECT 1 FROM "Image" i WHERE i.id = s."recordId" AND ${notDeleted("i")})`;
}
