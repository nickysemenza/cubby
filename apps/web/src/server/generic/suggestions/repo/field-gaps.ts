/** Field review is a view of scope gaps, Answers and independent Decisions. */
import { suggestionReviewRowSchema } from "@cubby/schemas/ai";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { fieldAnswer } from "~/server/ai/fields/repo/field-answer";
import { fieldReviewPlan } from "~/server/ai/fields/repo/plan";
import { readStoredRows } from "~/server/ai/fields/repo/stored-field";
import type { Database } from "~/server/db";
import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

const row = z.object({
  id: z.uuid(),
  inputHash: z.string(),
  entity: suggestionReviewRowSchema.shape.entity,
  recordId: z.uuid(),
  code: suggestionReviewRowSchema.shape.recordId,
  field: z.string(),
  model: z.string().nullable(),
  createdAt: z.coerce.date(),
  proposal: fieldAnswer.shape.proposal.unwrap(),
});
export async function readFieldSuggestions(
  db: Database,
  ids?: readonly string[],
  runId?: string,
) {
  const result = await repositoryQueries(db).execute<z.input<typeof row>>(sql`
    SELECT DISTINCT k.id, a."inputHash", split_part(s."scopeKey", ':', 1) AS entity,
      split_part(s."scopeKey", ':', 2) AS "recordId", e.shortcode AS code,
      k.input->${"input"}->>${"field"} AS field, a.model, a."createdAt", a.output->${"proposal"} AS proposal
    FROM "ScopeState" s CROSS JOIN LATERAL jsonb_array_elements(s.inputs) used
    JOIN "Answer" a ON a."inputHash"=used->>${"inputHash"}
    JOIN "Ask" k ON k.id=a."askId"
    JOIN "Entity" e ON e.id::text=split_part(s."scopeKey", ':', 2)
    WHERE s."scopeKind"=${"fields"} AND a.feature=${"field-suggestion"}
      AND jsonb_typeof(a.output->${"proposal"})=${"object"}
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.gaps) gap,
        jsonb_array_elements(gap->${"actions"}) action WHERE gap->>${"actor"}=${"you"} AND action->>${"field"}=k.input->${"input"}->>${"field"}
          AND action->${"value"}=a.output->${"proposal"}->${"value"})
      ${ids ? sql`AND k.id = ANY(${uuidArrayParam(ids)})` : sql``}
      ${
        runId
          ? sql`AND EXISTS (SELECT 1 FROM "AskScope" receipt JOIN "Run" owner ON owner.id=receipt."runId"
        WHERE receipt."askId"=k.id AND owner.shortcode=${runId} AND ${notDeleted("owner")})`
          : sql``
      }`);
  const parsed = z.array(row).parse(result.rows);
  const output = [];
  for (const item of parsed) {
    const plan = fieldReviewPlan(item.entity, item.field);
    if (!plan) continue;
    const stored = (
      await readStoredRows(db, plan.entity, [item.recordId], [item.field])
    ).get(item.recordId);
    const reference = plan.field.reference;
    const refs = reference
      ? [
          item.proposal.value,
          item.proposal.runnerUp?.value,
          stored?.[item.field],
        ]
          .filter((v): v is string => typeof v === "string")
          .map((v) => parseEntityRef(reference, v))
      : [];
    const codes = await lookupShortcodes(db, refs);
    const value = (v: unknown) =>
      reference && typeof v === "string"
        ? (codes.get(`${reference}:${v}`) ?? v)
        : (v ?? null);
    output.push(
      suggestionReviewRowSchema.parse({
        id: item.id,
        suggestionId: item.id,
        runId: runId ?? null,
        entity: item.entity,
        recordId: item.code,
        field: item.field,
        currentValue: value(stored?.[item.field]),
        suggestedValue: value(item.proposal.value),
        confidence: item.proposal.confidence,
        model: item.model ?? "unknown",
        kind: stored?.[item.field] == null ? "addition" : "correction",
        status: "pending",
        runnerUpValue: value(item.proposal.runnerUp?.value),
        runnerUpConfidence: item.proposal.runnerUp?.confidence ?? null,
        correctValue: null,
        createdAt: item.createdAt.toISOString(),
      }),
    );
  }
  return output;
}

