import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentFamily,
  assessmentJudgments,
  assessmentProducer,
  feedbackAuthority,
  type AssessmentFamily,
} from "@cubby/schemas/assessment";
import { assessmentReviewFamilies } from "@cubby/schemas/assessment-review-family";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { entityExternalIdKind } from "@cubby/schemas/external-id";
import { financialTransactionSourceRef } from "@cubby/schemas/financial-transaction-fields";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import { mailboxClassificationStage } from "@cubby/schemas/mailbox-research";
import { statementTransactionAction } from "@cubby/schemas/statement-suggestion";
import { suggestionRecordRef } from "@cubby/schemas/suggestion-list";
import { parseShortcode } from "@cubby/shared";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import {
  EMAIL_APPLICATION_RECEIPT,
  EMAIL_OBSERVATION_RECEIPT,
} from "~/server/generic/assessment/repo/assessment-email";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

const entities = z.enum(shortcodeEntities).enum;
type DecisionValue = z.infer<ReturnType<typeof z.json>>;
const ref = (entity: SQL, id: SQL) =>
  sql`jsonb_build_object('entity', (${entity})::text, 'id', (${id})::text)`;
const primary = ref(sql`s.entity`, sql`s."recordId"::text`);
const one = sql`jsonb_build_array(${primary})`;
const linkedPurchases = sql`COALESCE((SELECT jsonb_agg(${ref(sql`${entities.purchase}`, sql`link.data->>'purchaseId'`)}) FROM "AssessmentState" link JOIN "Assessment" publication ON publication.id = link.id
  WHERE link.family = ${assessmentFamily.enum.email_link} AND link.active AND link.data->>${assessmentJudgments.email_link.keyof().enum.decision} = ${assessmentJudgments.email_link.shape.decision.enum.linked}
    AND EXISTS (SELECT 1 FROM "Email" mail WHERE mail.id = s."recordId" AND mail."deletedAt" IS NULL AND (publication.subject->>'recordId' = mail.id::text OR publication.subject->>'originalId' = mail."orderMailId"::text))), '[]'::jsonb)`;
const emailApplication = sql`EXISTS (SELECT 1 FROM "Feedback" receipt WHERE receipt."assessmentId" = a.id AND receipt.authority = ${feedbackAuthority.enum.automatic}
  AND (receipt.metadata->>${assessmentProducer.keyof().enum.kind} = ${EMAIL_APPLICATION_RECEIPT} OR receipt."operationId" = ${mailboxClassificationStage.enum.resolution}))`;
