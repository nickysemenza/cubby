import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentFamily,
  assessmentJudgments,
  assessmentProducer,
  feedbackAuthority,
  type AssessmentFamily,
} from "@cubby/schemas/assessment";
import {
  assessmentReadMembership,
  assessmentReadDependency,
  assessmentReadScopedSourceKind,
  type AssessmentReadDependency,
  type AssessmentReadMembership,
} from "@cubby/schemas/assessment-read-publication";
import { assessmentReviewFamilies } from "@cubby/schemas/assessment-review-family";
import { SYSTEM_USER_ID } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import { connectionCandidate } from "@cubby/schemas/entity-connections";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { entityExternalIdKind } from "@cubby/schemas/external-id";
import { financialTransactionSourceRef } from "@cubby/schemas/financial-transaction-fields";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import { mailboxClassificationStage } from "@cubby/schemas/mailbox-research";
import {
  statementTransactionAction,
  statementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import { CORRECTION_OUTCOME_RECEIPT_KIND } from "@cubby/schemas/suggestion-correction";
import {
  suggestionListFamily,
  suggestionRecordRef,
} from "@cubby/schemas/suggestion-list";
import { parseShortcode } from "@cubby/shared";
import {
  and,
  eq,
  inArray,
  isNotNull,
  ne,
  exists,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db";
import { hasTextSql } from "~/server/db/computed/text-whitespace";
import { textHashRefSql } from "~/server/db/derived-source-ref";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  outer,
  related,
  type RelatedColumns,
} from "~/server/db/helpers/related";
import {
  assessment,
  assessmentState,
  entityIdentity,
  feedback,
  run,
} from "~/server/db/schema";
import { chargeKeyOf } from "~/server/domains/transaction-import/repo/statement-charge";
import { transactionImportMembers } from "~/server/domains/transaction-import/repo/transaction-import-membership";
import {
  EMAIL_APPLICATION_RECEIPT,
  EMAIL_OBSERVATION_RECEIPT,
} from "~/server/generic/assessment/repo/assessment-email";
import { correctionOutcomeExists } from "~/server/generic/assessment/repo/correction-receipt";
import {
  recommendationScopes,
  type AssessmentRecordSelection,
} from "~/server/generic/assessment/repo/pending-admission";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
export { pendingRecommendationEligibility } from "~/server/generic/assessment/repo/pending-admission";

const reviewAssessment = alias(assessment, "a");
const reviewState = alias(assessmentState, "s");

const referenceEntity = z.enum(shortcodeEntities);
const entities = referenceEntity.enum;
type DecisionValue = z.infer<ReturnType<typeof z.json>>;
const ref = (entity: SQL, id: SQL) =>
  sql`jsonb_build_object('entity', (${entity})::text, 'id', (${id})::text)`;
const primary = ref(sql`s.entity`, sql`s."recordId"::text`);
const one = sql`jsonb_build_array(${primary})`;
const linkedPurchases = sql`COALESCE((SELECT jsonb_agg(${ref(sql`${entities.purchase}`, sql`link.data->>'purchaseId'`)}) FROM "AssessmentState" link JOIN "Assessment" publication ON publication.id = link.id
  WHERE link.family = ${assessmentFamily.enum.email_link} AND link.active AND link.data->>${assessmentJudgments.email_link.keyof().enum.decision} = ${assessmentJudgments.email_link.shape.decision.enum.linked}
    AND EXISTS (SELECT 1 FROM "Email" mail WHERE mail.id = s."recordId" AND ${notDeleted("mail")} AND (publication.subject->>'recordId' = mail.id::text OR publication.subject->>'originalId' = mail."orderMailId"::text))), '[]'::jsonb)`;
const receipt = alias(feedback, "receipt");
const reviewQueryBuilder = new QueryBuilder();
const receiptKind = sql<string>`${receipt.metadata}->>${assessmentProducer.keyof().enum.kind}`;
const feedbackForAssessment = (predicate: SQL | undefined, bounded = false) => {
  const query = reviewQueryBuilder
    .select({ id: receipt.id })
    .from(receipt)
    .where(and(eq(receipt.assessmentId, reviewAssessment.id), predicate));
  // Scoped readers must not turn a few identity probes into a global receipt hash.
  // Drizzle omits a numeric zero offset, so this barrier must be literal SQL.
  return bounded ? sql`(${query.getSQL()} OFFSET 0)` : query;
};
const emailApplication = (bounded = false) =>
  exists(
    feedbackForAssessment(
      and(
        eq(receipt.authority, feedbackAuthority.enum.automatic),
        or(
          eq(receiptKind, EMAIL_APPLICATION_RECEIPT),
          eq(receipt.operationId, mailboxClassificationStage.enum.resolution),
        ),
      ),
      bounded,
    ),
  );
const emailAudit = (bounded: boolean) =>
  and(
    notExists(
      feedbackForAssessment(
        and(
          eq(receipt.operationId, mailboxClassificationStage.enum.resolution),
          eq(receipt.authority, feedbackAuthority.enum.member),
        ),
        bounded,
      ),
    ),
    or(
      emailApplication(bounded),
      notExists(
        feedbackForAssessment(
          eq(receiptKind, EMAIL_OBSERVATION_RECEIPT),
          bounded,
        ),
      ),
    ),
  )!;
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

const emailLinkRecords = (requested?: readonly string[]) => {
  const parts: SQL[] = [];
  if (!requested || requested.includes(entities.email))
    parts.push(
      sql`jsonb_build_array(${ref(sql`${entities.email}`, sql`COALESCE(a.subject->>'recordId', (SELECT mail.id::text FROM "Email" mail WHERE mail."orderMailId"::text = a.subject->>'originalId' AND ${notDeleted("mail")}))`)})`,
    );
  if (!requested || requested.includes(entities.purchase))
    parts.push(
      sql`jsonb_build_array(${ref(sql`${entities.purchase}`, sql`s.data->>'purchaseId'`)})`,
    );
  return parts.length ? sql.join(parts, sql` || `) : sql`'[]'::jsonb`;
};

function emailLinkRecordMatch(scope: AssessmentRecordScope) {
  const explicit = relatedRecordMatch(
    scope,
    entities.email,
    sql<string>`a.subject->>'recordId'`,
  );
  const purchase = relatedRecordMatch(
    scope,
    entities.purchase,
    sql<string>`s.data->>'purchaseId'`,
  );
  const emails = scope.records?.filter(
    (record) => record.entity === entities.email,
  );
  const legacy = explicit
    ? sql`a.subject->>'recordId' IS NULL AND EXISTS (
        SELECT 1 FROM "Email" mail
        WHERE ${notDeleted("mail")}
          ${emails ? sql`AND mail.id = ANY(${uuidArrayParam(emails.map((record) => record.id))})` : sql``}
          AND mail."orderMailId" = substring(a.subject->>'originalId'
            FROM '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')::uuid)`
    : undefined;
  // COALESCE never falls through a non-null explicit ID, even an empty one.
  // Guarding canonical text preserves historical equality while indexing OrderMail IDs.
  return or(explicit, legacy, purchase);
}
const mailImportOutcomeRecords = (requested?: readonly string[]) =>
  // Linked Purchase expansion cannot match another requested entity kind.
  !requested || requested.includes(entities.purchase)
    ? sql`${one} || ${linkedPurchases}`
    : one;
const endpoint = (end: "source" | "target") =>
  ref(
    sql`a.evidence->'candidate'->${end}->>'entityKind'`,
    sql`a.evidence->'candidate'->${end}->>'entityId'`,
  );
const leg = (end: "outflow" | "inflow") => sql`jsonb_build_array(
  ${ref(sql`${entities.financialAccount}`, sql`a.judgment->${end}->>'accountId'`)},
  ${ref(sql`${entities.financialTransaction}`, sql`a.judgment->${end}->>'transactionId'`)},
  ${ref(sql`${entities.ledgerParty}`, sql`a.judgment->${end}->'owner'->>'id'`)})`;

const statementSettlementRelation = sql`"EntityExternalId" evidence
  JOIN "FinancialTransaction" settled ON settled.id=evidence."entityId" AND ${notDeleted("settled")}
  JOIN "FinancialAccount" account ON account.id=settled."accountId"
  LEFT JOIN "FinancialTransactionAllocation" allocation ON allocation."transactionId"=settled.id AND ${notDeleted("allocation")}
  LEFT JOIN "Purchase" booked ON booked.id=allocation."purchaseId" AND ${notDeleted("booked")}
  LEFT JOIN "Expense" line ON line."purchaseId"=booked.id AND ${notDeleted("line")}`;
const statementSettlementFrom = sql`FROM ${statementSettlementRelation}`;
const statementSettlementEligibility = sql`evidence.kind=${entityExternalIdKind.enum.settlement_ref} AND ${notDeleted("evidence")}`;
const statementSettlementScope = sql`${statementSettlementEligibility}
  AND evidence.source=a.judgment #>> '{create,sourceRef,source}'
  AND evidence."externalId"=a.judgment #>> '{create,sourceRef,externalId}'`;
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
    sql`a.judgment->${statementTransactionAction.enum.supersede}->>'pendingTransactionId'`,
  );
  add(
    entities.financialTransaction,
    sql`a.judgment->${statementTransactionAction.enum.void}->>'transactionId'`,
  );
  add(entities.financialTransaction, sql`a.judgment->>'matchedTransactionId'`);
  add(
    entities.vendor,
    sql`(SELECT v.id::text FROM "Vendor" v WHERE v.shortcode=a.judgment->${statementTransactionJudgment.keyof().enum.spending}->>'vendorId' AND ${notDeleted("v")})`,
  );
  add(
    entities.spendingCategory,
    sql`(SELECT category.id::text FROM "SpendingCategory" category WHERE category.shortcode=a.judgment->${statementTransactionJudgment.keyof().enum.spending}->>'spendingCategoryId' AND ${notDeleted("category")})`,
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
        FROM jsonb_array_elements(COALESCE(a.judgment->${statementTransactionJudgment.keyof().enum.spending}->'candidates','[]'::jsonb)) candidate
        JOIN "Purchase" p ON p.shortcode=candidate->>'purchaseId' AND ${notDeleted("p")}), '[]'::jsonb)`);
  if (includes(entities.financialTransaction))
    parts.push(
      sql`COALESCE((SELECT jsonb_agg(${ref(sql`${entities.financialTransaction}`, sql`c->>'transactionId'`)}) FROM jsonb_array_elements(a.judgment->'candidates') c), '[]'::jsonb)`,
    );
  return parts;
}

function statementRecords(requested?: readonly string[]) {
  const parts = statementRecordParts(requested);
  return parts.length ? sql.join(parts, sql` || `) : sql`'[]'::jsonb`;
}

/** Reference expansion and settlement joins stay owned by the Statement reader. */
function statementInputRefs() {
  const { statementCharge, statementRef, referenceCode } =
    assessmentReadScopedSourceKind.enum;
  return sql`${statementRecords()}
    || jsonb_build_array(${ref(sql`${entities.sourceTransactionRecord}`, sql`s."recordId"::text`)})
    || COALESCE((SELECT jsonb_agg(${ref(sql`${entities.financialAccount}`, sql`account.id::text`)})
      ${statementSettlementFrom} WHERE ${statementSettlementScope}), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(${ref(sql`${entities.ledgerParty}`, sql`owner_account."ledgerPartyId"::text`)})
      FROM "FinancialAccount" owner_account WHERE owner_account.id = (s.data->>'accountId')::uuid), '[]'::jsonb)
    || jsonb_build_array(${ref(sql`${statementCharge}`, sql`${textHashRefSql(sql`s.data->>'chargeKey'`)}::text`)})
    || COALESCE((SELECT jsonb_agg(${ref(sql`${statementRef}`, sql`${textHashRefSql(sql`source_ref.value`)}::text`)})
      FROM (
        SELECT substr(value, strpos(value, ':') + 1) AS value
        FROM jsonb_array_elements_text(COALESCE(s.data->'refs', '[]'::jsonb)) refs(value)
        UNION SELECT s.data->>'headRef'
        UNION SELECT a.judgment #>> '{create,sourceRef,externalId}'
      ) source_ref WHERE source_ref.value IS NOT NULL), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(${ref(sql`${referenceCode}`, sql`${textHashRefSql(sql`lookup_code.value`)}::text`)})
      FROM (
        SELECT a.judgment #>> '{spending,vendorId}' AS value
        UNION SELECT a.judgment #>> '{spending,spendingCategoryId}'
        UNION SELECT candidate->>'purchaseId'
          FROM jsonb_array_elements(COALESCE(a.judgment #> '{spending,candidates}', '[]'::jsonb)) candidate
      ) lookup_code WHERE lookup_code.value IS NOT NULL), '[]'::jsonb)`;
}

/** Retained legs include competitors and overlaps that are not browse memberships. */
function transferInputRefs() {
  const { outflow, inflow } = assessmentJudgments.transfer_pair.keyof().enum;
  const { statementCharge, statementRef, referenceCode } =
    assessmentReadScopedSourceKind.enum;
  return sql`(WITH legs AS MATERIALIZED (
    SELECT a.judgment->${outflow} AS value
    UNION ALL SELECT a.judgment->${inflow}
    UNION ALL SELECT competitor->'leg'
      FROM jsonb_array_elements(COALESCE(a.judgment->'competitors', '[]'::jsonb)) competitor
  ), records AS MATERIALIZED (
    SELECT value FROM legs
    UNION ALL SELECT overlap.value FROM legs
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(legs.value->'overlaps', '[]'::jsonb)) overlap(value)
  ), codes AS MATERIALIZED (
    SELECT ${entities.financialAccount}::text AS entity, value->>'accountId' AS code FROM records
    UNION SELECT ${entities.financialTransaction}, value->>'transactionId' FROM records
    UNION SELECT ${entities.ledgerParty}, value #>> '{owner,id}' FROM records
  ), inputs AS (
    SELECT ${ref(sql`${referenceCode}`, sql`${textHashRefSql(sql`codes.code`)}::text`)} AS value
      FROM codes WHERE code IS NOT NULL
    UNION ALL SELECT ${ref(sql`${entities.financialAccount}`, sql`account.id::text`)}
      FROM codes JOIN "FinancialAccount" account ON codes.entity = ${entities.financialAccount} AND account.shortcode = codes.code
    UNION ALL SELECT ${ref(sql`${entities.ledgerParty}`, sql`account."ledgerPartyId"::text`)}
      FROM codes JOIN "FinancialAccount" account ON codes.entity = ${entities.financialAccount} AND account.shortcode = codes.code
    UNION ALL SELECT ${ref(sql`${entities.financialTransaction}`, sql`transaction.id::text`)}
      FROM codes JOIN "FinancialTransaction" transaction ON codes.entity = ${entities.financialTransaction} AND transaction.shortcode = codes.code
    UNION ALL SELECT ${ref(sql`${entities.ledgerParty}`, sql`party.id::text`)}
      FROM codes JOIN "LedgerParty" party ON codes.entity = ${entities.ledgerParty} AND party.shortcode = codes.code
    UNION ALL SELECT ${ref(sql`${statementCharge}`, sql`${textHashRefSql(sql`value #>> '{charge,chargeKey}'`)}::text`)}
      FROM records WHERE value #>> '{charge,chargeKey}' IS NOT NULL
    UNION ALL SELECT ${ref(sql`${statementRef}`, sql`${textHashRefSql(sql`source_ref.value->>'externalId'`)}::text`)}
      FROM records CROSS JOIN LATERAL jsonb_array_elements(COALESCE(records.value->'refs', '[]'::jsonb)) source_ref(value)
  ) SELECT COALESCE(jsonb_agg(value), '[]'::jsonb) FROM inputs)`;
}

/** Candidate roots survive admission, liveness and mutable-State endpoint changes. */
function connectionInputRefs() {
  const { source, target } = connectionCandidate.keyof().enum;
  return sql`jsonb_build_array(${primary}) || COALESCE((
    SELECT jsonb_agg(${ref(sql`endpoint.value->>'entityKind'`, sql`endpoint.value->>'entityId'`)})
    FROM (VALUES (a.evidence->'candidate'), (s.data #> '{connectionEvidence,candidate}')) candidate(value)
    CROSS JOIN LATERAL (VALUES (candidate.value->${source}), (candidate.value->${target})) endpoint(value)
  ), '[]'::jsonb)`;
}

/** Independent family authorities may contribute different input sets to one revision. */
function membershipInputRefs() {
  const family = (value: AssessmentFamily) =>
    sql`(${reviewAssessment.family} = ${value} OR ${reviewState.family} = ${value})`;
  const parts = [
    {
      matches: family(assessmentFamily.enum.statement_transaction),
      refs: statementInputRefs(),
    },
    {
      matches: family(assessmentFamily.enum.transfer_pair),
      refs: transferInputRefs(),
    },
    {
      matches: family(assessmentFamily.enum.image_description),
      refs: sql`jsonb_build_array(
      ${ref(sql`${entities.image}`, sql`s."recordId"::text`)},
      ${ref(sql`${entities.image}`, sql`a.subject->>'recordId'`)})`,
    },
    {
      matches: family(assessmentFamily.enum.product_pair),
      refs: sql`jsonb_build_array(
      ${ref(sql`${entities.product}`, sql`s."recordId"::text`)},
      ${ref(sql`${entities.product}`, sql`s.data->>'otherId'`)},
      ${ref(sql`${entities.product}`, sql`a.subject->>'otherId'`)})`,
    },
    {
      matches: sql`(jsonb_typeof(a.evidence->'candidate') = 'object'
      OR jsonb_typeof(s.data #> '{connectionEvidence,candidate}') = 'object')`,
      refs: connectionInputRefs(),
    },
  ];
  return sql`CASE WHEN ${sql.join(
    parts.map(({ matches }) => matches),
    sql` OR `,
  )}
    THEN ${sql.join(
      parts.map(
        ({ matches, refs }) =>
          sql`CASE WHEN ${matches} THEN ${refs} ELSE '[]'::jsonb END`,
      ),
      sql` || `,
    )}
    ELSE NULL::jsonb END`;
}

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

/** Families reviewed as Suggestions; Problems findings and grading rosters have their own reads. */
export type ReviewFamily = keyof typeof assessmentReviewFamilies;

export const isReviewFamily = (
  family: AssessmentFamily,
): family is ReviewFamily => Object.hasOwn(assessmentReviewFamilies, family);

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
    records: sql`${one} || CASE WHEN ${recommendationScopes.connection}
      THEN jsonb_build_array(${endpoint("source")}, ${endpoint("target")})
      ELSE COALESCE(a.evidence->'records', '[]'::jsonb) END`,
    matchesRelatedRecords: (scope: AssessmentRecordScope) => {
      let retained: SQL | undefined;
      if (scope.records?.length) {
        const indexed = alias(assessment, "retained_indexed");
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
        retained = sql`EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(a.evidence->'records', '[]'::jsonb)) r
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
    actionable: sql`a.judgment->'actionable' = 'true'::jsonb`,
  },
  image_description: {
    ...assessmentReviewFamilies.image_description,
    records: one,
    primaryOnly: true,
    actionable: sql`jsonb_typeof(a.judgment) = 'string' AND ${hasTextSql(sql`a.judgment #>> '{}'`)}`,
    audit: (bounded: boolean) =>
      exists(
        feedbackForAssessment(
          and(
            eq(receipt.authority, "automatic"),
            eq(receipt.actorUserId, SYSTEM_USER_ID),
            eq(receipt.intent, "history"),
            eq(receiptKind, CORRECTION_OUTCOME_RECEIPT_KIND),
          ),
          bounded,
        ),
      ),
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
              sql<string>`a.judgment->${end}->>'accountId'`,
            ),
            relatedRecordMatch(
              scope,
              entities.financialTransaction,
              sql<string>`a.judgment->${end}->>'transactionId'`,
            ),
            relatedRecordMatch(
              scope,
              entities.ledgerParty,
              sql<string>`a.judgment->${end}->'owner'->>'id'`,
            ),
          ])
          .filter((match) => match !== undefined),
      ),
    actionable: sql`true`,
  },
  email_relevance: {
    ...assessmentReviewFamilies.email_relevance,
    records: one,
    primaryOnly: true,
    actionable: sql`false`,
    audit: emailAudit,
    verified: emailApplication(),
    summarize: (value: unknown) =>
      `Classified ${assessmentJudgments.email_relevance.parse(value).classification}`,
    correction: {
      label: "Correct relevance",
      options: [
        { label: "Related", value: "related" },
        { label: "Unrelated", value: "unrelated" },
        { label: "Uncertain", value: "uncertain" },
      ],
    },
  },
  email_link: {
    ...assessmentReviewFamilies.email_link,
    records: emailLinkRecords(),
    recordsFor: emailLinkRecords,
    matchesRelatedRecords: emailLinkRecordMatch,
    actionable: sql`false`,
    audit: (bounded: boolean) =>
      exists(
        feedbackForAssessment(
          and(
            eq(receipt.operationId, mailboxClassificationStage.enum.decision),
            eq(receipt.authority, feedbackAuthority.enum.automatic),
          ),
          bounded,
        ),
      ),
    summarize: (value: unknown) =>
      `Email link ${assessmentJudgments.email_link.parse(value).decision}`,
    correction: {
      label: "Correct link decision",
      options: [
        { label: "Link", value: { decision: "linked" } },
        { label: "Dismiss link", value: { decision: "dismissed" } },
      ],
    },
  },
  mail_import_outcome: {
    ...assessmentReviewFamilies.mail_import_outcome,
    records: mailImportOutcomeRecords(),
    recordsFor: mailImportOutcomeRecords,
    matchesRelatedRecords: (scope: AssessmentRecordScope) => {
      const match = relatedRecordMatch(
        scope,
        entities.purchase,
        sql<string>`r->>'id'`,
      );
      return match
        ? sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${linkedPurchases}) r WHERE ${match})`
        : undefined;
    },
    actionable: sql`false`,
    audit: () => sql`true`,
    summarize: (value: unknown) => {
      const outcome = assessmentJudgments.mail_import_outcome.parse(value);
      return outcome.kind === "imported"
        ? `Imported ${outcome.lines.map((line) => line.name).join(", ")}`
        : outcome.kind === "linked"
          ? `Linked ${outcome.event}`
          : `${outcome.kind}: ${outcome.reason}`;
    },
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
    audit?: (bounded: boolean) => SQL;
    verified?: SQL;
    summarize?: (value: DecisionValue) => string;
    correction?: {
      label: string;
      options: { label: string; value: DecisionValue }[];
    };
  }
>;

/** Rule applications leave pending; automatic families retain legacy pending history. */
export function automaticAssessmentEligibility(
  appliedRule: SQL,
  bounded = false,
) {
  const familyCandidate = or(
    inArray(
      reviewAssessment.family,
      Object.entries(reviewFamilyDeclarations).flatMap(
        ([family, declaration]) =>
          declaration.kind === "automatic_decision"
            ? [assessmentFamily.parse(family)]
            : [],
      ),
    ),
    ne(reviewState.status, suggestionStatus.enum.pending),
  );
  const familyAudit = or(
    ...Object.entries(reviewFamilyDeclarations).flatMap(
      ([family, declaration]) =>
        "audit" in declaration
          ? [
              and(
                eq(reviewAssessment.family, assessmentFamily.parse(family)),
                declaration.audit(bounded),
              )!,
            ]
          : [],
    ),
    isNotNull(appliedRule),
  );
  // A validated correction proves both candidate and audit admission. Factor
  // that shared proof out so the three-Feedback authority join runs once.
  return and(
    inArray(
      reviewAssessment.family,
      Object.keys(reviewFamilyDeclarations).map((family) =>
        assessmentFamily.parse(family),
      ),
    ),
    or(
      correctionOutcomeExists(sql`${reviewAssessment.id}`, undefined, bounded),
      and(familyCandidate, familyAudit),
    ),
  );
}

export const automaticApplicationVerified = sql`CASE ${sql.join(
  Object.entries(reviewFamilyDeclarations).flatMap(([family, declaration]) =>
    "verified" in declaration
      ? [sql`WHEN a.family = ${family} THEN ${declaration.verified}`]
      : [],
  ),
  sql` `,
)} ELSE true END`;

const assessmentRecordsSql = (
  entities?: readonly string[],
  familyColumn: SQL = sql`a.family`,
) =>
  sql`CASE ${sql.join(
    Object.entries(reviewFamilyDeclarations).map(
      ([family, spec]) =>
        sql`WHEN ${familyColumn} = ${family} THEN ${entities && "recordsFor" in spec ? spec.recordsFor(entities) : spec.records}`,
    ),
    sql` `,
  )} ELSE '[]'::jsonb END`;

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
    SELECT a.id, ${assessmentRecordsSql()} AS refs FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id
    WHERE a.id = ANY(${uuidArrayParam(ids)})`);
  return resolveStoredRecordRefs(db, rows);
}

async function resolveStoredRecordRefs(
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

/** Publish discovery tokens and count references from their existing family owners. */
export async function readAssessmentReadMemberships(
  db: Database,
  ids: readonly string[],
  observeInputs?: (
    id: string,
    sources: readonly AssessmentReadDependency[],
  ) => void,
): Promise<Map<string, AssessmentReadMembership[]>> {
  if (!ids.length) return new Map();
  const admitted = and(
    reviewAssessment.served,
    reviewState.active,
    eq(reviewState.status, suggestionStatus.enum.pending),
    inArray(reviewState.family, suggestionListFamily.options),
  );
  const sources = reviewQueryBuilder
    .select({
      id: reviewAssessment.id,
      stateFamily: sql<AssessmentFamily>`${reviewState.family}`.as(
        "stateFamily",
      ),
      scopeRefs: sql`CASE WHEN ${admitted}
      THEN ${assessmentRecordsSql(undefined, sql`${reviewState.family}`)}
      ELSE '[]'::jsonb END`.as("scopeRefs"),
      otherRefs:
        sql`CASE WHEN ${reviewAssessment.family} = ${reviewState.family}
      THEN NULL::jsonb ELSE ${assessmentRecordsSql()} END`.as("otherRefs"),
      retainedRefs: sql`CASE WHEN ${admitted}
      AND ${reviewState.family} = ${assessmentFamily.enum.recommendation}
      AND (${recommendationScopes.connection}) IS NOT TRUE
      THEN COALESCE(${reviewAssessment.evidence}->'records', '[]'::jsonb)
      ELSE '[]'::jsonb END`.as("retainedRefs"),
      inputRefs: (observeInputs ? membershipInputRefs() : sql`NULL::jsonb`).as(
        "inputRefs",
      ),
    })
    .from(reviewAssessment)
    .innerJoin(reviewState, eq(reviewState.id, reviewAssessment.id))
    .where(sql`${reviewAssessment.id} = ANY(${uuidArrayParam(ids)})`);
  const token = z.object({
    entity: referenceEntity,
    value: z.string(),
    retained: z.boolean(),
  });
  const rows = z
    .array(
      z.object({
        id: z.string(),
        stateFamily: assessmentFamily,
        countRefs: z.unknown(),
        tokens: z.array(token),
        inputRefs: z.unknown(),
      }),
    )
    .parse(
      (
        await unwrapDb(db).execute(sql`
    WITH membership_sources AS MATERIALIZED (${sources.getSQL()}),
    membership_tokens AS (
      SELECT p.id, r.value->>'entity' AS entity, r.value->>'id' AS value, false AS retained
      FROM membership_sources p
      CROSS JOIN LATERAL jsonb_array_elements(p."scopeRefs") r(value)
      UNION ALL
      SELECT p.id, r.value->>'entity', r.value->>'id', true
      FROM membership_sources p
      CROSS JOIN LATERAL jsonb_array_elements(p."retainedRefs") r(value)
    ), membership_groups AS (
      SELECT id, jsonb_agg(DISTINCT (to_jsonb(membership_tokens) - 'id')) AS tokens
      FROM membership_tokens WHERE value IS NOT NULL
        AND entity IN (${sql.join(
          shortcodeEntities.map((entity) => sql`${entity}`),
          sql`, `,
        )})
      GROUP BY id
    )
    SELECT p.id, p."stateFamily", p."inputRefs", COALESCE(p."otherRefs", p."scopeRefs") AS "countRefs",
      COALESCE(g.tokens, '[]'::jsonb) AS tokens
    FROM membership_sources p LEFT JOIN membership_groups g ON g.id=p.id
  `)
      ).rows,
    );
  const refs = await resolveStoredRecordRefs(
    db,
    rows
      .filter((row) => row.tokens.length > 0)
      .map((row) => ({ id: row.id, refs: row.countRefs })),
  );
  const inputs = rows
    .filter((row) => row.inputRefs !== null)
    .map((row) => ({
      id: row.id,
      refs: z
        .array(z.unknown())
        .parse(row.inputRefs)
        .flatMap((value) => {
          const parsed = z
            .object({ entity: z.string(), id: z.string() })
            .safeParse(value);
          return parsed.success
            ? [{ ...parsed.data, code: parseShortcode(parsed.data.id) }]
            : [];
        }),
    }));
  const codes = new Map(
    inputs.flatMap((input) =>
      input.refs.flatMap((value) =>
        value.code?.type === value.entity
          ? [
              [
                JSON.stringify([value.entity, value.code.shortcode]),
                { entity: value.entity, code: value.code.shortcode },
              ] as const,
            ]
          : [],
      ),
    ),
  );
  const resolvedInputs =
    codes.size === 0
      ? []
      : z
          .array(
            z.object({
              entity: referenceEntity,
              code: z.string(),
              id: z.guid().nullable(),
              token: z.guid(),
            }),
          )
          .parse(
            (
              await unwrapDb(db).execute(sql`
    SELECT requested.entity, requested.code, identity.id::text AS id,
      ${textHashRefSql(sql`requested.code`)}::text AS token
    FROM jsonb_to_recordset(${JSON.stringify([...codes.values()])}::jsonb) requested(entity text, code text)
    LEFT JOIN ${entityIdentity} identity ON identity.kind = requested.entity AND identity.shortcode = requested.code
  `)
            ).rows,
          );
  const byCode = new Map(
    resolvedInputs.map((value) => [
      JSON.stringify([value.entity, value.code]),
      value,
    ]),
  );
  for (const row of inputs) {
    const sources = row.refs.flatMap((value) => {
      const id = z.guid().safeParse(value.id);
      if (id.success)
        return [
          assessmentReadDependency.parse({
            sourceKind: value.entity,
            sourceId: id.data.toLowerCase(),
          }),
        ];
      const code =
        value.code?.type === value.entity
          ? byCode.get(JSON.stringify([value.entity, value.code.shortcode]))
          : undefined;
      if (!code) return [];
      return [
        assessmentReadDependency.parse({
          sourceKind: assessmentReadScopedSourceKind.enum.referenceCode,
          sourceId: code.token,
        }),
        ...(code.id
          ? [
              assessmentReadDependency.parse({
                sourceKind: code.entity,
                sourceId: code.id,
              }),
            ]
          : []),
      ];
    });
    observeInputs?.(
      row.id,
      [
        ...new Map(
          sources.map((source) => [
            JSON.stringify([source.sourceKind, source.sourceId]),
            source,
          ]),
        ).entries(),
      ]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, source]) => source),
    );
  }
  return new Map(
    rows.map((row) => {
      const memberships = [
        ...row.tokens.map((value) =>
          assessmentReadMembership.parse({
            ...value,
            kind: "scope",
            stateFamily: row.stateFamily,
          }),
        ),
        ...(refs.get(row.id) ?? []).map((value) =>
          assessmentReadMembership.parse({
            entity: value.entity,
            value: value.id,
            kind: "ref",
            retained: false,
            stateFamily: row.stateFamily,
          }),
        ),
      ];
      // JSON aggregate order is unspecified. Membership order must not create a
      // new publication revision when only the query plan changes.
      memberships.sort((a, b) => {
        for (const key of ["kind", "entity", "value", "stateFamily"] as const) {
          if (a[key] < b[key]) return -1;
          if (a[key] > b[key]) return 1;
        }
        return Number(a.retained) - Number(b.retained);
      });
      return [row.id, memberships];
    }),
  );
}

/** Admission is data, so callers cannot bind aliases or spell status values in SQL. */
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
    RelatedColumns<typeof assessmentState>,
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
      family !== assessmentFamily.enum.email_link &&
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
      entity: sql<string>`a.evidence #>> '{candidate,source,entityKind}'`,
      id: sql<string>`a.evidence #>> '{candidate,source,entityId}'`,
    },
    {
      entity: sql<string>`a.evidence #>> '{candidate,target,entityKind}'`,
      id: sql<string>`a.evidence #>> '{candidate,target,entityId}'`,
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
  const indexed = alias(assessment, "settlement_indexed");
  const source = sql<string>`${indexed.judgment} #>> '{create,sourceRef,source}'`;
  const externalId = sql<string>`${indexed.judgment} #>> '{create,sourceRef,externalId}'`;
  // Bounded hashes support unrestricted historical text. Exact comparisons
  // retain identity authority even if two extracted values hash alike.
  const publications = reviewQueryBuilder
    .select({ id: indexed.id, family: indexed.family })
    .from(indexed)
    .where(
      and(
        indexed.served,
        isNotNull(source),
        isNotNull(externalId),
        eq(sql`md5(${source})`, sql`md5(${keySource})`),
        eq(sql`md5(${externalId})`, sql`md5(${keyExternalId})`),
        eq(source, keySource),
        eq(externalId, keyExternalId),
      ),
    );
  const admitted = related(assessmentState, (state) =>
    eq(state.id, outer(reviewAssessment.id)),
  )
    .where((state) =>
      and(
        eq(state.family, assessmentFamily.enum.statement_transaction),
        assessmentStateAdmission(db, scope.eligibility, state),
      ),
    )
    .aggregate(
      (state) =>
        sql`${state.family} AS ${sql.identifier("family")}, ${state.status} AS ${sql.identifier("status")}`,
    );
  return unwrapDb(db)
    .select({
      id: outer(reviewAssessment.id),
      family:
        scope.eligibility.kind === "suggestions"
          ? outer(reviewState.family)
          : outer(reviewAssessment.family),
      immutableFamily:
        sql<AssessmentFamily>`${outer(reviewAssessment.family)}`.as(
          "immutableFamily",
        ),
      status: outer(reviewState.status),
    })
    .from(sql`(${keys.getSQL()}) AS ${keyName}`)
    .innerJoinLateral(
      sql`(${publications.getSQL()} OFFSET 0) AS ${sql.identifier("a")}`,
      sql`true`,
    )
    .innerJoinLateral(
      sql`(${admitted} OFFSET 0) AS ${sql.identifier("s")}`,
      sql`true`,
    )
    .getSQL();
}

/** Scope identities before expensive automatic receipts; retain a statement-local barrier. */
function touchingAssessmentQuery(db: Database, scope: AssessmentRecordScope) {
  const client = unwrapDb(db);
  const a = reviewAssessment;
  const s = reviewState;
  const branches = assessmentRecordMatches(scope);
  const stateAdmission = assessmentStateAdmission(db, scope.eligibility);
  const admission = and(a.served, stateAdmission);
  const matched = sql.join(
    branches.map(({ match, stateFirst }) => {
      const selection = {
        id: a.id,
        family: scope.eligibility.kind === "suggestions" ? s.family : a.family,
        immutableFamily: sql<AssessmentFamily>`${a.family}`.as(
          "immutableFamily",
        ),
        status: s.status,
      };
      if (stateFirst) {
        const settlement = settlementAssessmentQuery(db, scope);
        if (settlement) return settlement;
        // Settlement membership reads immutable judgment. Fence that lookup
        // behind State identity rather than scanning every served Assessment.
        const publication = related(assessment, (immutable) =>
          eq(immutable.id, outer(s.id)),
        )
          .where((immutable) => immutable.served)
          .aggregate(
            (immutable) => sql`${immutable.id} AS ${sql.identifier("id")},
            ${immutable.family} AS ${sql.identifier("family")},
            ${immutable.judgment} AS ${sql.identifier("judgment")}`,
          );
        return client
          .select({
            ...selection,
            id: outer(a.id),
            family:
              scope.eligibility.kind === "suggestions"
                ? s.family
                : outer(a.family),
          })
          .from(s)
          .innerJoinLateral(
            sql`(${publication} OFFSET 0) AS ${sql.identifier("a")}`,
            sql`true`,
          )
          .where(and(stateAdmission, match))
          .getSQL();
      }
      return client
        .select(selection)
        .from(a)
        .innerJoin(s, eq(s.id, a.id))
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
    SELECT DISTINCT a.id, a.family, a.family AS "immutableFamily" FROM matched a
    CROSS JOIN LATERAL (SELECT a.status) s
    WHERE ${automaticAssessmentEligibility(scope.eligibility.appliedRule(sql`${a.id}`), true)}`;
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
  return sql`a.family = ${assessmentFamily.enum.image_description} AND a.served
    AND s.active AND s.status = ${suggestionStatus.enum.pending}
    AND s.suppression IS NULL AND ${reviewFamilyDeclarations.image_description.actionable}
    AND EXISTS (SELECT 1 FROM "Image" i WHERE i.id = s."recordId" AND ${notDeleted("i")})`;
}
