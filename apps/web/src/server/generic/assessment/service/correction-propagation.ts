import { assessmentChildHandle } from "@cubby/schemas/assessment";
import {
  suggestionCorrectionOutcome,
  suggestionCorrectionPlan,
} from "@cubby/schemas/suggestion-correction";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { systemActor } from "~/server/domains/run/repo/ensure-run";
import { recordFeedback } from "~/server/generic/assessment/repo/assessment";
import { correctionRepairFamilies } from "~/server/generic/assessment/repo/correction-families";
import {
  correctionTargetIds,
  fieldCorrectionKey,
  readConfirmedCorrection,
  readCorrectionTarget,
  readFieldCorrectionSources,
} from "~/server/generic/assessment/repo/correction-sources";
import {
  correctionAlreadyRecorded,
  correctionOperationId,
  correctionWorkInput,
  enqueueCorrectionWork,
} from "~/server/generic/assessment/repo/correction-work";
import { isReviewFamily } from "~/server/generic/assessment/repo/review-families";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";

const cursorSchema = z.object({ after: assessmentChildHandle.nullable() });
const PAGE_SIZE = 25;

/** Provider-free exact-input propagation; all writes and receipts share the Job snapshot. */
export const correctionPropagationHandler = defineJobHandler(
  correctionWorkInput,
  async (db, claim, input) => {
    // Resolve roots after publication commits, closing the history-scan enrollment race.
    if (input.sourceFeedbackId === null) {
      const targetId = input.targetAssessmentId;
      if (!targetId)
        throw new Error("Publication correction work requires a target");
      return {
        isolationLevel: "serializable",
        page: { done: true },
        publish: async (tx) => {
          const target = await readCorrectionTarget(tx, targetId);
          const key = target && fieldCorrectionKey(target.evidence);
          const sources = key ? await readFieldCorrectionSources(tx, key) : [];
          for (const source of sources)
            if (source.assessmentId !== targetId)
              await enqueueCorrectionWork(tx, source.feedbackId, targetId);
          return { enrolled: sources.length };
        },
      };
    }
    const source = await readConfirmedCorrection(db, input.sourceFeedbackId);
    if (!source || !isReviewFamily(source.family))
      return {
        page: {
          done: true,
          result: {
            status: "held",
            reason: "No confirmed member correction authority",
          },
        },
      };
    const key = fieldCorrectionKey(source.evidence);
    const cursor =
      claim.cursor === null
        ? { after: null }
        : cursorSchema.parse(claim.cursor);
    const targets = input.targetAssessmentId
      ? [{ id: input.targetAssessmentId }]
      : key && source.family === "field"
        ? await correctionTargetIds(db, {
            sourceAssessmentId: source.assessmentId,
            correctionKey: key,
            after: cursor.after,
            limit: PAGE_SIZE,
          })
        : [{ id: source.assessmentId }];
    const prepared: {
      plan: z.infer<typeof suggestionCorrectionPlan>;
      repair: Awaited<ReturnType<typeof correctionRepairFamilies.field>>;
    }[] = [];
    for (const targetId of targets) {
      const target = await readCorrectionTarget(db, targetId.id);
      if (!target) continue;
      const plan = suggestionCorrectionPlan.parse({ source, target });
      prepared.push({
        plan,
        repair: await correctionRepairFamilies[source.family](db, plan),
      });
    }
    const after = targets.at(-1)?.id ?? cursor.after;
    return {
      isolationLevel: "serializable",
      page: {
        done:
          Boolean(input.targetAssessmentId) ||
          !key ||
          targets.length < PAGE_SIZE,
        cursor: { after },
      },
      publish: async (tx) => {
        const counts = { applied: 0, unchanged: 0, held: 0, replayed: 0 };
        for (const { plan, repair } of prepared) {
          // Successful replay wins before current-state checks: the mutation may already have changed it.
          if (
            await correctionAlreadyRecorded(
              tx,
              source.feedbackId,
              plan.target.assessmentId,
            )
          ) {
            counts.replayed++;
            continue;
          }
          const currentSource = await readConfirmedCorrection(
            tx,
            source.feedbackId,
          );
          const currentTarget = await readCorrectionTarget(
            tx,
            plan.target.assessmentId,
          );
          const result = suggestionCorrectionOutcome.parse(
            !isEqual(currentSource, plan.source) ||
              !isEqual(currentTarget, plan.target)
              ? {
                  status: "held",
                  reason:
                    "Correction authority or target changed after preparation",
                }
              : repair.status === "held"
                ? repair
                : await repair.apply(tx, systemActor()),
          );
          await recordFeedback(tx, {
            assessmentId: plan.target.assessmentId,
            operationId: correctionOperationId(
              source.feedbackId,
              plan.target.assessmentId,
            ),
            verdict: "ungraded",
            intent: "history",
            authority: "automatic",
            actorUserId: systemActor().userId,
            receipt: result,
            metadata: {
              kind: "assessment_correction",
              sourceFeedbackId: source.feedbackId,
              sourceApplicationFeedbackId: source.applicationFeedbackId,
              sourceActorUserId: source.actorUserId,
              correctedValue: source.correctedValue,
              originalApplicationFeedbackId: plan.target.applicationFeedbackId,
              expectedFingerprint: plan.target.fingerprint,
              ...(repair.status === "ready" && {
                domainPlan: repair.domainPlan,
              }),
            },
          });
          counts[result.status]++;
        }
        return counts;
      },
    };
  },
);
