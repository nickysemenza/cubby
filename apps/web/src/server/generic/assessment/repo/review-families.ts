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
    AND EXISTS (SELECT 1 FROM "Email" mail WHERE mail.id = s."recordId" AND mail."deletedAt" IS NULL AND (publication.subject->>'recordId' = mail.id::text OR publication.subject->>'originalId' = mail."orderMailId"::text))), '[]'::jsonb)`;
const receipt = alias(feedback, "receipt");
const reviewQueryBuilder = new QueryBuilder();
const receiptKind = sql<string>`${receipt.metadata}->>${assessmentProducer.keyof().enum.kind}`;
const feedbackForAssessment = (predicate: SQL | undefined) =>
  reviewQueryBuilder
    .select({ id: receipt.id })
    .from(receipt)
    .where(and(eq(receipt.assessmentId, reviewAssessment.id), predicate));
const emailApplication = exists(
  feedbackForAssessment(
    and(
      eq(receipt.authority, feedbackAuthority.enum.automatic),
      or(
        eq(receiptKind, EMAIL_APPLICATION_RECEIPT),
        eq(receipt.operationId, mailboxClassificationStage.enum.resolution),
      ),
    ),
  ),
);
const emailAudit = and(
  notExists(
    feedbackForAssessment(
      and(
        eq(receipt.operationId, mailboxClassificationStage.enum.resolution),
        eq(receipt.authority, feedbackAuthority.enum.member),
      ),
    ),
  ),
  or(
    emailApplication,
    notExists(
      feedbackForAssessment(eq(receiptKind, EMAIL_OBSERVATION_RECEIPT)),
    ),
  ),
)!;
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
  ${ref(sql`${entities.ledgerParty}`, sql`a.judgment->${end}->'owner'->>'id'`)})`;

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
  // A proposal belongs to the charge, including retained predecessors and later memberships.
  const sourceScope = sql`observed.source = s.data->>${financialTransactionSourceRef.keyof().enum.source}
    AND ${chargeKeyOf("observed")} = s.data->>'chargeKey' AND observed."deletedAt" IS NULL`;
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
    sql`(SELECT v.id::text FROM "Vendor" v WHERE v.shortcode=a.judgment->${statementTransactionJudgment.keyof().enum.spending}->>'vendorId' AND v."deletedAt" IS NULL)`,
  );
  add(
    entities.spendingCategory,
    sql`(SELECT category.id::text FROM "SpendingCategory" category WHERE category.shortcode=a.judgment->${statementTransactionJudgment.keyof().enum.spending}->>'spendingCategoryId' AND category."deletedAt" IS NULL)`,
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
        FROM jsonb_array_elements(COALESCE(a.judgment->${statementTransactionJudgment.keyof().enum.spending}->'candidates','[]'::jsonb)) candidate
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
    primaryOnly: true,
    actionable: sql`jsonb_typeof(a.judgment) = 'string' AND ${hasTextSql(sql`a.judgment #>> '{}'`)}`,
    audit: exists(
      feedbackForAssessment(
        and(
          eq(receipt.authority, "automatic"),
          eq(receipt.actorUserId, SYSTEM_USER_ID),
          eq(receipt.intent, "history"),
          eq(receiptKind, CORRECTION_OUTCOME_RECEIPT_KIND),
        ),
      ),
    ),
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
    primaryOnly: true,
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
    audit: exists(
      feedbackForAssessment(
        and(
          eq(receipt.operationId, mailboxClassificationStage.enum.decision),
          eq(receipt.authority, feedbackAuthority.enum.automatic),
        ),
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
    primaryOnly?: boolean;
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
export const automaticAssessmentCandidate = and(
  inArray(
    reviewAssessment.family,
    Object.keys(reviewFamilyDeclarations).map((family) =>
      assessmentFamily.parse(family),
    ),
  ),
  or(
    correctionOutcomeExists(sql`${reviewAssessment.id}`),
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
  ),
)!;

export const automaticFamilyEligibility = or(
  correctionOutcomeExists(sql`${reviewAssessment.id}`),
  ...Object.entries(reviewFamilyDeclarations).flatMap(
    ([family, declaration]) =>
      "audit" in declaration
        ? [
            and(
              eq(reviewAssessment.family, assessmentFamily.parse(family)),
              declaration.audit,
            )!,
          ]
        : [],
  ),
)!;
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

function assessmentAdmission(db: Database, eligibility: AssessmentEligibility) {
  const a = reviewAssessment;
  const s = reviewState;
  if (eligibility.kind === "automatic")
    return and(
      a.served,
      automaticAssessmentCandidate,
      eligibility.family ? eq(a.family, eligibility.family) : undefined,
    );
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

function assessmentAudit(eligibility: AssessmentEligibility) {
  return eligibility.kind === "automatic"
    ? or(
        automaticFamilyEligibility,
        isNotNull(eligibility.appliedRule(sql`${reviewAssessment.id}`)),
      )
    : undefined;
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

function assessmentRecordMatches(
  scope: AssessmentRecordScope,
  separateFamilies: boolean,
): SQL[] {
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
    inArray(
      separateFamilies ? reviewState.family : reviewAssessment.family,
      primaryFamilies,
    ),
    scope.entity ? eq(reviewState.entity, scope.entity) : undefined,
    scope.records
      ? or(
          ...scope.records.map((r) =>
            and(
              eq(reviewState.entity, r.entity),
              separateFamilies
                ? eq(reviewState.recordId, r.id)
                : inArray(sql<string>`${reviewState.recordId}::text`, [
                    r.id,
                    r.code,
                  ]),
            ),
          ),
        )
      : undefined,
  );
  const recordMatch = scope.records
    ? or(
        ...scope.records.map((r) =>
          and(
            eq(sql<string>`r->>'entity'`, r.entity),
            inArray(sql<string>`r->>'id'`, [r.id, r.code]),
          ),
        ),
      )
    : undefined;
  const recordExists = (refs: SQL) =>
    sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${refs}) r WHERE ${and(isNotNull(sql`r->>'id'`), scope.entity ? eq(sql<string>`r->>'entity'`, scope.entity) : undefined, recordMatch)})`;
  const secondary = Object.entries(reviewFamilyDeclarations).flatMap(
    ([family, spec]) => {
      if ("primaryOnly" in spec) return [];
      return [
        {
          family: assessmentFamily.parse(family),
          refs:
            requested && "recordsFor" in spec
              ? spec.recordsFor(requested)
              : spec.records,
        },
      ];
    },
  );
  // Automatic history keeps one matched-id barrier before expensive receipts.
  if (!separateFamilies) {
    const refs = sql`CASE ${sql.join(
      secondary.map(
        ({ family, refs }) => sql`WHEN a.family = ${family} THEN ${refs}`,
      ),
      sql` `,
    )} ELSE '[]'::jsonb END`;
    return [
      sql`CASE WHEN ${primaryMatch} THEN true ELSE ${recordExists(refs)} END`,
    ];
  }
  // Separate branches let Postgres narrow state identities/families before
  // joining immutable evidence. One CASE across families scanned every served
  // Assessment and spilled the pending-state join during ordinary list reads.
  return [
    sql`${primaryMatch}`,
    ...secondary.map(
      ({ family, refs }) =>
        sql`${and(eq(reviewState.family, family), recordExists(refs))}`,
    ),
  ];
}

/** Scope identities before expensive automatic receipts; retain a statement-local barrier. */
function touchingAssessmentQuery(db: Database, scope: AssessmentRecordScope) {
  const client = unwrapDb(db);
  const a = reviewAssessment;
  const s = reviewState;
  const branches = assessmentRecordMatches(
    scope,
    scope.eligibility.kind === "suggestions",
  );
  const matched = sql.join(
    branches.map((match) =>
      client
        .select({ id: a.id })
        .from(a)
        .innerJoin(s, eq(s.id, a.id))
        .where(
          and(
            assessmentAdmission(db, scope.eligibility),
            match,
            !scope.records ? assessmentAudit(scope.eligibility) : undefined,
          ),
        )
        .getSQL(),
    ),
    sql` UNION ALL `,
  );
  if (scope.eligibility.kind === "suggestions" || !scope.records)
    return matched;
  // Drizzle 0.45 has no MATERIALIZED CTE option; only this boundary is raw SQL.
  const ids = sql`(WITH matched AS MATERIALIZED (${matched}) SELECT id FROM matched)`;
  return client
    .select({ id: a.id })
    .from(a)
    .innerJoin(s, eq(s.id, a.id))
    .where(and(inArray(a.id, ids), assessmentAudit(scope.eligibility)))
    .getSQL();
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
    AND EXISTS (SELECT 1 FROM "Image" i WHERE i.id = s."recordId" AND i."deletedAt" IS NULL)`;
}
