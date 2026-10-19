import {
  assessmentChildHandle,
  assessmentSuppression,
} from "./assessment-reference";
export {
  assessmentChildHandle,
  assessmentSuppression,
  assessmentReviewReference,
} from "./assessment-reference";
import {
  productShortcode,
  imageShortcode,
  anyShortcodeSchema,
  nonEmptyTuple,
} from "./identifiers";
import { shortcodeEntities } from "./entity-manifest";
import {
  statementTransactionApplication,
  statementTransactionJudgment,
} from "./statement-suggestion";
import { z } from "zod";
import { entityGraphRootSchema } from "./entity-graph";

/** Unknown historical values stay nullable; corrections explicitly distinguish absent from JSON null. */
export const assessmentCorrection = z.discriminatedUnion("present", [
  z.object({ present: z.literal(false) }),
  z.object({ present: z.literal(true), value: z.json() }),
]);
export const assessmentFamily = z.enum([
  "field",
  "email_relevance",
  "email_link",
  "mail_import_outcome",
  "image_description",
  "product_pair",
  "recommendation",
  "statement_transaction",
]);
export const feedbackVerdict = z.enum([
  "correct",
  "wrong",
  "uncertain",
  "dismissed",
  "ungraded",
]);
const record = { entity: z.string().min(1), recordId: z.uuid() };
export const assessmentSubjects = {
  field: z.object({
    kind: z.literal("field"),
    ...record,
    recordId: z.uuid().nullable(),
    field: z.string().min(1),
    draft: z.boolean().default(false),
  }),
  email_relevance: z.object({
    kind: z.literal("email_relevance"),
    entity: z.literal("email"),
    recordId: z.uuid(),
    checksum: z.string().nullable(),
    observationId: z.uuid().nullable(),
  }),
  mail_import_outcome: z.object({
    kind: z.literal("mail_import_outcome"),
    entity: z.literal("email"),
    recordId: z.uuid(),
    checksum: z.string(),
    runId: z.uuid(),
  }),
  email_link: z.object({
    kind: z.literal("email_link"),
    entity: z.literal("email"),
    recordId: z.uuid().nullable(),
    originalId: z.uuid(),
    eventId: z.uuid(),
    purchaseId: z.uuid(),
    checksum: z.string(),
  }),
  image_description: z.object({
    kind: z.literal("image_description"),
    entity: z.literal("image"),
    recordId: z.uuid(),
    contentHash: z.string().nullable(),
  }),
  product_pair: z
    .object({
      kind: z.literal("product_pair"),
      entity: z.literal("product"),
      recordId: z.uuid(),
      otherId: z.uuid(),
    })
    .refine(
      ({ recordId, otherId }) => recordId < otherId,
      "Product pairs must be canonical and distinct",
    ),
  recommendation: z.object({
    kind: z.literal("recommendation"),
    ...record,
    scope: z.string(),
    candidateKey: z.string(),
  }),
  /** One provider charge: every observation sharing its v1 identity. */
  statement_transaction: z.object({
    kind: z.literal("statement_transaction"),
    entity: z.literal("statementRow"),
    recordId: z.uuid(),
    source: z.string().min(1),
    chargeKey: z.string().min(1),
  }),
};
export const assessmentSubject = z.discriminatedUnion("kind", [
  assessmentSubjects.field,
  assessmentSubjects.email_relevance,
  assessmentSubjects.email_link,
  assessmentSubjects.mail_import_outcome,
  assessmentSubjects.image_description,
  assessmentSubjects.product_pair,
  assessmentSubjects.recommendation,
  assessmentSubjects.statement_transaction,
]);

/** Internal event authority is never a public entity, shortcode, or search target. */
const publicAssessmentTarget = z.object({
  entity: z.enum(shortcodeEntities),
  recordId: z.uuid(),
});
export const assessmentProjectionTargets = {
  field: publicAssessmentTarget,
  email_relevance: z.object({ entity: z.literal("email"), recordId: z.uuid() }),
  mail_import_outcome: z.object({
    entity: z.literal("email"),
    recordId: z.uuid(),
  }),
  email_link: z
    .discriminatedUnion("entity", [
      z.object({ entity: z.literal("email"), recordId: z.uuid() }),
      z.object({
        entity: z.literal("orderMailEvent"),
        recordId: z.uuid(),
        data: z.object({ eventId: z.uuid() }).passthrough(),
      }),
    ])
    .refine(
      (target) =>
        target.entity !== "orderMailEvent" ||
        target.recordId === target.data.eventId,
      "Internal Email link target must name its retained event",
    ),
  image_description: z.object({
    entity: z.literal("image"),
    recordId: z.uuid(),
  }),
  product_pair: z.object({ entity: z.literal("product"), recordId: z.uuid() }),
  recommendation: publicAssessmentTarget,
  /** StatementRow has no shortcode; the target names the canonical observation. */
  statement_transaction: z.object({
    entity: z.literal("statementRow"),
    recordId: z.uuid(),
  }),
};

