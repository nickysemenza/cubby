import { mailImportGapCategory } from "./email-fields";
import {
  suggestionChildHandle,
  suggestionSuppression,
} from "./suggestion-reference";
export {
  suggestionChildHandle,
  suggestionSuppression,
  suggestionReviewReference,
} from "./suggestion-reference";
import {
  productShortcode,
  entityIdSchema,
  anyShortcodeSchema,
  nonEmptyTuple,
} from "./identifiers";
import { shortcodeEntities } from "./generated/entity-roster.gen";
import {
  statementTransactionApplication,
  statementTransactionJudgment,
} from "./statement-suggestion";
import { z } from "zod";
import { entityGraphRootSchema } from "./entity-graph";
import { transferPairJudgment } from "./transfer-pair-suggestion";

/** Unknown historical values stay nullable; corrections explicitly distinguish absent from JSON null. */
export const suggestionCorrection = z.discriminatedUnion("present", [
  z.object({ present: z.literal(false) }),
  z.object({ present: z.literal(true), value: z.json() }),
]);
export const suggestionFamily = z.enum([
  "field",
  "email_relevance",
  "email_link",
  "mail_import_outcome",
  "product_pair",
  "recommendation",
  "statement_transaction",
  "transfer_pair",
]);
/** Families whose decisions live with their domain owners, never on a Suggestion. */
export const mailDecisionFamily = z.enum([
  "email_relevance",
  "email_link",
  "mail_import_outcome",
]);
export type MailDecisionFamily = z.infer<typeof mailDecisionFamily>;
export const feedbackVerdict = z.enum([
  "correct",
  "wrong",
  "uncertain",
  "dismissed",
  "ungraded",
]);
const record = { entity: z.string().min(1), recordId: z.uuid() };
export const suggestionSubjects = {
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
    runId: entityIdSchema("run"),
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
    entity: z.literal("sourceTransactionRecord"),
    recordId: z.uuid(),
    source: z.string().min(1),
    chargeKey: z.string().min(1),
  }),
  transfer_pair: z.object({
    kind: z.literal("transfer_pair"),
    entity: z.literal("financialAccount"),
    recordId: z.uuid(),
    pairKey: z.string().min(1),
  }),
};
export const suggestionSubject = z.discriminatedUnion("kind", [
  suggestionSubjects.field,
  suggestionSubjects.email_relevance,
  suggestionSubjects.email_link,
  suggestionSubjects.mail_import_outcome,
  suggestionSubjects.product_pair,
  suggestionSubjects.recommendation,
  suggestionSubjects.statement_transaction,
  suggestionSubjects.transfer_pair,
]);

/**
 * Families whose subject names two live records of one entity
 * (`recordId` < `otherId`): a pending one is a possible duplicate that list
 * rows flag and the record's Suggestions panel reviews.
 */
export const entityPairSuggestionFamilies = [
  "product_pair",
] as const satisfies readonly (keyof {
  [
    F in keyof typeof suggestionSubjects as z.infer<
      (typeof suggestionSubjects)[F]
    > extends { entity: string; recordId: string; otherId: string }
      ? F
      : never
  ]: true;
})[];
export type EntityPairSuggestionFamily =
  (typeof entityPairSuggestionFamilies)[number];
export const isEntityPairSuggestionFamily = (
  family: string | undefined,
): family is EntityPairSuggestionFamily =>
  entityPairSuggestionFamilies.some((pair) => pair === family);

/** Internal event authority is never a public entity, shortcode, or search target. */
const publicSuggestionTarget = z.object({
  entity: z.enum(shortcodeEntities),
  recordId: z.uuid(),
});
const emailSuggestionTarget = publicSuggestionTarget.extend({
  entity: z.literal("email"),
});

