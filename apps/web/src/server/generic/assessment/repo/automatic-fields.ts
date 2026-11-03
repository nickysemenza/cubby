import { suggestionStatus, fieldSuggestionsInput } from "@cubby/schemas/ai";
import { suggestionAcceptanceReceipt } from "@cubby/schemas/ai-evaluation";
import {
  assessmentFamily,
  assessmentSubjects,
  feedbackAuthority,
  feedbackVerdict,
} from "@cubby/schemas/assessment";
/** Current field decisions backed by Automatic rule applications, never model confidence alone. */
import { auditLogActionSchema } from "@cubby/schemas/audit";
import type { ActorContext } from "@cubby/schemas/context";
import type { Entity } from "@cubby/schemas/entity";
import {
  entityFieldByKey,
  entityFieldModels,
} from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { fieldAssignmentOwnership } from "@cubby/schemas/field-envelope";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";
import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { assessment, feedback } from "~/server/db/retained-tables";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import {
  automaticApplicationRule,
  publishAssessment,
  recordFeedback,
} from "~/server/generic/assessment/repo/assessment";
import { fieldWriteRevision } from "~/server/generic/audit-log/repo/field-write";
import type { CurrentFieldOwnership } from "~/server/generic/derived/repo/read-context";
export type { CurrentFieldOwnership } from "~/server/generic/derived/repo/read-context";

const currentOwnership = z.record(
  z.string(),
  fieldAssignmentOwnership.options[1],
);

/** Receipt and audit checks establish current authority in one page query. */
export async function loadCurrentFieldOwnership(
  db: RepositoryQueryInput,
  entity: Entity,
  ids: readonly string[],
): Promise<Map<string, CurrentFieldOwnership>> {
  const eligibleEntity = fieldSuggestionsInput.shape.entity.safeParse(entity);
  if (!ids.length || !eligibleEntity.success) return new Map();
  if (
    !entityFieldModels[entity].fields.some(
      (field) =>
        field.control?.suggest?.mode === "fill" &&
        !field.control.suggest.reviewRequired,
    )
  )
    return new Map();
  const table = alias(SHORTCODE_TABLE[eligibleEntity.data], "t");
  const tableName = SHORTCODE_TABLE[eligibleEntity.data];
  const rows = await unwrapDb(db).execute<{
    id: string;
    value: unknown;
  }>(sql`
          SELECT t.id::text AS id, COALESCE((
            SELECT jsonb_object_agg(s.field, jsonb_build_object(${fieldAssignmentOwnership.options[1].keyof().enum.kind}::text, ${fieldAssignmentOwnership.options[1].shape.kind.value}::text, 'receiptId', s.id::text, 'confidence',
              (s."acceptanceReceipt"->>'confidence')::double precision))
            FROM "AssessmentState" s JOIN "Assessment" a ON a.id = s.id
            WHERE s.entity = ${entity} AND s."recordId" = t.id
              AND s.family = ${assessmentFamily.enum.field} AND s.status = ${suggestionStatus.enum.applied}
              AND a.subject->>'entity' = s.entity AND a.subject->>${assessmentSubjects.field.keyof().enum.field} = s.field
              AND a.subject->>'recordId' = t.id::text
              AND s."acceptanceReceipt"->>'mode' = ${feedbackAuthority.enum.automatic}
              AND jsonb_typeof(s."acceptanceReceipt"->'confidence') = ${"number"}
              AND ${automaticApplicationRule(sql`s.id`)} IS NOT NULL
              AND EXISTS (SELECT 1 FROM "AuditLog" applied
                WHERE applied."entityKind" = s.entity AND applied."entityId" = t.id
                  AND s."acceptanceReceipt"->'auditIds' ? applied.id::text
                  AND applied.changes ? s.field
                  AND applied.changes->s.field->'to' = to_jsonb(t)->s.field)
              -- Automatic fill requires untouched fields. Every update must belong
              -- to this receipt; this also rejects ABA edits when timestamps tie.
              AND NOT EXISTS (SELECT 1 FROM "AuditLog" edited
                WHERE edited."entityKind" = s.entity AND edited."entityId" = t.id
                  AND edited.action = ${auditLogActionSchema.enum.update} AND edited.changes ? s.field
                  AND NOT (s."acceptanceReceipt"->'auditIds' ? edited.id::text))
              AND NOT EXISTS (SELECT 1 FROM "Feedback" member
                JOIN "AssessmentState" reviewed ON reviewed.id = member."assessmentId"
                WHERE reviewed.entity = s.entity AND reviewed."recordId" = s."recordId"
                  AND reviewed.family = ${assessmentFamily.enum.field} AND reviewed.field = s.field
                  AND member.authority = ${feedbackAuthority.enum.member} AND member.verdict IN (${feedbackVerdict.enum.correct}, ${feedbackVerdict.enum.wrong})
                  AND member."createdAt" >= (s."acceptanceReceipt"->>'acceptedAt')::timestamp)
          ), '{}'::jsonb) AS value
          FROM ${tableName} t
          WHERE t.id = ANY(${uuidArrayParam(ids)}) AND ${notDeleted(table)}
        `);
  return new Map(
    rows.rows.map((row) => [
      row.id,
      Object.fromEntries(
        Object.entries(currentOwnership.parse(row.value)).filter(([field]) => {
          const policy = entityFieldByKey(entity, field)?.control?.suggest;
          return policy?.mode === "fill" && !policy.reviewRequired;
        }),
      ),
    ]),
  );
}

