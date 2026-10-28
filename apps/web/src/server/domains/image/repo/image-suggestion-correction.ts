import { assessmentSubjects } from "@cubby/schemas/assessment";
import { entityIdSchema } from "@cubby/schemas/identifiers";
import {
  imageDescriptionCorrectionOwner,
  imageDescriptionCorrectionReceipt,
} from "@cubby/schemas/image-processing";
import {
  suggestionCorrectionOutcome,
  type SuggestionCorrectionPlan,
} from "@cubby/schemas/suggestion-correction";
import { and, eq, inArray, sql } from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  assessment,
  assessmentState,
  feedback,
  image,
} from "~/server/db/schema";
import {
  lockImageCorrectionContent,
  lockImageCorrectionRecord,
} from "~/server/domains/image/repo/image-correction-lock";
import { resolveImageCorrection } from "~/server/domains/image/repo/image-correction-resolver";
import { writeImageDescriptionConfirmation } from "~/server/domains/image/repo/image-description-confirmation";
import type { CorrectionRepairAdapter } from "~/server/generic/assessment/correction-repair";
import { transitionAssessmentState } from "~/server/generic/assessment/repo/assessment-state";
import { correctionAlreadyRecorded } from "~/server/generic/assessment/repo/correction-receipt";
import { readImageCorrectionSources } from "~/server/generic/assessment/repo/correction-sources";

const imageEffectReceipt = imageDescriptionCorrectionReceipt;
const previousEffect = imageEffectReceipt.extend({
  applicationFeedbackId: z.uuid(),
});
const imageRepairPlan = z.object({
  contentHash: z.string().min(1),
  recordId: entityIdSchema("image"),
  description: z.string(),
  previous: previousEffect.nullable(),
  owner: imageDescriptionCorrectionOwner,
});
const held = (reason: string) => ({ status: "held" as const, reason });

async function inspectTarget(db: Database, input: SuggestionCorrectionPlan) {
  const subject = assessmentSubjects.image_description.safeParse(
    input.target.subject,
  );
  const source = assessmentSubjects.image_description.safeParse(
    input.source.subject,
  );
  if (
    !subject.success ||
    !source.success ||
    input.target.family !== "image_description" ||
    input.source.family !== "image_description" ||
    !subject.data.contentHash ||
    source.data.contentHash !== subject.data.contentHash
  )
    return held("Image correction requires identical retained content proof");
  const contentHash = subject.data.contentHash;
  const resolution = await resolveImageCorrection(db, contentHash);
  if (
    resolution.kind === "none" ||
    !resolution.sources.some(
      (candidate) => candidate.feedbackId === input.source.feedbackId,
    )
  )
    return held("The originating image correction is no longer current");
  if (resolution.kind === "conflict")
    return held("Identical image content has conflicting member corrections");
  const [target] = await getDb(db)
    .select({
      state: assessmentState,
      producer: assessment.producer,
      subject: assessment.subject,
      publishedFingerprint: assessment.fingerprint,
      hash: image.sha256,
    })
    .from(assessmentState)
    .innerJoin(assessment, eq(assessment.id, assessmentState.id))
    .innerJoin(image, eq(image.id, assessmentState.recordId))
    .where(
      and(eq(assessmentState.id, input.target.assessmentId), notDeleted(image)),
    )
    .limit(1);
  if (
    !target ||
    !target.state.active ||
    target.state.suppression ||
    target.state.family !== "image_description" ||
    target.state.entity !== "image" ||
    target.state.recordId !== subject.data.recordId ||
    target.hash !== contentHash ||
    target.publishedFingerprint !== contentHash ||
    target.state.fingerprint !== contentHash ||
    !isEqual(target.subject, input.target.subject)
  )
    return held("Image target evidence is stale or no longer actionable");
  const [member] = await getDb(db)
    .select({ id: feedback.id })
    .from(feedback)
    .innerJoin(assessment, eq(assessment.id, feedback.assessmentId))
    .where(
      and(
        eq(assessment.family, "image_description"),
        eq(feedback.authority, "member"),
        sql`${assessment.subject}->>'recordId' = ${subject.data.recordId}`,
      ),
    )
    .limit(1);
  if (member) return held("The target image has explicit member intent");
  const holders = await getDb(db)
    .select()
    .from(assessmentState)
    .where(
      and(
        eq(assessmentState.family, "image_description"),
        eq(assessmentState.recordId, subject.data.recordId),
        eq(assessmentState.active, true),
        sql`${assessmentState.confirmedValue}->>${"present"} = ${"true"}`,
      ),
    );
  if (holders.length > 1)
    return held("The image has ambiguous confirmation ownership");
  let previous: z.infer<typeof previousEffect> | null = null;
  const holder = holders[0];
  if (holder) {
    const ownership = z
      .object({ confirmationOwner: imageDescriptionCorrectionOwner })
      .safeParse(holder.data);
    if (
      !ownership.success ||
      holder.status !== "applied" ||
      holder.fingerprint !== contentHash ||
      !holder.confirmedValue?.present ||
      typeof holder.confirmedValue.value !== "string" ||
      ownership.data.confirmationOwner.targetAssessmentId !== holder.id
    )
      return held(
        "Existing image confirmation has no supported automatic effect proof",
      );
    const owner = ownership.data.confirmationOwner;
    const application = await correctionAlreadyRecorded(
      db,
      owner.sourceFeedbackId,
      owner.targetAssessmentId,
    );
    const receipt = imageEffectReceipt.safeParse(
      application?.receipt &&
        z.object({ receipt: z.json() }).safeParse(application.receipt).data
          ?.receipt,
    );
    if (
      !application ||
      !receipt.success ||
      !isEqual(receipt.data.owner, owner) ||
      receipt.data.recordId !== subject.data.recordId ||
      receipt.data.contentHash !== contentHash ||
      receipt.data.description !== holder.confirmedValue.value
    )
      return held(
        "The current image effect no longer matches its correction receipt",
      );
    previous = { ...receipt.data, applicationFeedbackId: application.id };
  }
  if (
    target.state.status !== "pending" &&
    !(
      target.state.status === "applied" &&
      holder?.id === target.state.id &&
      previous
    )
  )
    return held(
      "Resolved image history has no current supported automatic assignment",
    );
  if (target.state.status === "pending" && target.producer?.kind !== "model")
    return held(
      "Only retained model publications support automatic image text correction",
    );
  return {
    status: "eligible" as const,
    state: { ...target.state, recordId: subject.data.recordId },
    contentHash,
    description: resolution.description,
    previous,
  };
}