export const suggestionProjectionTargets = {
  field: publicSuggestionTarget,
  email_relevance: emailSuggestionTarget,
  mail_import_outcome: emailSuggestionTarget,
  email_link: z
    .discriminatedUnion("entity", [
      emailSuggestionTarget,
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
  product_pair: z.object({ entity: z.literal("product"), recordId: z.uuid() }),
  recommendation: publicSuggestionTarget,
  /** A Suggestion retains the canonical observation UUID behind its public code. */
  statement_transaction: z.object({
    entity: z.literal("sourceTransactionRecord"),
    recordId: z.uuid(),
  }),
  transfer_pair: z.object({
    entity: z.literal("financialAccount"),
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
  z.object({
    kind: z.literal("unresolved"),
    reason: z.string().min(1),
    // Existing stored outcomes predate categorized gaps; retain their meaning.
    category: mailImportGapCategory.default("unknown"),
  }),
]);
export const suggestionJudgments = {
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
  product_pair: z.object({ actionable: z.boolean(), conflict: z.boolean() }),
  recommendation: z.object({ candidateKey: z.string() }),
  statement_transaction: statementTransactionJudgment,
  transfer_pair: transferPairJudgment,
};

export const suggestionProducer = z.object({
  kind: z.enum(["model", "rule", "agent"]),
  model: z.string().nullable(),
  revision: z.string().nullable(),
  runId: entityIdSchema("run").nullable(),
  evaluationId: z.uuid().nullable(),
});
export const suggestionPublication = z
  .object({
    publicationKey: z.string().min(1),
    family: suggestionFamily,
    subject: suggestionSubject,
    judgment: z.json(),
    fingerprint: z.string().nullable(),
    producer: suggestionProducer.nullable(),
    evidence: z.json().nullable(),
  })
  .refine(
    ({ family, subject }) => family === subject.kind,
    "Suggestion family must match subject",
  );
/**
 * `system` records capture receipts only; it never grades or suppresses.
 * `evaluation` and `unknown` survive only on retained historical decisions.
 */
export const feedbackAuthority = z.enum([
  "member",
  "evaluation",
  "automatic",
  "unknown",
  "system",
]);
const reviewIntent = z.enum(["history", "draft", "apply"]);
export const feedbackEvent = z.object({
  suggestionId: suggestionChildHandle,
  operationId: z.string().min(1),
  verdict: feedbackVerdict,
  correction: suggestionCorrection.default({ present: false }),
  reason: z.string().nullable().default(null),
  evidence: z.json().nullable().default(null),
  intent: reviewIntent.default("history"),
  authority: feedbackAuthority,
  actorUserId: z.string().nullable(),
  suppression: suggestionSuppression.nullable().default(null),
  receipt: z.json().nullable().default(null),
  metadata: z.json().nullable().default(null),
});
/**
 * One retained decision on a Suggestion: a member's verdict, a system receipt
 * or an automatic application receipt. Corrected null stays distinct from no
 * correction, and an event is identified by its operation within its Suggestion.
 */
export const suggestionDecision = feedbackEvent
  .omit({ suggestionId: true })
  .extend({ id: z.guid(), createdAt: z.iso.datetime() });
export type SuggestionDecision = z.infer<typeof suggestionDecision>;

export const suggestionReviewInput = feedbackEvent
  .omit({
    suggestionId: true,
    authority: true,
    actorUserId: true,
    receipt: true,
    metadata: true,
  })
  .extend({
    operationId: z
      .string()
      .min(1)
      // A refine, not a lookahead `.regex`: Codex's MCP validator has no
      // lookaround, so a published lookahead pattern rejects every id.
      .refine(
        (id) =>
          !/^(?:command-application|receipt|application|merge|email-accuracy|automatic|projection|correction):/.test(
            id,
          ) &&
          !/^(?:decision|resolution|saved-application|saved-correction|legacy-projection|legacy-resolution)$/.test(
            id,
          ),
        "Operation ID uses a reserved internal receipt namespace",
      ),
    suggestionId: suggestionChildHandle,
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
        z.object({ kind: z.literal("transfer_pair") }),
      ])
      .optional(),
  });
export const suggestionReviewOut = z.object({
  suggestionId: suggestionChildHandle,
  feedbackId: suggestionChildHandle,
  status: z.string(),
  applied: z.boolean(),
  applicationResult: z
    .object({
      source: entityGraphRootSchema,
      destination: entityGraphRootSchema,
    })
    .optional(),
});
export const suggestionReviewBatchInput = z.object({
  items: z.array(suggestionReviewInput).min(1).max(100),
});
export const suggestionReviewBatchOut = z.array(
  z.union([
    suggestionReviewOut.extend({ ok: z.literal(true) }),
    z.object({
      suggestionId: suggestionChildHandle.nullable(),
      ok: z.literal(false),
      error: z.string(),
    }),
  ]),
);
export type SuggestionFamily = z.infer<typeof suggestionFamily>;
export type SuggestionSubject = z.infer<typeof suggestionSubject>;
export type SuggestionProducer = z.infer<typeof suggestionProducer>;
export type SuggestionCorrection = z.infer<typeof suggestionCorrection>;
export type SuggestionSuppression = z.infer<typeof suggestionSuppression>;
export type FeedbackEvent = z.infer<typeof feedbackEvent>;
export type SuggestionPublication = z.infer<typeof suggestionPublication>;

export type SuggestionReviewOut = z.infer<typeof suggestionReviewOut>;
export type SuggestionReviewBatchOut = z.infer<typeof suggestionReviewBatchOut>;
