import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentChildHandle,
  assessmentSubjects,
} from "@cubby/schemas/assessment";
import {
  suggestionCorrectionSource,
  suggestionCorrectionTarget,
  correctionAuthorityReceiptKinds,
} from "@cubby/schemas/suggestion-correction";
import { CORRECTION_OUTCOME_RECEIPT_KIND } from "@cubby/schemas/suggestion-correction";
import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessment, assessmentState, feedback } from "~/server/db/schema";
import { assertApplicationReceipt } from "~/server/generic/assessment/repo/assessment";

import {
  proveFieldCorrectionIdentity,
  fieldCorrectionIdentityKeys,
} from "./field-assessment-review";

export async function readFieldCorrectionIdentity(
  db: Database,
  subject: unknown,
  evidence: unknown,
  loadManifest = () => producingAiManifest(db),
) {
  const retainedEvidence = z.json().parse(evidence);
  const field = z
    .object({ entity: z.string(), field: z.string() })
    .safeParse(subject);
  if (!field.success)
    return {
      storedKey: fieldCorrectionKey(retainedEvidence),
      canonicalKey: null,
      reason: "missing_inputs",
    };
  return proveFieldCorrectionIdentity({
    ...field.data,
    evidence: retainedEvidence,
    loadManifest,
  });
}

/** One lazy manifest read for related identity facts in a candidate page. */
export function fieldCorrectionIdentityReader(db: Database) {
  let manifest: ReturnType<typeof producingAiManifest> | undefined;
  const loadManifest = () => (manifest ??= producingAiManifest(db));
  return (subject: unknown, evidence: unknown) =>
    readFieldCorrectionIdentity(
      db,
      subject,
      z.json().parse(evidence),
      loadManifest,
    );
}

export async function equivalentFieldCorrections(
  db: Database,
  source: Pick<
    z.infer<typeof suggestionCorrectionSource>,
    "subject" | "evidence"
  >,
  target: Pick<
    z.infer<typeof suggestionCorrectionSource>,
    "subject" | "evidence"
  >,
) {
  const readIdentity = fieldCorrectionIdentityReader(db);
  const left = await readIdentity(source.subject, source.evidence);
  const right = await readIdentity(target.subject, target.evidence);
  const scope = assessmentSubjects.field.safeParse(source.subject);
  const targetScope = assessmentSubjects.field.safeParse(target.subject);
  if (
    !scope.success ||
    !targetScope.success ||
    scope.data.entity !== targetScope.data.entity ||
    scope.data.field !== targetScope.data.field
  )
    return false;
  const expanded = await resolveFieldCorrectionIdentities(
    db,
    fieldCorrectionIdentityKeys(left),
    scope.data,
  );
  const keys = new Set(expanded.keys);
  return fieldCorrectionIdentityKeys(right).some((key) => keys.has(key));
}

const application = alias(feedback, "correction_application");
const receiptMetadata = z.object({
  kind: correctionAuthorityReceiptKinds,
  commandFeedbackId: assessmentChildHandle,
});
export const fieldCorrectionKey = (evidence: unknown) =>
  z.object({ correctionKey: z.string().min(1).nullable() }).safeParse(evidence)
    .data?.correctionKey ?? null;