const emailAudit = sql`NOT EXISTS (SELECT 1 FROM "Feedback" member_resolution WHERE member_resolution."assessmentId" = a.id AND member_resolution."operationId" = ${mailboxClassificationStage.enum.resolution} AND member_resolution.authority = ${feedbackAuthority.enum.member})
  AND (${emailApplication} OR NOT EXISTS (SELECT 1 FROM "Feedback" observed WHERE observed."assessmentId" = a.id AND observed.metadata->>${assessmentProducer.keyof().enum.kind} = ${EMAIL_OBSERVATION_RECEIPT}))`;
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
      sql`jsonb_build_array(${ref(sql`${entities.email}`, sql`COALESCE(a.subject->>'recordId', (SELECT mail.id::text FROM "Email" mail WHERE mail."orderMailId"::text = a.subject->>'originalId' AND mail."deletedAt" IS NULL))`)})`,
    );
  if (!requested || requested.includes(entities.purchase))
    parts.push(
      sql`jsonb_build_array(${ref(sql`${entities.purchase}`, sql`s.data->>'purchaseId'`)})`,
    );
  return parts.length ? sql.join(parts, sql` || `) : sql`'[]'::jsonb`;
};
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
  ${ref(sql`'ledgerParty'`, sql`a.judgment->${end}->'owner'->>'id'`)})`;

const recommendationScopes = {
  connection: sql`a.subject->>'scope' LIKE 'connection.%'`,
  tagPropagation: sql`a.subject->>'scope' = 'product.tag-propagation'`,
};

/** Narrow requested reference kinds before expanding candidate and settlement graphs. */
function statementRecords(requested?: readonly string[]) {
  const includes = (entity: string) => !requested || requested.includes(entity);
  const parts: SQL[] = [];
  const add = (entity: string, id: SQL) => {
    if (includes(entity))
      parts.push(sql`jsonb_build_array(${ref(sql`${entity}`, id)})`);
  };
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
    sql`(SELECT v.id::text FROM "Vendor" v WHERE v.shortcode=a.judgment->'spending'->>'vendorId' AND v."deletedAt" IS NULL)`,
  );
  add(
    entities.spendingCategory,
    sql`(SELECT category.id::text FROM "SpendingCategory" category WHERE category.shortcode=a.judgment->'spending'->>'spendingCategoryId' AND category."deletedAt" IS NULL)`,
  );
  const related = [
    { entity: entities.financialTransaction, id: sql`settled.id::text` },
    { entity: entities.purchase, id: sql`booked.id::text` },
    { entity: entities.expense, id: sql`line.id::text` },
    { entity: entities.vendor, id: sql`booked."vendorId"::text` },
    { entity: entities.ledgerParty, id: sql`account."ledgerPartyId"::text` },
  ].filter(({ entity }) => includes(entity));
  if (related.length)
    parts.push(sql`COALESCE((SELECT jsonb_agg(${ref(sql`related.kind`, sql`related.id`)})
        FROM "EntityExternalId" evidence
        JOIN "FinancialTransaction" settled ON settled.id=evidence."entityId" AND settled."deletedAt" IS NULL
        JOIN "FinancialAccount" account ON account.id=settled."accountId"
        LEFT JOIN "FinancialTransactionAllocation" allocation ON allocation."transactionId"=settled.id AND allocation."deletedAt" IS NULL
        LEFT JOIN "Purchase" booked ON booked.id=allocation."purchaseId" AND booked."deletedAt" IS NULL
        LEFT JOIN "Expense" line ON line."purchaseId"=booked.id AND line."deletedAt" IS NULL
        CROSS JOIN LATERAL (VALUES ${sql.join(
          related.map(({ entity, id }) => sql`(${entity},${id})`),
          sql`, `,
        )}) related(kind,id)
        WHERE evidence.kind=${entityExternalIdKind.enum.settlement_ref} AND evidence."deletedAt" IS NULL
          AND evidence.source=a.judgment->${statementTransactionAction.enum.create}->'sourceRef'->>${financialTransactionSourceRef.keyof().enum.source}
          AND evidence."externalId"=a.judgment->${statementTransactionAction.enum.create}->'sourceRef'->>'externalId'
          AND related.id IS NOT NULL), '[]'::jsonb)`);
  if (includes(entities.purchase))
    parts.push(sql`COALESCE((SELECT jsonb_agg(${ref(sql`${entities.purchase}`, sql`p.id::text`)})
        FROM jsonb_array_elements(COALESCE(a.judgment->'spending'->'candidates','[]'::jsonb)) candidate
        JOIN "Purchase" p ON p.shortcode=candidate->>'purchaseId' AND p."deletedAt" IS NULL), '[]'::jsonb)`);
  if (includes(entities.financialTransaction))
    parts.push(
      sql`COALESCE((SELECT jsonb_agg(${ref(sql`${entities.financialTransaction}`, sql`c->>'transactionId'`)}) FROM jsonb_array_elements(a.judgment->'candidates') c), '[]'::jsonb)`,
    );
  return parts.length ? sql.join(parts, sql` || `) : sql`'[]'::jsonb`;
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
    actionable: sql`(${sql.join(Object.values(recommendationScopes), sql` OR `)})`,
  },
  product_pair: {
    ...assessmentReviewFamilies.product_pair,
    records: sql`${one} || jsonb_build_array(${ref(sql`${entities.product}`, sql`s.data->>'otherId'`)})`,
    actionable: sql`a.judgment->'actionable' = 'true'::jsonb`,
  },
  image_description: {
    ...assessmentReviewFamilies.image_description,
    records: one,
    actionable: sql`jsonb_typeof(a.judgment) = 'string' AND length(trim(a.judgment #>> '{}')) > 0`,
  },
  statement_transaction: {
    ...assessmentReviewFamilies.statement_transaction,
    records: statementRecords(),
    recordsFor: statementRecords,
    actionable: sql`true`,
    summarize: (value: unknown) => {
      const decision = assessmentJudgments.statement_transaction.parse(value);
      return `Statement transaction: ${decision.recommended}`;
    },
  },
  transfer_pair: {
    ...assessmentReviewFamilies.transfer_pair,
    records: sql`${leg("outflow")} || ${leg("inflow")}`,
    actionable: sql`true`,
  },
  email_relevance: {
    ...assessmentReviewFamilies.email_relevance,
    records: one,
    actionable: sql`false`,
    audit: emailAudit,
    verified: emailApplication,
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
    actionable: sql`false`,
    audit: sql`EXISTS (SELECT 1 FROM "Feedback" original WHERE original."assessmentId" = a.id AND original."operationId" = ${mailboxClassificationStage.enum.decision} AND original.authority = ${feedbackAuthority.enum.automatic})`,
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
    actionable: sql`false`,
    audit: sql`true`,
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
    recordsFor?: (entities: readonly string[]) => SQL;
    actionable: SQL;
    scopes?: typeof recommendationScopes;
    audit?: SQL;
    verified?: SQL;
    summarize?: (value: DecisionValue) => string;
    correction?: {
      label: string;
      options: { label: string; value: DecisionValue }[];
    };
  }
>;

/** Rule applications leave pending; automatic families retain legacy pending history. */
export const automaticAssessmentCandidate = sql`(a.family IN (${sql.join(
  Object.keys(reviewFamilyDeclarations).map((family) => sql`${family}`),
  sql`, `,
)}) AND (a.family IN (${sql.join(
  Object.entries(reviewFamilyDeclarations).flatMap(([family, declaration]) =>
    declaration.kind === "automatic_decision" ? [sql`${family}`] : [],
  ),
  sql`, `,
)}) OR s.status <> ${suggestionStatus.enum.pending}))`;

export const automaticFamilyEligibility = sql`(${sql.join(
  Object.entries(reviewFamilyDeclarations).flatMap(([family, declaration]) =>
    "audit" in declaration
      ? [sql`(a.family = ${family} AND ${declaration.audit})`]
      : [],
  ),
  sql` OR `,
)})`;
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

/** Eligibility fragments use `a` for Assessment and `s` for AssessmentState. */
export async function touchingAssessmentIds(
  db: Database,
  scope: {
    entity?: string;
    records?: readonly { code: string; entity: string; id: string }[];
    eligibility: SQL;
  },
) {
  if (!scope.entity && !scope.records) return null;
  if (scope.records?.length === 0) return new Set<string>();
  const recordMatch = scope.records
    ? sql`AND (${sql.join(
        scope.records.map(
          (record) =>
            sql`(r->>'entity' = ${record.entity} AND r->>'id' IN (${record.id}, ${record.code}))`,
        ),
        sql` OR `,
      )})`
    : sql``;
  const { rows } = await unwrapDb(db).execute<{
    id: string;
  }>(sql`WITH eligible AS MATERIALIZED (
      SELECT a.id FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id WHERE ${scope.eligibility}
    ) SELECT a.id FROM eligible JOIN "Assessment" a ON a.id = eligible.id JOIN "AssessmentState" s ON s.id = a.id
    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(${assessmentRecordsSql(scope.entity ? [scope.entity] : scope.records ? [...new Set(scope.records.map((r) => r.entity))] : undefined)}) r WHERE r->>'id' IS NOT NULL
      ${scope.entity ? sql`AND r->>'entity' = ${scope.entity}` : sql``} ${recordMatch})`);
  return new Set(rows.map((row) => row.id));
}
