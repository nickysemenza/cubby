import type {
  FieldSuggestionOutcome,
  FieldSuggestionsInput,
} from "@cubby/schemas/ai";
import type { AiProvenance } from "@cubby/schemas/ai-evaluation";
import type { RunId } from "@cubby/schemas/identifiers";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { withTransactionDatabase } from "~/server/db/helpers";
import { assessmentState } from "~/server/db/schema";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { transitionAssessmentStates } from "~/server/generic/assessment/repo/assessment-state";
import {
  fieldInputFingerprint,
  fenceFieldInputsAtCommit,
} from "~/server/generic/assessment/repo/field-input-fence";

/** Publish a correction question, never a fabricated model prediction or member application. */
export async function publishFieldCorrectionQuestion(
  db: Database,
  input: {
    entity: FieldSuggestionsInput["entity"];
    recordId: string;
    field: string;
    currentValue: unknown;
    outcome: Extract<FieldSuggestionOutcome, { kind: "correction" }>;
    provenance: AiProvenance;
    runId: RunId | null;
  },
) {
  return withTransactionDatabase(db, async (tx) => {
    const fingerprint = await fieldInputFingerprint(
      tx,
      input.entity,
      input.recordId,
      input.field,
      { lock: true },
    );
    if (fingerprint !== input.outcome.targetInputFingerprint)
      throw new Error("Correction target changed during inference");
    const decision = input.outcome.decision;
    const value = decision.status === "confirmed" ? decision.value : null;
    const provenance = {
      dependencies: input.provenance.dependencies,
      inputFingerprint: fingerprint,
      optionFingerprint: decision.correctionKey,
      model: null,
    };
    const result = await publishAssessment(
      tx,
      {
        publicationKey: `field-correction-question:${input.entity}:${input.recordId}:${input.field}:${decision.revision}:${fingerprint}`,
        family: "field",
        subject: {
          kind: "field",
          entity: input.entity,
          recordId: input.recordId,
          field: input.field,
        },
        judgment: {
          kind: "confirmed_correction",
          value,
          outcome: {
            kind: "correction",
            decision,
            targetInputFingerprint: fingerprint,
          },
          decision,
        },
        fingerprint,
        producer: {
          kind: "rule",
          model: null,
          revision: "field-correction-authority-v1",
          runId: null,
          evaluationId: null,
        },
        evidence: {
          correctionKey: decision.correctionKey,
          decision,
          provenance,
        },
        served: true,
      },
      {
        entity: input.entity,
        recordId: input.recordId,
        field: input.field,
        currentValue: z.json().parse(input.currentValue),
        suggestedValue: value,
        kind: "addition",
        status: "pending",
        active: true,
        runId: input.runId,
        provenance,
        model: "unknown",
        data: {
          correctionKey: decision.correctionKey,
          correctionAuthority: decision,
          liveInputFingerprint: fingerprint,
        },
      },
    );
    // One current question owns the field. Preserve the old prediction and
    // receipts, while preventing its queued correction from competing with this one.
    await transitionAssessmentStates(
      tx,
      and(
        eq(assessmentState.family, "field"),
        eq(assessmentState.entity, input.entity),
        eq(assessmentState.recordId, input.recordId),
        eq(assessmentState.field, input.field),
        eq(assessmentState.active, true),
        eq(assessmentState.status, "pending"),
        ne(assessmentState.id, result.id),
      ),
      { active: false, status: "superseded" },
      { kind: "correction_question_published" },
    );
    await fenceFieldInputsAtCommit(
      tx,
      input.entity,
      input.recordId,
      input.field,
    );
    return result;
  });
}