const receiptFieldAuthority = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }),
  z.object({
    kind: z.literal("automatic"),
    receiptId: z.uuid(),
    auditIds: z.array(z.uuid()),
  }),
  z.object({
    kind: z.literal("member"),
    receiptId: z.uuid(),
    auditIds: z.array(z.uuid()),
  }),
]);

const sourceAssignmentWitness = z.object({
  kind: z.literal("source_assignment"),
  writeRevision: z.string(),
  rawValue: z.json(),
});

/** Reuse the shared field-write fence and immutable application receipts; unknown history stays unknown. */
export async function loadReceiptFieldAuthority(
  db: RepositoryQueryInput,
  entity: ShortcodeEntity,
  recordId: string,
  field: string,
  rawValue: z.infer<ReturnType<typeof z.json>>,
): Promise<z.infer<typeof receiptFieldAuthority>> {
  const revision = await fieldWriteRevision(db, entity, recordId, field);
  const rows = await unwrapDb(db)
    .select({
      id: feedback.id,
      authority: feedback.authority,
      verdict: feedback.verdict,
      intent: feedback.intent,
      receipt: feedback.receipt,
      evidence: assessment.evidence,
    })
    .from(assessment)
    .innerJoin(feedback, eq(feedback.assessmentId, assessment.id))
    .where(
      and(
        eq(assessment.family, assessmentFamily.enum.field),
        sql`${assessment.subject}->>'entity' = ${entity}`,
        sql`${assessment.subject}->>'recordId' = ${recordId}`,
        sql`${assessment.subject}->>${assessmentSubjects.field.keyof().enum.field} = ${field}`,
        inArray(feedback.authority, [
          feedbackAuthority.enum.automatic,
          feedbackAuthority.enum.member,
        ]),
      ),
    )
    .orderBy(desc(feedback.createdAt), desc(feedback.id))
    .limit(50);
  for (const row of rows) {
    const witness = sourceAssignmentWitness.safeParse(row.evidence);
    const receipt = suggestionAcceptanceReceipt.safeParse(row.receipt);
    if (
      witness.success &&
      receipt.success &&
      receipt.data.mode === row.authority &&
      receipt.data.auditIds.length &&
      witness.data.writeRevision === revision &&
      isEqual(witness.data.rawValue, rawValue)
    )
      return row.authority === "automatic" &&
        rows.some(
          (review) =>
            review.authority === "member" &&
            (review.verdict === "correct" || review.verdict === "wrong"),
        )
        ? { kind: "unknown" }
        : receiptFieldAuthority.parse({
            kind: row.authority,
            receiptId: row.id,
            auditIds: receipt.data.auditIds,
          });
  }
  return { kind: "unknown" };
}

/** Records specialist assignment intent in the shared receipt ledger, atomically with its field audit. */
export async function recordFieldAssignmentReceipt(
  db: Database,
  input: {
    entity: ShortcodeEntity;
    recordId: string;
    field: string;
    value: z.infer<ReturnType<typeof z.json>>;
    rawValue: z.infer<ReturnType<typeof z.json>>;
    authority: "automatic" | "member";
    actor: ActorContext;
    auditIds: readonly string[];
  },
) {
  if (!input.auditIds.length)
    throw new Error(
      "Assignment intent requires its actual field audit receipt",
    );
  const auditIds = [...new Set(input.auditIds)];
  const writeRevision = await fieldWriteRevision(
    db,
    input.entity,
    input.recordId,
    input.field,
  );
  const receipt = suggestionAcceptanceReceipt.parse({
    mode: input.authority,
    runId: input.actor.runId ?? null,
    auditIds,
    acceptedAt: new Date().toISOString(),
    reason:
      input.authority === "member"
        ? "member_acceptance"
        : "confident_assignment",
    confidence: null,
    threshold: null,
  });
  const publication = await publishAssessment(
    db,
    {
      publicationKey: `field-assignment:${input.entity}:${input.recordId}:${input.field}:${crypto.randomUUID()}`,
      family: "field",
      subject: {
        kind: "field",
        entity: input.entity,
        recordId: input.recordId,
        field: input.field,
        draft: false,
      },
      judgment: { value: input.value },
      fingerprint: null,
      producer: {
        kind: "rule",
        model: null,
        revision: "source-assignment@1",
        runId: input.actor.runId ?? null,
        evaluationId: null,
      },
      evidence: {
        kind: "source_assignment",
        writeRevision,
        rawValue: input.rawValue,
      },
      served: true,
    },
    {
      status: "applied",
      field: input.field,
      acceptanceReceipt: receipt,
      currentValue: input.value,
      suggestedValue: input.value,
    },
  );
  await recordFeedback(db, {
    assessmentId: publication.id,
    operationId: "source-assignment-application",
    verdict: "correct",
    authority: input.authority,
    actorUserId: input.actor.userId,
    intent: "apply",
    receipt,
    metadata: {
      kind: "assessment_application",
      ...(input.authority === "automatic"
        ? { rule: { key: "retained-source", revision: 1 } }
        : {}),
    },
  });
}
