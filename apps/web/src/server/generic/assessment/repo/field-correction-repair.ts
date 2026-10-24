import { fieldSuggestionsInput } from "@cubby/schemas/ai";
import { suggestionAcceptanceReceipt } from "@cubby/schemas/ai-evaluation";
import { assessmentSubjects } from "@cubby/schemas/assessment";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import { requiresSuggestionReview } from "@cubby/schemas/field-suggestion";
import type { SuggestionCorrectionSource } from "@cubby/schemas/suggestion-correction";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessmentState, feedback } from "~/server/db/schema";
import { systemActor } from "~/server/domains/run/repo/ensure-run";
import type { CorrectionRepairAdapter } from "~/server/generic/assessment/correction-repair";
import { transitionAssessmentState } from "~/server/generic/assessment/repo/assessment-state";
import {
  fieldCorrectionKey,
  readFieldCorrectionSources,
} from "~/server/generic/assessment/repo/correction-sources";
import { fieldInputFingerprint } from "~/server/generic/assessment/repo/field-input-fence";
import {
  confirmedFieldFillRefusal,
  writePropagatedFieldCorrection,
} from "~/server/generic/assessment/repo/suggestion-review";
import { latestFieldWrite } from "~/server/generic/audit-log/repo/field-write";
import { canonicalJson } from "~/server/lib/canonical-json";

const fieldRepairPlan = z.object({ inputFingerprint: z.string() });

/** A later member write, including an unchanged save or ABA edit, retires this authority. */
export async function isCurrentFieldCorrection(
  db: Database,
  source: SuggestionCorrectionSource,
) {
  const subject = assessmentSubjects.field.safeParse(source.subject);
  if (!subject.success) return false;
  const [state] = await getDb(db)
    .select()
    .from(assessmentState)
    .where(eq(assessmentState.id, source.assessmentId))
    .limit(1);
  if (!state) return false;
  const bound = suggestionAcceptanceReceipt.safeParse(
    source.applicationReceipt,
  );
  const captured = suggestionAcceptanceReceipt.safeParse(
    source.fieldApplicationReceipt,
  );
  const receipt = captured.success ? captured : bound;
  if (!receipt.success || receipt.data.mode !== "member") return false;
  const latest = await latestFieldWrite(
    db,
    state.entity,
    state.recordId,
    state.field,
  );
  const currentFingerprint = await fieldInputFingerprint(
    db,
    state.entity,
    state.recordId,
    state.field,
  );
  if (receipt.data.appliedInputFingerprint !== currentFingerprint) return false;
  if (latest) return receipt.data.auditIds.includes(latest.id);
  return (
    receipt.data.auditIds.length === 0 &&
    receipt.data.appliedInputFingerprint === currentFingerprint
  );
}

export const fieldCorrectionRepair: CorrectionRepairAdapter<
  typeof fieldRepairPlan