/** A failed apply leaves review Feedback behind; only its bound receipt grants authority. */
async function confirmedSources(db: Database, where: SQL | undefined) {
  const rows = await getDb(db)
    .select({ command: feedback, application, prediction: assessment })
    .from(feedback)
    .innerJoin(assessment, eq(assessment.id, feedback.assessmentId))
    .innerJoin(
      application,
      and(
        eq(application.assessmentId, feedback.assessmentId),
        sql`${application.metadata}->>'commandFeedbackId' = ${feedback.id}::text`,
        inArray(
          sql<string>`${application.metadata}->>${"kind"}`,
          correctionAuthorityReceiptKinds.options,
        ),
      ),
    )
    .where(
      and(
        eq(feedback.authority, "member"),
        eq(feedback.intent, "apply"),
        eq(assessment.served, true),
        sql`${feedback.correction}->>${"present"} = ${"true"}`,
        where,
      ),
    )
    .orderBy(asc(feedback.id));
  const confirmed = new Map<
    string,
    z.infer<typeof suggestionCorrectionSource>
  >();
  for (const { command, application: receipt, prediction } of rows) {
    const metadata = receiptMetadata.parse(receipt.metadata);
    assertApplicationReceipt(receipt, command, metadata.kind);
    if (!command.correction.present || !command.actorUserId)
      throw new Error(
        "A confirmed correction requires its member and corrected value",
      );
    const source = suggestionCorrectionSource.parse({
      feedbackId: command.id,
      applicationFeedbackId: receipt.id,
      assessmentId: prediction.id,
      family: prediction.family,
      subject: prediction.subject,
      judgment: prediction.judgment,
      evidence: prediction.evidence,
      correctedValue: command.correction.value,
      actorUserId: command.actorUserId,
      applicationReceipt: receipt.receipt,
      fieldApplicationReceipt: z
        .object({
          fieldApplicationReceipt:
            suggestionCorrectionSource.shape.fieldApplicationReceipt,
        })
        .parse(receipt.metadata).fieldApplicationReceipt,
    });
    // Saved-field application also has a generic command receipt. Its typed
    // field receipt is the single canonical authority, not a second root.
    const previous = confirmed.get(command.id);
    const canonical =
      !previous || metadata.kind === "saved_field" ? source : previous;
    confirmed.set(command.id, {
      ...canonical,
      fieldApplicationReceipt:
        source.fieldApplicationReceipt ??
        previous?.fieldApplicationReceipt ??
        null,
    });
  }
  return [...confirmed.values()];
}

export async function readConfirmedCorrection(
  db: Database,
  feedbackId: string,
) {
  const [source] = await confirmedSources(db, eq(feedback.id, feedbackId));
  return source ?? null;
}

/** Identical image bytes bound candidate authority; live confirmation is checked by the image domain. */
export async function readImageCorrectionSources(
  db: Database,
  contentHash: string,
) {
  return confirmedSources(
    db,
    and(
      eq(assessment.family, "image_description"),
      sql`${assessment.subject}->>${assessmentSubjects.image_description.keyof().enum.contentHash} = ${contentHash}`,
      eq(assessment.fingerprint, contentHash),
    ),
  );
}

/** Scope discovery to the field; only hash-proven identities gain normalized aliases. */
export async function resolveFieldCorrectionIdentities(
  db: Database,
  key: string | readonly string[],
  scope?: { entity: string; field: string },
) {
  const keys = new Set(typeof key === "string" ? [key] : key);
  const candidatesWithIdentity = [];
  let after: string | null = null;
  for (;;) {
    const candidates = await getDb(db)
      .select({ id: feedback.id })
      .from(feedback)
      .innerJoin(assessment, eq(assessment.id, feedback.assessmentId))
      .where(
        and(
          eq(assessment.family, "field"),
          eq(feedback.authority, "member"),
          eq(feedback.intent, "apply"),
          sql`${feedback.correction}->>${"present"} = ${"true"}`,
          scope
            ? and(
                sql`${assessment.subject}->>'entity' = ${scope.entity}`,
                sql`${assessment.subject}->>${assessmentSubjects.field.keyof().enum.field} = ${scope.field}`,
              )
            : inArray(sql<string>`${assessment.evidence}->>'correctionKey'`, [
                ...keys,
              ]),
          after ? sql`${feedback.id} > ${after}::uuid` : undefined,
        ),
      )
      .orderBy(asc(feedback.id))
      .limit(100);
    if (!candidates.length) break;
    const readIdentity = fieldCorrectionIdentityReader(db);
    for (const source of await confirmedSources(
      db,
      inArray(
        feedback.id,
        candidates.map((row) => row.id),
      ),
    )) {
      const identity = await readIdentity(source.subject, source.evidence);
      candidatesWithIdentity.push({
        source,
        keys: fieldCorrectionIdentityKeys(identity),
      });
    }
    after = candidates.at(-1)!.id;
    if (candidates.length < 100) break;
  }
  // A proof for a stored key also preserves roots with that exact key but no recipe.
  for (let changed = true; changed;) {
    changed = false;
    for (const candidate of candidatesWithIdentity)
      if (candidate.keys.some((key) => keys.has(key)))
        for (const key of candidate.keys)
          if (!keys.has(key)) {
            keys.add(key);
            changed = true;
          }
  }
  return {
    keys: [...keys].sort(),
    sources: candidatesWithIdentity
      .filter((candidate) => candidate.keys.some((key) => keys.has(key)))
      .map((candidate) => candidate.source),
  };
}

