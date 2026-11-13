import { entityRefKey } from "@cubby/schemas/entity";
/**
 * Why this value for a `fields` column (ADR 0029 sections 1 and 10): who
 * holds it comes from provenance. An assignment decision in force is a
 * person's; otherwise the value is Cubby's, set by the kernel apply whose
 * AuditLog provenance names the field's Answer. The Answer the `fields`
 * scope last used is the picker's guess when it differs from the stored value.
 */
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { FieldGuess, FieldOrigin } from "@cubby/schemas/field-authority";
import { undecidedFieldValue } from "@cubby/schemas/field-suggestion-policy";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import { FIELDS_SCOPE, recordScopeKey } from "@cubby/schemas/kernel/capability";
import {
  decisionActorKind,
  decisionChannel,
  decisionKind,
} from "@cubby/schemas/kernel/stage";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { recordSubject } from "~/server/kernel/keys";

import { fieldPlan, type FieldsRow } from "./plan";
import { readStoredColumns } from "./stored-field";

const ASSIGNMENT = sqlEnumConstant(decisionChannel, "assignment");

const proposal = z.object({
  value: z.string(),
  label: z.string().nullable(),
  confidence: z.number(),
});
const usedAnswer = z.object({
  inputHash: z.string(),
  at: z.coerce.date(),
  output: z.object({
    proposal: proposal.extend({ runnerUp: proposal.nullable() }).nullable(),
  }),
});

/** The Answer the record's `fields` scope last used for `field`, or null. */
async function readUsedAnswer(
  db: RepositoryQueryInput,
  entity: ShortcodeEntity,
  recordId: string,
  field: string,
) {
  const result = await repositoryQueries(db).execute<FieldsRow>(sql`
    SELECT a."inputHash", a."createdAt" AS at, a.output
    FROM "ScopeState" s
    CROSS JOIN LATERAL jsonb_array_elements(s.inputs) used
    JOIN "Answer" a ON a."inputHash" = used->>${"inputHash"}
    JOIN "Ask" k ON k."inputHash" = a."inputHash"
    WHERE s."scopeKind" = ${FIELDS_SCOPE} AND s."scopeKey" = ${recordScopeKey(entity, recordId)}
      AND used->>${"kind"} = ${"answer"} AND k.input->${"input"}->>${"field"} = ${field}
    ORDER BY a."createdAt" DESC
    LIMIT 1`);
  return usedAnswer.safeParse(result.rows[0]).data ?? null;
}

/** The newest kernel apply that wrote `field`, with the field's Answer among its inputs. */
async function readCubbyWrite(
  db: RepositoryQueryInput,
  entity: ShortcodeEntity,
  recordId: string,
  field: string,
) {
  const result = await repositoryQueries(db).execute<FieldsRow>(sql`
    SELECT a."inputHash", l."createdAt" AS at, a.output
    FROM "AuditLog" l
    CROSS JOIN LATERAL jsonb_array_elements(l.provenance->${"inputs"}) used
    JOIN "Answer" a ON a."inputHash" = used->>${"inputHash"}
    JOIN "Ask" k ON k."inputHash" = a."inputHash"
    WHERE l."entityKind" = ${entity} AND l."entityId" = ${recordId}::uuid
      AND l.provenance IS NOT NULL AND l.changes ? ${field}
      AND used->>${"kind"} = ${"answer"} AND k.input->${"input"}->>${"field"} = ${field}
    ORDER BY l."createdAt" DESC
    LIMIT 1`);
  return usedAnswer.safeParse(result.rows[0]).data ?? null;
}

const decisionRow = z.object({
  kind: decisionKind,
  at: z.coerce.date(),
  actorKind: decisionActorKind,
  name: z.string().nullable(),
});

