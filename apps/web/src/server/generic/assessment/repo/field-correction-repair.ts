import { fieldSuggestionsInput, suggestionStatus } from "@cubby/schemas/ai";
import { suggestionAcceptanceReceipt } from "@cubby/schemas/ai-evaluation";
import { assessmentSubjects } from "@cubby/schemas/assessment";
import {
  CORRECTION_OUTCOME_RECEIPT_KIND,
  type SuggestionCorrectionOutcome,
} from "@cubby/schemas/suggestion-correction";
import { and, eq, sql, asc, inArray } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { assessmentState, feedback } from "~/server/db/schema";
import { systemActor } from "~/server/domains/run/repo/ensure-run";
import type { CorrectionRepairAdapter } from "~/server/generic/assessment/correction-repair";
import { transitionAssessmentState } from "~/server/generic/assessment/repo/assessment-state";
import {
  equivalentFieldCorrections,
  readFieldCorrectionIdentity,
  readConfirmedCorrection,
} from "~/server/generic/assessment/repo/correction-sources";
import { correctionAlreadyRecorded } from "~/server/generic/assessment/repo/correction-work";
import { fieldCorrectionIdentityKeys } from "~/server/generic/assessment/repo/field-assessment-review";
import { lockFieldCorrectionIdentities } from "~/server/generic/assessment/repo/field-correction-lock";
import {
  resolveFieldCorrection,
  supportsFieldCorrection,
} from "~/server/generic/assessment/repo/field-correction-resolver";
import {
  fieldInputFingerprint,
  fieldInputFingerprintIfLive,
} from "~/server/generic/assessment/repo/field-input-fence";
import {
  confirmedFieldFillRefusal,
  writePropagatedFieldCorrection,
} from "~/server/generic/assessment/repo/suggestion-review";
import { latestFieldWrite } from "~/server/generic/audit-log/repo/field-write";
import { canonicalJson } from "~/server/lib/canonical-json";

