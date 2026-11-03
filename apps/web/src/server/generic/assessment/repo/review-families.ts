import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentFamily,
  assessmentJudgments,
  assessmentProducer,
  feedbackAuthority,
  feedbackVerdict,
  type AssessmentFamily,
} from "@cubby/schemas/assessment";
import { assessmentReviewFamilies } from "@cubby/schemas/assessment-review-family";
import { SYSTEM_USER_ID } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
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
import { suggestionRecordRef } from "@cubby/schemas/suggestion-list";
import { parseShortcode } from "@cubby/shared";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
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
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { assessment, assessmentState, feedback, run } from "~/server/db/schema";
import { chargeKeyOf } from "~/server/domains/transaction-import/repo/statement-charge";
import { transactionImportMembers } from "~/server/domains/transaction-import/repo/transaction-import-membership";
import {
  EMAIL_APPLICATION_RECEIPT,
  EMAIL_OBSERVATION_RECEIPT,
} from "~/server/generic/assessment/repo/assessment-email";
import { correctionOutcomeExists } from "~/server/generic/assessment/repo/correction-receipt";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

const reviewAssessment = alias(assessment, "a");
const reviewState = alias(assessmentState, "s");

const entities = z.enum(shortcodeEntities).enum;
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
  return and(
    isNotNull(id),
    scope.entity ? eq(entity, scope.entity) : undefined,
    scope.records
      ? or(
          ...scope.records.map((record) =>
            and(
              eq(entity, record.entity),
              inArray(id, [record.id, record.code]),
            ),
          ),
        )
      : undefined,
  );
}