export async function suggestionCounts(
  db: Database,
  input: { runId?: string; entity?: string } = {},
) {
  const rows = await readFieldSuggestions(db, undefined, input.runId);
  const groups = new Map<
    string,
    {
      entity: string;
      field: string;
      pending: number;
      applied: number;
      rejected: number;
      superseded: number;
      resolved: number;
    }
  >();
  const decided = input.runId
    ? []
    : [
        ...(await readFieldDecisions(db, "applied")),
        ...(await readFieldDecisions(db, "rejected")),
      ];
  for (const item of [...rows, ...decided]) {
    if (input.entity && item.entity !== input.entity) continue;
    const key = `${item.entity}.${item.field}`;
    const count = groups.get(key) ?? {
      entity: item.entity,
      field: item.field,
      pending: 0,
      applied: 0,
      rejected: 0,
      superseded: 0,
      resolved: 0,
    };
    if (item.status === "applied") count.applied++;
    else if (item.status === "rejected") count.rejected++;
    else count.pending++;
    groups.set(key, count);
  }
  return [...groups.values()];
}

/** Decided field history is immutable Decision history, including independent vetoes. */
export async function readFieldDecisions(
  db: Database,
  status: string,
  ids?: readonly string[],
) {
  if (status !== "applied" && status !== "rejected") return [];
  const selected = await repositoryQueries(db).execute<{
    id: string;
    subject: string;
    field: string;
    kind: string;
    value: unknown;
    at: Date;
    entity: string;
    code: string;
  }>(sql`
    SELECT d.id, d.subject, d.field, d.kind, d.value, d.at, e.kind AS entity, e.shortcode AS code
    FROM "Decision" d JOIN "Entity" e ON d.subject=e.kind || ':' || e.id::text
    WHERE d.channel IN (${"assignment"}, ${"veto"}) AND d.kind <> ${"release"}
      AND ${status === "rejected" ? sql`d.channel=${"veto"}` : sql`d.channel=${"assignment"}`}
      ${ids ? sql`AND d.id=ANY(${uuidArrayParam(ids)})` : sql``}
    ORDER BY d.at DESC, d.id DESC`);
  const historyRow = z.object({
    id: z.uuid(),
    subject: z.string(),
    field: z.string(),
    kind: z.string(),
    value: z.json().nullable(),
    at: z.coerce.date(),
    entity: suggestionReviewRowSchema.shape.entity,
    code: suggestionReviewRowSchema.shape.recordId,
  });
  const history = selected.rows.flatMap((row) => {
    const parsed = historyRow.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  const rows = [];
  for (const item of history) {
    const plan = fieldReviewPlan(item.entity, item.field);
    if (!plan) continue;
    let value = item.value;
    if (
      plan.field.reference &&
      typeof value === "string" &&
      z.uuid().safeParse(value).success
    ) {
      const codes = await lookupShortcodes(db, [
        parseEntityRef(plan.field.reference, value),
      ]);
      value = codes.get(`${plan.field.reference}:${value}`) ?? value;
    }
    rows.push(
      suggestionReviewRowSchema.parse({
        id: item.id,
        suggestionId: item.id,
        runId: null,
        entity: item.entity,
        recordId: item.code,
        field: item.field,
        currentValue: value,
        suggestedValue: value,
        confidence: 1,
        model: "decision",
        kind: "correction",
        status,
        runnerUpValue: null,
        runnerUpConfidence: null,
        correctValue: null,
        createdAt: item.at.toISOString(),
      }),
    );
  }
  return rows;
}
