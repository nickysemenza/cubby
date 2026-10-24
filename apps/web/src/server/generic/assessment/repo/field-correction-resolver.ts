import type { FieldSuggestionsInput } from "@cubby/schemas/ai";
import { suggestionAcceptanceReceipt } from "@cubby/schemas/ai-evaluation";
import { assessmentSubjects } from "@cubby/schemas/assessment";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import { requiresSuggestionReview } from "@cubby/schemas/field-suggestion";
import type { SuggestionCorrectionSource } from "@cubby/schemas/suggestion-correction";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessmentState } from "~/server/db/schema";
import { readFieldCorrectionSources } from "~/server/generic/assessment/repo/correction-sources";
import { fieldInputFingerprintIfLive } from "~/server/generic/assessment/repo/field-input-fence";
import { latestFieldWrite } from "~/server/generic/audit-log/repo/field-write";
import { canonicalJson } from "~/server/lib/canonical-json";

export function supportsFieldCorrection(
  entity: FieldSuggestionsInput["entity"],
  field: string,
) {
  return (
    entityFieldByKey(entity, field)?.control?.suggest?.mode === "fill" &&
    !requiresSuggestionReview(entity, field) &&
    !["expense", "purchase", "financialTransaction", "vendor"].includes(entity)
  );
}

/** A later member write, including an unchanged save or ABA edit, retires this authority. */
async function isCurrentFieldCorrection(
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
  if (
    !state ||
    !subject.data.recordId ||
    subject.data.recordId !== state.recordId ||
    subject.data.entity !== state.entity ||
    subject.data.field !== state.field
  )
    return false;
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
  const currentFingerprint = await fieldInputFingerprintIfLive(
    db,
    state.entity,
    state.recordId,
    state.field,
  );
  if (
    currentFingerprint === null ||
    receipt.data.appliedInputFingerprint !== currentFingerprint
  )
    return false;
  if (latest) return receipt.data.auditIds.includes(latest.id);
  return (
    receipt.data.auditIds.length === 0 &&
    receipt.data.appliedInputFingerprint === currentFingerprint
  );
}

/** One authority resolver for historical repair, automatic admission and future question reuse. */
export async function resolveFieldCorrection(db: Database, key: string) {
  const current: SuggestionCorrectionSource[] = [];
  for (const source of await readFieldCorrectionSources(db, key))
    if (await isCurrentFieldCorrection(db, source)) current.push(source);
  const revision = await sha256Hex(
    canonicalJson({
      version: "field-correction-authority-v1",
      key,
      sources: current.map((source) => ({
        feedbackId: source.feedbackId,
        applicationFeedbackId: source.applicationFeedbackId,
        fieldApplicationReceipt: source.fieldApplicationReceipt,
        correctedValue: source.correctedValue,
      })),
    }),
  );
  const [source] = current;
  if (!source) return { kind: "none", revision, sources: current } as const;
  if (
    current.some(
      (candidate) =>
        canonicalJson(candidate.correctedValue) !==
        canonicalJson(source.correctedValue),
    )
  )
    return { kind: "conflict", revision, sources: current } as const;
  return { kind: "confirmed", revision, sources: current, source } as const;
}