/** The newest assignment row on the field, in force or a release. */
async function readAssignment(
  db: RepositoryQueryInput,
  entity: ShortcodeEntity,
  recordId: string,
  field: string,
) {
  const result = await repositoryQueries(db).execute<FieldsRow>(sql`
    SELECT d.kind, d.at, d."actorKind", u.name
    FROM "Decision" d LEFT JOIN "user" u ON u.id = d."actorId"
    WHERE d.channel = ${ASSIGNMENT} AND d.subject = ${recordSubject(entity, recordId)}
      AND d.slot = ${field}
    ORDER BY d.at DESC, d.id DESC
    LIMIT 1`);
  return decisionRow.safeParse(result.rows[0]).data ?? null;
}

/** A reference value as the picker names it: its public shortcode. */
async function publicValue(
  db: RepositoryQueryInput,
  reference: ShortcodeEntity | null,
  value: string,
): Promise<string> {
  if (!reference) return value;
  const codes = await lookupShortcodes(db, [parseEntityRef(reference, value)]);
  return codes.get(entityRefKey(reference, value)) ?? value;
}

/** Cubby's answer for a field nobody holds, when it differs from the stored value. */
export async function readFieldGuess(
  db: RepositoryQueryInput,
  entity: ShortcodeEntity,
  recordId: string,
  field: string,
): Promise<FieldGuess | null> {
  const plan = fieldPlan(entity, field);
  if (!plan) return null;
  const [assignment, answer, stored] = await Promise.all([
    readAssignment(db, entity, recordId, field),
    readUsedAnswer(db, entity, recordId, field),
    readStoredColumns(db, plan.entity, recordId, [field]),
  ]);
  const guess = answer?.output.proposal;
  if (
    !guess ||
    !stored ||
    (assignment && assignment.kind !== "release") ||
    String(stored[field] ?? "") === guess.value
  )
    return null;
  const reference = plan.field.reference;
  return {
    suggestionId: answer.inputHash,
    fingerprint: answer.inputHash,
    value: await publicValue(db, reference, guess.value),
    confidence: guess.confidence,
    runnerUp: guess.runnerUp
      ? {
          value: await publicValue(db, reference, guess.runnerUp.value),
          confidence: guess.runnerUp.confidence,
        }
      : null,
  };
}

/** Who holds the field, who decided it, and Cubby's guess, for Why this value. */
export async function describeFieldOrigin(
  db: RepositoryQueryInput,
  entity: ShortcodeEntity,
  recordId: string,
  field: string,
): Promise<FieldOrigin | null> {
  const plan = fieldPlan(entity, field);
  if (!plan) return null;
  const [assignment, answer, stored] = await Promise.all([
    readAssignment(db, entity, recordId, field),
    readUsedAnswer(db, entity, recordId, field),
    readStoredColumns(db, plan.entity, recordId, [field]),
  ]);
  const value = stored?.[field] ?? null;
  const base = {
    apply: plan.field.apply,
    fillOnly: plan.field.fillOnly,
  };
  if (assignment && assignment.kind !== "release")
    return {
      ...base,
      holder: "person",
      at: assignment.at.toISOString(),
      confidence: null,
      keptAt:
        answer?.output.proposal &&
        answer.output.proposal.value === String(value ?? "") &&
        answer.at < assignment.at
          ? assignment.at.toISOString()
          : null,
      writer: {
        kind:
          assignment.actorKind === "system"
            ? "import"
            : assignment.actorKind === "agent"
              ? "agent"
              : "member",
        name: assignment.actorKind === "member" ? assignment.name : null,
      },
      released: false,
      guess: null,
    };
  const open = undecidedFieldValue(entity, field, value);
  const written = open
    ? null
    : await readCubbyWrite(db, entity, recordId, field);
  const cubbyAnswer =
    written?.output.proposal &&
    written.output.proposal.value === String(value ?? "")
      ? written
      : null;
  return {
    ...base,
    holder: open ? "open" : "cubby",
    at: cubbyAnswer ? cubbyAnswer.at.toISOString() : null,
    confidence: cubbyAnswer?.output.proposal?.confidence ?? null,
    keptAt: null,
    writer: open ? null : { kind: "cubby", name: null },
    released: assignment?.kind === "release",
    guess: await readFieldGuess(db, entity, recordId, field),
  };
}