/** Text-only application; registration waits for selected-evidence provenance and enrollment. */
export const imageDescriptionCorrectionRepair: CorrectionRepairAdapter<
  typeof imageRepairPlan
> = {
  plan: imageRepairPlan,
  prepare: async (db, input) => {
    const target = await inspectTarget(db, input);
    if (target.status === "held") return target;
    return {
      status: "ready",
      plan: {
        contentHash: target.contentHash,
        recordId: target.state.recordId,
        description: target.description,
        previous: target.previous,
        owner: {
          kind: "correction",
          effectId: crypto.randomUUID(),
          sourceFeedbackId: input.source.feedbackId,
          sourceApplicationFeedbackId: input.source.applicationFeedbackId,
          sourceActorUserId: input.source.actorUserId,
          targetAssessmentId: input.target.assessmentId,
          originalApplicationFeedbackId:
            input.target.applicationFeedbackId ??
            target.previous?.owner.originalApplicationFeedbackId ??
            null,
          priorCorrectionApplicationFeedbackId:
            target.previous?.applicationFeedbackId ?? null,
        },
      },
    };
  },
  apply: async (db, input, plan) => {
    const replay = await correctionAlreadyRecorded(
      db,
      input.source.feedbackId,
      input.target.assessmentId,
    );
    if (replay) return suggestionCorrectionOutcome.parse(replay.receipt);
    await lockImageCorrectionContent(db, plan.contentHash);
    // Lock stale roots too: restoring their bytes can revive conflicting authority.
    const roots = await readImageCorrectionSources(db, plan.contentHash);
    const records = new Set([plan.recordId]);
    for (const root of roots)
      records.add(
        assessmentSubjects.image_description.parse(root.subject).recordId,
      );
    const ordered = [...records].sort();
    for (const id of ordered) await lockImageCorrectionRecord(db, id);
    await getDb(db)
      .select({ id: image.id })
      .from(image)
      .where(inArray(image.id, ordered))
      .orderBy(image.id)
      .for("update");
    await getDb(db)
      .select({ id: assessmentState.id })
      .from(assessmentState)
      .where(
        and(
          eq(assessmentState.family, "image_description"),
          eq(assessmentState.recordId, plan.recordId),
        ),
      )
      .orderBy(assessmentState.id)
      .for("update");
    const target = await inspectTarget(db, input);
    if (target.status === "held") return target;
    if (
      target.state.recordId !== plan.recordId ||
      target.contentHash !== plan.contentHash ||
      target.description !== plan.description ||
      plan.owner.sourceFeedbackId !== input.source.feedbackId ||
      plan.owner.sourceApplicationFeedbackId !==
        input.source.applicationFeedbackId ||
      plan.owner.sourceActorUserId !== input.source.actorUserId ||
      plan.owner.targetAssessmentId !== input.target.assessmentId
    )
      return held(
        "Image correction authority or effect changed after preparation",
      );
    if (target.previous?.description === plan.description) {
      // Another target on this page may already have installed the same proven effect.
      if (target.state.status === "pending")
        await transitionAssessmentState(
          db,
          target.state.id,
          { status: "superseded" },
          {
            kind: "image_correction_settled",
            feedbackId: input.source.feedbackId,
          },
        );
      return {
        status: "unchanged",
        receipt: imageEffectReceipt.parse(target.previous),
      };
    }
    if (
      !isEqual(target.previous, plan.previous) ||
      plan.owner.originalApplicationFeedbackId !==
        (input.target.applicationFeedbackId ??
          target.previous?.owner.originalApplicationFeedbackId ??
          null) ||
      plan.owner.priorCorrectionApplicationFeedbackId !==
        (target.previous?.applicationFeedbackId ?? null)
    )
      return held("Image correction effect changed after preparation");
    await writeImageDescriptionConfirmation(
      db,
      target.state,
      plan.description,
      plan.owner,
    );
    return {
      status: "applied",
      receipt: imageEffectReceipt.parse({
        kind: "image_description",
        recordId: plan.recordId,
        contentHash: plan.contentHash,
        description: plan.description,
        owner: plan.owner,
      }),
    };
  },
};