const fieldRepairPlan = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("write"),
    inputFingerprint: z.string(),
    priorCorrectionApplicationFeedbackId: z.uuid().nullable(),
  }),
  z.object({
    kind: z.literal("settle"),
    inputFingerprint: z.string(),
    applicationFeedbackId: z.uuid(),
  }),
]);

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
    // Financial fields have reviewed graph effects and belong to their domain adapter.
    if (!supportsFieldCorrection(entity, target.data.field))
      return {
        status: "held",
        reason: "This field requires its domain correction policy",
      };
    const identity = await readFieldCorrectionIdentity(
      db,
      input.source.subject,
      input.source.evidence,
    );
    const key = identity.canonicalKey ?? identity.storedKey;
    if (
      !key ||
      !(await equivalentFieldCorrections(db, input.source, input.target)) ||
      source.data.entity !== target.data.entity ||
      source.data.field !== target.data.field
    )
      return {
        status: "held",
        reason: "Complete decision inputs are not equivalent",
      };
    const resolution = await resolveFieldCorrection(
      db,
      fieldCorrectionIdentityKeys(identity),
      source.data,
    );
    if (
      !resolution.sources.some(
        (candidate) => candidate.feedbackId === input.source.feedbackId,
      )
    )
      return {
        status: "held",
        reason: "The originating member correction is no longer current",
      };
    if (resolution.kind === "conflict")
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
      state.recordId !== target.data.recordId ||
      state.entity !== target.data.entity ||
      state.field !== target.data.field
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
    const fingerprint = await fieldInputFingerprintIfLive(
      db,
      entity,
      state.recordId,
      state.field,
    );
    if (fingerprint === null)
      return { status: "held", reason: "Field target no longer exists" };
    let priorCorrectionApplicationFeedbackId: string | null = null;
    const previous = await getDb(db)
      .select({
        assessmentId: feedback.assessmentId,
        metadata: feedback.metadata,
      })
      .from(feedback)
      .innerJoin(assessmentState, eq(assessmentState.id, feedback.assessmentId))
      .where(
        and(
          eq(assessmentState.entity, state.entity),
          eq(assessmentState.recordId, state.recordId),
          eq(assessmentState.field, state.field),
          sql`${feedback.metadata}->>${"kind"} = ${CORRECTION_OUTCOME_RECEIPT_KIND}`,
          sql`${feedback.receipt}->>'status' = ${suggestionStatus.enum.applied}`,
        ),
      )
      .orderBy(asc(feedback.id));
    for (const candidate of previous) {
      const lineage = z
        .object({ sourceFeedbackId: z.string() })
        .parse(candidate.metadata);
      const previousSource = await readConfirmedCorrection(
        db,
        lineage.sourceFeedbackId,
      );
      if (
        !previousSource ||
        !(await equivalentFieldCorrections(db, previousSource, input.source))
      )
        continue;
      const recorded = await correctionAlreadyRecorded(
        db,
        lineage.sourceFeedbackId,
        candidate.assessmentId,
      );
      const proof = z
        .object({ receipt: z.object({ appliedInputFingerprint: z.string() }) })
        .safeParse(recorded?.receipt);
      if (
        recorded &&
        proof.success &&
        proof.data.receipt.appliedInputFingerprint === fingerprint
      ) {
        if (
          canonicalJson(previousSource.correctedValue) ===
          canonicalJson(input.source.correctedValue)
        )
          return {
            status: "ready",
            plan: {
              kind: "settle",
              inputFingerprint: fingerprint,
              applicationFeedbackId: recorded.id,
            },
          };
        priorCorrectionApplicationFeedbackId = recorded.id;
        break;
      }
    }
    if (
      !state.active &&
      state.status !== "applied" &&
      !priorCorrectionApplicationFeedbackId
    )
      return { status: "held", reason: "The target is no longer actionable" };
    // Verified untouched automatic consequences can be corrected again;
    // otherwise require the original automatic application or an empty field.
    if (!priorCorrectionApplicationFeedbackId && state.status === "applied") {
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
    } else if (!priorCorrectionApplicationFeedbackId) {
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
    return {
      status: "ready",
      plan: {
        kind: "write",
        inputFingerprint: fingerprint,
        priorCorrectionApplicationFeedbackId,
      },
    };
  },
  apply: async (
    db,
    input,
    plan,
    actor,
  ): Promise<SuggestionCorrectionOutcome> => {
    const identity = await readFieldCorrectionIdentity(
      db,
      input.source.subject,
      input.source.evidence,
    );
    const key = identity.canonicalKey ?? identity.storedKey;
    if (!key)
      return {
        status: "held",
        reason: "Complete correction inputs are unavailable",
      };
    const targetIdentity = await readFieldCorrectionIdentity(
      db,
      input.target.subject,
      input.target.evidence,
    );
    await lockFieldCorrectionIdentities(
      db,
      assessmentSubjects.field.parse(input.source.subject),
      [
        ...fieldCorrectionIdentityKeys(identity),
        ...fieldCorrectionIdentityKeys(targetIdentity),
      ],
    );
    // Serialize source supersession and target writes using one canonical order.
    // A source decision cannot commit between this validation and its consequence.
    const subjects = await getDb(db)
      .select({
        entity: assessmentState.entity,
        recordId: assessmentState.recordId,
        field: assessmentState.field,
      })
      .from(assessmentState)
      .where(
        inArray(assessmentState.id, [
          input.source.assessmentId,
          input.target.assessmentId,
        ]),
      );
    const records = new Map(
      subjects.map((subject) => [
        `${subject.entity}:${subject.recordId}`,
        subject,
      ]),
    );
    for (const [, subject] of [...records].sort(([left], [right]) =>
      left.localeCompare(right),
    ))
      await fieldInputFingerprintIfLive(
        db,
        subject.entity,
        subject.recordId,
        subject.field,
        { lock: true },
      );
    const prepared = await fieldCorrectionRepair.prepare(db, input);
    if (prepared.status === "held") return prepared;
    if (canonicalJson(prepared.plan) !== canonicalJson(plan))
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
    if (actor.userId !== systemActor().userId)
      throw new Error("Correction propagation requires the system actor");
    if (plan.kind === "settle") {
      if (state.status === "pending")
        await transitionAssessmentState(
          db,
          state.id,
          { status: "superseded", active: false },
          {
            kind: "correction_already_applied",
            feedbackId: input.source.feedbackId,
          },
        );
      return {
        status: "unchanged",
        receipt: {
          inputFingerprint: plan.inputFingerprint,
          applicationFeedbackId: plan.applicationFeedbackId,
        },
      };
    }
    // The original projection is immutable decision history, not the current
    // field value after a propagated correction. Only receipt proof can settle it.
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
        appliedInputFingerprint: await fieldInputFingerprint(
          db,
          state.entity,
          state.recordId,
          state.field,
        ),
        sourceFeedbackId: input.source.feedbackId,
        originalApplicationFeedbackId: input.target.applicationFeedbackId,
        priorCorrectionApplicationFeedbackId:
          plan.priorCorrectionApplicationFeedbackId,
      },
    };
  },
};
