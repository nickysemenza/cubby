/** Frozen Email accuracy rosters, retained as `evaluation_sample` Assessments. */
import { z } from "zod";

import { emailClassificationOperation } from "./email-observations.js";
import {
  mailboxClassification,
  mailboxClassificationStage,
} from "./mailbox-research.js";

const count = z.number().int().nonnegative();
const probability = z.number().positive().max(1);
const predictionStage = mailboxClassificationStage
  .exclude(["resolution"])
  .nullable();

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