> = {
  plan: fieldRepairPlan,
  prepare: async (db, input) => {
    const source = assessmentSubjects.field.safeParse(input.source.subject);
    const target = assessmentSubjects.field.safeParse(input.target.subject);
    if (!source.success || !target.success || !target.data.recordId)
      return {
        status: "held",
        reason: "Correction requires a saved field target",
      };
    const entity = fieldSuggestionsInput.shape.entity.parse(target.data.entity);
    const policy = entityFieldByKey(entity, target.data.field)?.control
      ?.suggest;
    // Financial fields have reviewed graph effects and belong to their domain adapter.
    if (
      policy?.mode !== "fill" ||
      requiresSuggestionReview(entity, target.data.field) ||
      ["expense", "purchase", "financialTransaction", "vendor"].includes(entity)
    )
      return {
        status: "held",
        reason: "This field requires its domain correction policy",
      };
    const key = fieldCorrectionKey(input.source.evidence);
    if (
      !key ||
      key !== fieldCorrectionKey(input.target.evidence) ||
      source.data.entity !== target.data.entity ||
      source.data.field !== target.data.field
    )
      return {
        status: "held",
        reason: "Complete decision inputs are not equivalent",
      };
    const sources = await readFieldCorrectionSources(db, key);
    const current: SuggestionCorrectionSource[] = [];
    for (const candidate of sources)
      if (await isCurrentFieldCorrection(db, candidate))
        current.push(candidate);
    if (
      !current.some(
        (candidate) => candidate.feedbackId === input.source.feedbackId,
      )
    )
      return {
        status: "held",
        reason: "The originating member correction is no longer current",
      };
    if (
      current.some(
        (candidate) =>
          canonicalJson(candidate.correctedValue) !==
          canonicalJson(input.source.correctedValue),
      )
    )
      return {
        status: "held",
        reason: "Equivalent evidence has conflicting member corrections",
      };
    const [state] = await getDb(db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, input.target.assessmentId))
      .limit(1);
    if (
      !state ||
      state.suppression ||
      (!state.active && state.status !== "applied")
    )
      return { status: "held", reason: "The target is no longer actionable" };
    const [member] = await getDb(db)
      .select({ id: feedback.id })
      .from(feedback)
      .innerJoin(assessmentState, eq(assessmentState.id, feedback.assessmentId))
      .where(
        and(
          eq(assessmentState.entity, state.entity),
          eq(assessmentState.recordId, state.recordId),
          eq(assessmentState.field, state.field),
          eq(feedback.authority, "member"),
        ),
      )
      .limit(1);
    if (member)
      return {
        status: "held",
        reason: "The target has an explicit member decision",
      };
    const latest = await latestFieldWrite(
      db,
      entity,
      state.recordId,
      state.field,
    );
    const fingerprint = await fieldInputFingerprint(
      db,
      entity,
      state.recordId,
      state.field,
    );
    if (state.status === "applied") {
      const receipt = suggestionAcceptanceReceipt.safeParse(
        state.acceptanceReceipt,
      );
      if (
        !input.target.applicationFeedbackId ||
        !receipt.success ||
        receipt.data.mode !== "automatic" ||
        !latest ||
        !receipt.data.auditIds.includes(latest.id) ||
        receipt.data.appliedInputFingerprint !== fingerprint
      )
        return {
          status: "held",
          reason: "The original automatic assignment or its inputs changed",
        };
    } else {
      const { buildCrudServices } =
        await import("~/server/http/request-context");
      const refusal = await confirmedFieldFillRefusal(
        db,
        {
          ...buildCrudServices(db),
          db,
          actorContext: systemActor(),
        },
        state,
      );
      if (refusal) return { status: "held", reason: refusal };
      const basis = z
        .object({ liveInputFingerprint: z.string() })
        .safeParse(state.data);
      if (
        latest ||
        !(state.currentValue == null || state.currentValue === "") ||
        !basis.success ||
        basis.data.liveInputFingerprint !== fingerprint
      )
        return {
          status: "held",
          reason: "The empty field or its original evidence changed",
        };
    }
    return { status: "ready", plan: { inputFingerprint: fingerprint } };
  },
  apply: async (db, input, plan, actor) => {
    const prepared = await fieldCorrectionRepair.prepare(db, input);
    if (prepared.status === "held") return prepared;
    if (prepared.plan.inputFingerprint !== plan.inputFingerprint)
      return {
        status: "held",
        reason: "Field evidence changed after correction preparation",
      };
    const [state] = await getDb(db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, input.target.assessmentId))
      .for("update")
      .limit(1);
    if (!state)
      return { status: "held", reason: "Field target no longer exists" };
    const value =
      state.status === "applied" ? state.suggestedValue : state.currentValue;
    if (
      state.status !== "pending" &&
      canonicalJson(z.json().parse(value)) ===
        canonicalJson(input.source.correctedValue)
    )
      return {
        status: "unchanged",
        receipt: { inputFingerprint: plan.inputFingerprint },
      };
    if (actor.userId !== systemActor().userId)
      throw new Error("Correction propagation requires the system actor");
    const { buildCrudServices } = await import("~/server/http/request-context");
    const result = await writePropagatedFieldCorrection(
      db,
      {
        ...buildCrudServices(db),
        db,
        actorContext: actor,
      },
      {
        ...state,
        entity: fieldSuggestionsInput.shape.entity.parse(state.entity),
      },
      input.source.correctedValue,
    );
    if (state.status === "pending")
      await transitionAssessmentState(
        db,
        state.id,
        { status: "superseded", active: false },
        { kind: "correction_propagated", feedbackId: input.source.feedbackId },
      );
    return {
      status: "applied",
      receipt: {
        ...result,
        inputFingerprint: plan.inputFingerprint,
        sourceFeedbackId: input.source.feedbackId,
        originalApplicationFeedbackId: input.target.applicationFeedbackId,
      },
    };
  },
};