/** Frozen result of the real writer; totals remain SUM(Expense.cost). */
export const mailImportOutcome = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("imported"),
    lines: z.array(
      z.object({ name: z.string().nullable(), cost: z.number().nullable() }),
    ),
    total: z.number().nullable(),
  }),
  z.object({
    kind: z.literal("linked"),
    event: z.string(),
    purchases: z.array(
      z.object({
        orderId: z.string().nullable(),
        vendor: z.string().nullable(),
      }),
    ),
  }),
  z.object({ kind: z.literal("unrelated"), reason: z.string().min(1) }),
  z.object({ kind: z.literal("unresolved"), reason: z.string().min(1) }),
]);
export const assessmentJudgments = {
  field: z.object({
    outcome: z.json().optional(),
    value: z.json(),
    confidence: z.number().optional(),
    runnerUpValue: z.json().optional(),
    runnerUpConfidence: z.number().nullable().optional(),
    kind: z.string().optional(),
    operation: z.enum(["set", "remove"]).optional(),
    removals: z.json().optional(),
  }),
  email_relevance: z.object({
    classification: z.enum(["related", "unrelated", "uncertain"]),
    stage: z.string().nullable(),
  }),
  mail_import_outcome: mailImportOutcome,
  email_link: z.object({ decision: z.enum(["linked", "dismissed"]) }),
  image_description: z.string().nullable(),
  product_pair: z.object({ actionable: z.boolean(), conflict: z.boolean() }),
  recommendation: z.object({ candidateKey: z.string() }),
  statement_transaction: statementTransactionJudgment,
};

export const assessmentProducer = z.object({
  kind: z.enum(["model", "rule", "agent"]),
  model: z.string().nullable(),
  revision: z.string().nullable(),
  runId: z.uuid().nullable(),
  evaluationId: z.uuid().nullable(),
});
export const assessmentPublication = z
  .object({
    publicationKey: z.string().min(1),
    family: assessmentFamily,
    subject: assessmentSubject,
    judgment: z.json(),
    fingerprint: z.string().nullable(),
    producer: assessmentProducer.nullable(),
    evidence: z.json().nullable(),
    origin: z
      .object({ table: z.string(), id: z.string(), metadata: z.json() })
      .nullable()
      .default(null),
    served: z.boolean().default(true),
  })
  .refine(
    ({ family, subject }) => family === subject.kind,
    "Assessment family must match subject",
  );
export const feedbackAuthority = z.enum([
  "member",
  "evaluation",
  "automatic",
  "unknown",
]);
export const feedbackEvent = z.object({
  assessmentId: assessmentChildHandle,
  operationId: z.string().min(1),
  verdict: feedbackVerdict,
  correction: assessmentCorrection.default({ present: false }),
  reason: z.string().nullable().default(null),
  evidence: z.json().nullable().default(null),
  intent: z.enum(["history", "draft", "apply"]).default("history"),
  authority: feedbackAuthority,
  actorUserId: z.string().nullable(),
  suppression: assessmentSuppression.nullable().default(null),
  receipt: z.json().nullable().default(null),
  metadata: z.json().nullable().default(null),
});
export const assessmentReviewInput = feedbackEvent
  .omit({
    assessmentId: true,
    authority: true,
    actorUserId: true,
    receipt: true,
    metadata: true,
  })
  .extend({
    operationId: z
      .string()
      .min(1)
      .regex(
        /^(?!(?:command-application|receipt|application|merge|email-accuracy|automatic):)(?!(?:decision|resolution|saved-application|saved-correction)$)/,
        "Operation ID uses a reserved internal receipt namespace",
      ),
    assessmentId: assessmentChildHandle.optional(),
    standalone: z
      .object({ kind: z.literal("image_description"), id: imageShortcode })
      .optional(),
    expectedFingerprint: z.string().nullable().optional(),
    application: z
      .discriminatedUnion("kind", [
        z.object({
          kind: z.literal("product_merge"),
          keepId: productShortcode,
          mergeId: productShortcode,
        }),
        z.object({
          kind: z.literal("saved_field"),
          recordId: anyShortcodeSchema(nonEmptyTuple(shortcodeEntities)),
        }),
        statementTransactionApplication,
      ])
      .optional(),
  });
export const assessmentReviewOut = z.object({
  assessmentId: assessmentChildHandle,
  feedbackId: assessmentChildHandle,
  status: z.string(),
  applied: z.boolean(),
  applicationResult: z
    .object({
      source: entityGraphRootSchema,
      destination: entityGraphRootSchema,
    })
    .optional(),
});
export const assessmentReviewBatchInput = z.object({
  items: z.array(assessmentReviewInput).min(1).max(100),
});
export const assessmentReviewBatchOut = z.array(
  z.union([
    assessmentReviewOut.extend({ ok: z.literal(true) }),
    z.object({
      assessmentId: assessmentChildHandle.nullable(),
      ok: z.literal(false),
      error: z.string(),
    }),
  ]),
);
export type AssessmentFamily = z.infer<typeof assessmentFamily>;
export type AssessmentSubject = z.infer<typeof assessmentSubject>;
export type AssessmentProducer = z.infer<typeof assessmentProducer>;
export type AssessmentCorrection = z.infer<typeof assessmentCorrection>;
export type AssessmentSuppression = z.infer<typeof assessmentSuppression>;
export type FeedbackEvent = z.infer<typeof feedbackEvent>;
export type AssessmentPublication = z.infer<typeof assessmentPublication>;

export type AssessmentReviewOut = z.infer<typeof assessmentReviewOut>;
export type AssessmentReviewBatchOut = z.infer<typeof assessmentReviewBatchOut>;