function fieldReferenceMatch(scope: AssessmentRecordScope) {
  return or(
    ...Object.entries(entityFieldModels).flatMap(([entity, model]) =>
      model.fields.flatMap((field) => {
        const target = z
          .enum(shortcodeEntities)
          .safeParse(field.reference?.entity);
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
        const target = z
          .enum(shortcodeEntities)
          .safeParse(field.reference?.entity);
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

const recommendationScopes = {
  connection: sql`a.subject->>'scope' LIKE 'connection.%'`,
  tagPropagation: sql`a.subject->>'scope' = 'product.tag-propagation'`,
};

const statementSettlementFrom = sql`FROM "EntityExternalId" evidence
  JOIN "FinancialTransaction" settled ON settled.id=evidence."entityId" AND ${notDeleted("settled")}
  JOIN "FinancialAccount" account ON account.id=settled."accountId"
  LEFT JOIN "FinancialTransactionAllocation" allocation ON allocation."transactionId"=settled.id AND ${notDeleted("allocation")}
  LEFT JOIN "Purchase" booked ON booked.id=allocation."purchaseId" AND ${notDeleted("booked")}
  LEFT JOIN "Expense" line ON line."purchaseId"=booked.id AND ${notDeleted("line")}`;
const statementSettlementScope = sql`evidence.kind=${entityExternalIdKind.enum.settlement_ref} AND ${notDeleted("evidence")}
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

function recordRefsMatch(scope: AssessmentRecordScope, refs: SQL) {
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${refs}) r
    WHERE ${relatedRecordMatch(scope, sql`r->>'entity'`, sql<string>`r->>'id'`)})`;
}

function statementReferenceMatch(scope: AssessmentRecordScope) {
  const requested = scope.entity
    ? [scope.entity]
    : scope.records?.map((r) => r.entity);
  const direct = statementRecordParts(requested, false);
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
  return or(
    direct.length
      ? recordRefsMatch(scope, sql.join(direct, sql` || `))
      : undefined,
    settled.length
      ? sql`EXISTS (SELECT 1 ${statementSettlementFrom}
          WHERE ${statementSettlementScope} AND ${or(...settled)})`
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
      const retained = scope.records
        ? or(
            ...scope.records.flatMap((record) =>
              [record.id, record.code].map(
                (id) =>
                  sql`a.evidence->'records' @> ${JSON.stringify([{ entity: record.entity, id }])}::jsonb`,
              ),
            ),
          )
        : sql`EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(a.evidence->'records', '[]'::jsonb)) r
            WHERE ${relatedRecordMatch(scope, sql`r->>'entity'`, sql<string>`r->>'id'`)})`;
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

const assessmentRecordsSql = (entities?: readonly string[]) =>
  sql`CASE ${sql.join(
    Object.entries(reviewFamilyDeclarations).map(
      ([family, spec]) =>
        sql`WHEN a.family = ${family} THEN ${entities && "recordsFor" in spec ? spec.recordsFor(entities) : spec.records}`,
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

export type AssessmentRecordScope = {
  entity?: string;
  records?: readonly { code: string; entity: string; id: string }[];
  eligibility: AssessmentEligibility;
};

function assessmentAdmission(
  db: Database,
  eligibility: Extract<AssessmentEligibility, { kind: "suggestions" }>,
) {
  const a = reviewAssessment;
  const s = reviewState;
  return and(
    a.served,
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

/** Member rejection and current suppression independently remove pending connections. */
export function pendingRecommendationEligibility() {
  const suppressed = alias(assessmentState, "suppressed");
  const suppressionValue = (key: "scope" | "candidateKey" | "fingerprint") =>
    sql<string>`${suppressed.suppression}->>${key}`;
  return and(
    notExists(
      feedbackForAssessment(
        and(
          eq(receipt.authority, feedbackAuthority.enum.member),
          inArray(receipt.verdict, [
            feedbackVerdict.enum.wrong,
            feedbackVerdict.enum.dismissed,
          ]),
        ),
      ),
    ),
    notExists(
      reviewQueryBuilder
        .select({ id: suppressed.id })
        .from(suppressed)
        .where(
          and(
            suppressed.active,
            eq(suppressed.entity, reviewState.entity),
            eq(suppressed.recordId, reviewState.recordId),
            eq(
              suppressionValue("scope"),
              sql<string>`${reviewAssessment.subject}->>'scope'`,
            ),
            eq(
              suppressionValue("candidateKey"),
              sql<string>`${reviewAssessment.subject}->>'candidateKey'`,
            ),
            or(
              isNull(suppressionValue("fingerprint")),
              eq(suppressionValue("fingerprint"), reviewAssessment.fingerprint),
            ),
          ),
        ),
    ),
  );
}

function assessmentRecordMatches(scope: AssessmentRecordScope): SQL[] {
  const requested = scope.entity
    ? [scope.entity]
    : scope.records?.map((r) => r.entity);
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
      const match =
        "matchesRelatedRecords" in spec
          ? spec.matchesRelatedRecords(scope)
          : recordRefsMatch(
              scope,
              requested && "recordsFor" in spec
                ? spec.recordsFor(requested)
                : spec.records,
            );
      return match ? [{ family: assessmentFamily.parse(family), match }] : [];
    },
  );
  // Separate branches let Postgres narrow state identities/families before
  // joining immutable evidence. One CASE across families scanned every served
  // Assessment and spilled the pending-state join during ordinary list reads.
  return [
    sql`${primaryMatch}`,
    ...connectionMatches,
    ...secondary.map(
      ({ family, match }) => sql`${and(eq(reviewState.family, family), match)}`,
    ),
  ];
}

/** Scope identities before expensive automatic receipts; retain a statement-local barrier. */
function touchingAssessmentQuery(db: Database, scope: AssessmentRecordScope) {
  const client = unwrapDb(db);
  const a = reviewAssessment;
  const s = reviewState;
  const branches = assessmentRecordMatches(scope);
  const admission =
    scope.eligibility.kind === "automatic"
      ? and(
          a.served,
          inArray(
            s.family,
            Object.keys(reviewFamilyDeclarations).map((family) =>
              assessmentFamily.parse(family),
            ),
          ),
          scope.eligibility.family
            ? eq(s.family, scope.eligibility.family)
            : undefined,
        )
      : assessmentAdmission(db, scope.eligibility);
  const matched = sql.join(
    branches.map((match) =>
      client
        .select({ id: a.id, family: a.family, status: s.status })
        .from(a)
        .innerJoin(s, eq(s.id, a.id))
        .where(and(admission, match))
        .getSQL(),
    ),
    sql` UNION ALL `,
  );
  if (scope.eligibility.kind === "suggestions") return matched;
  // Keep receipt validation outside identity discovery. Reading the scoped
  // family/status directly prevents the planner from scanning Assessment again
  // and validating receipts before the matched-id join. Held pending corrections
  // still enter through the same candidate and authority checks.
  return sql`WITH matched AS MATERIALIZED (
    SELECT DISTINCT id, family, status FROM (${matched}) identities)
    SELECT DISTINCT a.id FROM matched a
    CROSS JOIN LATERAL (SELECT a.status) s
    WHERE ${automaticAssessmentEligibility(scope.eligibility.appliedRule(sql`${a.id}`), true)}`;
}

export async function touchingAssessmentIds(
  db: Database,
  scope: AssessmentRecordScope,
) {
  if (!scope.entity && !scope.records) return null;
  if (scope.records?.length === 0) return new Set<string>();
  const { rows } = await unwrapDb(db).execute<{ id: string }>(
    touchingAssessmentQuery(db, scope),
  );
  return new Set(rows.map((row) => row.id));
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