/** Authority consumers and identity consumers share the same retained proof expansion. */
export async function readFieldCorrectionSources(
  db: Database,
  key: string | readonly string[],
  scope?: { entity: string; field: string },
) {
  return (await resolveFieldCorrectionIdentities(db, key, scope)).sources;
}

/** Skip input preparation when this field has never had confirmed correction authority. */
export async function hasFieldCorrectionSources(
  db: Database,
  entity: string,
  field: string,
) {
  return (
    (
      await confirmedSources(
        db,
        and(
          eq(assessment.family, "field"),
          sql`${assessment.subject}->>'entity' = ${entity}`,
          sql`${assessment.subject}->>${assessmentSubjects.field.keyof().enum.field} = ${field}`,
        ),
      )
    ).length > 0
  );
}

export async function readCorrectionTarget(db: Database, assessmentId: string) {
  const [row] = await getDb(db)
    .select({ prediction: assessment, state: assessmentState })
    .from(assessment)
    .innerJoin(assessmentState, eq(assessmentState.id, assessment.id))
    .where(eq(assessment.id, assessmentId))
    .limit(1);
  if (!row) return null;
  const [receipt] = await getDb(db)
    .select()
    .from(feedback)
    .where(
      and(
        eq(feedback.assessmentId, assessmentId),
        eq(feedback.authority, "automatic"),
        eq(feedback.intent, "apply"),
        sql`${feedback.metadata}->>${"kind"} = ${correctionAuthorityReceiptKinds.enum.assessment_application}`,
      ),
    )
    .orderBy(asc(feedback.createdAt), asc(feedback.id))
    .limit(1);
  if (receipt) {
    const metadata = receiptMetadata.parse(receipt.metadata);
    const [command] = await getDb(db)
      .select()
      .from(feedback)
      .where(eq(feedback.id, metadata.commandFeedbackId))
      .limit(1);
    if (!command)
      throw new Error("Original automatic application has no command Feedback");
    assertApplicationReceipt(receipt, command, "assessment_application");
  }
  return suggestionCorrectionTarget.parse({
    assessmentId,
    family: row.prediction.family,
    subject: row.prediction.subject,
    judgment: row.prediction.judgment,
    evidence: row.prediction.evidence,
    fingerprint: row.state.fingerprint,
    status: row.state.status,
    applicationFeedbackId: receipt?.id ?? null,
    applicationReceipt: receipt?.receipt ?? null,
  });
}

export async function correctionTargetIds(
  db: Database,
  input: {
    sourceAssessmentId: string;
    correctionKey: string | readonly string[];
    entity: string;
    field: string;
    after: string | null;
    limit: number;
  },
) {
  const scanned = await getDb(db)
    .select({
      id: assessment.id,
      evidence: assessment.evidence,
      subject: assessment.subject,
    })
    .from(assessment)
    .innerJoin(assessmentState, eq(assessmentState.id, assessment.id))
    .where(
      and(
        eq(assessment.family, "field"),
        eq(assessment.served, true),
        sql`${assessment.id} <> ${input.sourceAssessmentId}::uuid`,
        sql`${assessment.subject}->>'entity' = ${input.entity}`,
        sql`${assessment.subject}->>${assessmentSubjects.field.keyof().enum.field} = ${input.field}`,
        or(
          inArray(assessmentState.status, ["pending", "applied"]),
          sql`EXISTS (SELECT 1 FROM ${feedback} effect WHERE effect."assessmentId"=${assessment.id}
            AND effect.metadata->>${"kind"}=${CORRECTION_OUTCOME_RECEIPT_KIND}
            AND effect.receipt->>'status'=${suggestionStatus.enum.applied})`,
        ),
        input.after ? sql`${assessment.id} > ${input.after}::uuid` : undefined,
      ),
    )
    .orderBy(asc(assessment.id))
    .limit(input.limit);
  const targets = [];
  const expanded = await resolveFieldCorrectionIdentities(
    db,
    input.correctionKey,
    input,
  );
  const keys = new Set(expanded.keys);
  const readIdentity = fieldCorrectionIdentityReader(db);
  for (const row of scanned) {
    const identity = await readIdentity(row.subject, row.evidence);
    if (fieldCorrectionIdentityKeys(identity).some((key) => keys.has(key)))
      targets.push({ id: row.id });
  }
  return {
    targets,
    after: scanned.at(-1)?.id ?? input.after,
    done: scanned.length < input.limit,
  };
}
