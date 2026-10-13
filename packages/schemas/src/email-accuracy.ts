import { z } from "zod";

import { emailClassificationOperation } from "./email-observations.js";
import { emailShortcode } from "./identifier-fields.js";
import {
  mailboxClassification,
  mailboxClassificationStage,
} from "./mailbox-research.js";

const count = z.number().int().nonnegative();
const probability = z.number().positive().max(1);
const predictionStage = mailboxClassificationStage
  .exclude(["resolution"])
  .nullable();

export const emailAccuracyGradeValue = mailboxClassification.or(
  z.literal("unavailable"),
);
export type EmailAccuracyGradeValue = z.infer<typeof emailAccuracyGradeValue>;
export const emailAccuracyStratum = z
  .object({
    id: z.string().min(1),
    stage: predictionStage,
    classification: mailboxClassification,
    model: z.string().nullable(),
    populationCount: count.positive(),
    sampleCount: count.positive(),
    inclusionProbability: probability,
  })
  .strict();
export type EmailAccuracyStratum = z.infer<typeof emailAccuracyStratum>;
export const emailAccuracyRosterItem = z
  .object({
    predictionId: z.uuid(),
    emailId: z.uuid(),
    checksum: z.string().nullable(),
    stratumId: z.string().min(1),
    classification: mailboxClassification,
    stage: predictionStage,
    model: z.string().nullable(),
    classificationVersion: z.string().nullable(),
    promptVersion: z.string().nullable(),
    operation: emailClassificationOperation.nullable(),
    predictedAt: z.iso.datetime(),
  })
  .strict();
export type EmailAccuracyRosterItem = z.infer<typeof emailAccuracyRosterItem>;
export const emailAccuracyRoster = z
  .object({
    version: z.literal(1),
    // Old frozen rosters never measured member-wide coverage; keep it unknown.
    memberEmailCount: count.nullable().default(null),
    unpredictedEmailCount: count.nullable().default(null),
    strata: z.array(emailAccuracyStratum),
    items: z.array(emailAccuracyRosterItem),
  })
  .strict();
export type EmailAccuracyRoster = z.infer<typeof emailAccuracyRoster>;

export const createEmailAccuracyEvaluationInput = z
  .object({ sampleSize: z.number().int().min(1).max(1000).default(200) })
  .strict();
export const createEmailAccuracyEvaluationOut = z
  .object({
    evaluationId: z.uuid(),
    createdAt: z.iso.datetime(),
    memberEmailCount: count,
    unpredictedEmailCount: count,
    populationCount: count,
    sampleSize: count,
  })
  .strict();
export const listBlindEmailAccuracyItemsInput = z
  .object({
    evaluationId: z.uuid(),
    offset: count.default(0),
    limit: z.number().int().min(1).max(1000).default(200),
  })
  .strict();
export const emailAccuracyAvailability = z.enum([
  "owned",
  "missing",
  "ownership_changed",
]);
export const blindEmailAccuracyItem = z
  .object({
    predictionId: z.uuid(),
    emailId: emailShortcode.nullable(),
    mailboxId: z.string().nullable(),
    messageId: z.string().nullable(),
    headers: z
      .object({
        sender: z.string().nullable(),
        subject: z.string().nullable(),
        receivedAt: z.iso.datetime().nullable(),
        threadId: z.string().nullable(),
      })
      .strict()
      .nullable(),
    checksum: z.string().nullable(),
    currentChecksum: z.string().nullable(),
    availability: emailAccuracyAvailability,
    graded: z.boolean(),
  })
  .strict();
export const listBlindEmailAccuracyItemsOut = z
  .object({
    evaluationId: z.uuid(),
    totalCount: count,
    gradedCount: count,
    items: z.array(blindEmailAccuracyItem),
  })
  .strict();
const gradeBase = {
  evaluationId: z.uuid(),
  predictionId: z.uuid(),
  reason: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, "A review reason is required"),
};
export const gradeEmailAccuracyItemInput = z.discriminatedUnion("grade", [
  z
    .object({
      ...gradeBase,
      grade: mailboxClassification,
      reviewedChecksum: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...gradeBase,
      grade: z.literal("unavailable"),
      reviewedChecksum: z.null().default(null),
    })
    .strict(),
]);
export const gradeEmailAccuracyItemOut = z
  .object({
    predictionId: z.uuid(),
    grade: emailAccuracyGradeValue,
    reason: z.string(),
    reviewedChecksum: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export const getEmailAccuracyReportInput = z
  .object({ evaluationId: z.uuid() })
  .strict();
export const emailAccuracyBinaryMetrics = z
  .object({
    binaryPairCount: count,
    estimatedBinaryPopulation: z.number().nonnegative(),
    confusionMatrix: z
      .object({
        truePositive: z.number().nonnegative(),
        falsePositive: z.number().nonnegative(),
        falseNegative: z.number().nonnegative(),
        trueNegative: z.number().nonnegative(),
      })
      .strict(),
    precisionRelated: z.number().min(0).max(1).nullable(),
    recallRelated: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type EmailAccuracyBinaryMetrics = z.infer<
  typeof emailAccuracyBinaryMetrics
>;
export const emailAccuracyReport = z
  .object({
    evaluationId: z.uuid(),
    createdAt: z.iso.datetime(),
    memberEmailCount: count.nullable(),
    unpredictedEmailCount: count.nullable(),
    populationCount: count,
    sampleSize: count,
    pipeline: emailAccuracyBinaryMetrics,
    modelOnly: emailAccuracyBinaryMetrics,
    items: z.array(
      emailAccuracyRosterItem.pick({ predictionId: true }).extend({
        inclusionProbability: probability,
        weight: z.number().positive(),
      }),
    ),
    counts: z
      .object({
        graded: count,
        ungraded: count,
        unavailable: count,
        uncertainGrade: count,
        uncertainPrediction: count,
        unknownModel: count,
        unknownStage: count,
        knownOtherModel: count,
        missingEmail: count,
        ownershipChanged: count,
        historicalMetadataUnknown: count,
      })
      .strict(),
    strata: z.array(
      emailAccuracyStratum.extend({
        weight: z.number().positive(),
        gradedCount: count,
        binaryPairCount: count,
      }),
    ),
    byStage: z.array(
      z
        .object({
          stage: predictionStage,
          populationCount: count,
          sampleCount: count,
          gradedCount: count,
        })
        .strict(),
    ),
    byModel: z.array(
      z
        .object({
          model: z.string().nullable(),
          populationCount: count,
          sampleCount: count,
          gradedCount: count,
        })
        .strict(),
    ),
    warnings: z.array(z.string()),
  })
  .strict();
export type EmailAccuracyReport = z.infer<typeof emailAccuracyReport>;
