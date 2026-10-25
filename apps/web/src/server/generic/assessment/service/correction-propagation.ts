import { assessmentChildHandle } from "@cubby/schemas/assessment";
import {
  suggestionCorrectionOutcome,
  suggestionCorrectionPlan,
} from "@cubby/schemas/suggestion-correction";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { systemActor } from "~/server/domains/run/repo/ensure-run";
import { recordFeedback } from "~/server/generic/assessment/repo/assessment";
import {
  correctionSourcesForTarget,
  correctionTargetsForSource,
} from "~/server/generic/assessment/repo/correction-discovery";
import { correctionRepairFamilies } from "~/server/generic/assessment/repo/correction-families";
import {
  correctionAlreadyRecorded,
  correctionOperationId,
} from "~/server/generic/assessment/repo/correction-receipt";
import {
  readConfirmedCorrection,
  readCorrectionTarget,
} from "~/server/generic/assessment/repo/correction-sources";
import {
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
      // Batches carry targetAssessmentIds; Jobs queued before batching carry one id.
      const targetIds = input.targetAssessmentIds.length
        ? input.targetAssessmentIds
        : input.targetAssessmentId
          ? [input.targetAssessmentId]
          : [];
      if (!targetIds.length)
        throw new Error("Publication correction work requires a target");
      return {
        isolationLevel: "serializable",
        page: { done: true },
        publish: async (tx) => {
          let enrolled = 0;
          for (const targetId of targetIds) {
            const target = await readCorrectionTarget(tx, targetId);
            const sources = target
              ? await correctionSourcesForTarget(tx, target)
              : [];
            for (const source of sources)
              if (source.assessmentId !== targetId)
                await enqueueCorrectionWork(tx, source.feedbackId, targetId);
            enrolled += sources.length;
          }
          return { enrolled };
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
    const cursor =
      claim.cursor === null
        ? { after: null }
        : cursorSchema.parse(claim.cursor);
    const page = input.targetAssessmentId
      ? {
          targets: [{ id: input.targetAssessmentId }],
          after: cursor.after,
          done: true,
        }
      : await correctionTargetsForSource(db, source, {
          after: cursor.after,
          limit: PAGE_SIZE,
        });
    const targets = page.targets;
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
    const after = page.after;
    return {
      isolationLevel: "serializable",
      page: {
        done: page.done,
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
