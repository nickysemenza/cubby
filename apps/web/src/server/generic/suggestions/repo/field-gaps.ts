/** Field review is a view of scope gaps, Answers and independent Decisions. */
import { suggestionReviewRowSchema } from "@cubby/schemas/ai";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import { decisionChannel, decisionKind } from "@cubby/schemas/kernel/stage";
import { suggestionStrength } from "@cubby/schemas/suggestion-list";
import { getTableColumns, sql, type SQL } from "drizzle-orm";
import { groupBy } from "es-toolkit";
import { z } from "zod";

import { fieldAnswer } from "~/server/ai/fields/repo/field-answer";
import { fieldReviewPlan } from "~/server/ai/fields/repo/plan";
import type { Database } from "~/server/db";
import { textArrayParam } from "~/server/db/helpers/array-param";
import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { sqlEnumConstant } from "~/server/db/sql-enum";
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
  currentValue: z.unknown(),
});
type FieldScope = {
  ids?: readonly string[];
  runId?: string;
  entity?: string;
  records?: readonly { entity: string; id: string }[];
  endpoints?: readonly { entity: string; id: string }[];
  relations?: ReadonlyMap<string, unknown>;
};

const subjectKey = (record: { entity: string; id: string }) =>
  `${record.entity}:${record.id}`;

const entityPart = (key: SQL) => sql`split_part(${key}, ':', 1)`;
const entityIdPart = (key: SQL) => sql`CASE
  WHEN split_part(${key}, ':', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN split_part(${key}, ':', 2)::uuid END`;

const supportedFields = () =>
  shortcodeEntities.flatMap((entity) =>
    entityFieldModels[entity].fields.flatMap(({ key }) => {
      const plan = fieldReviewPlan(entity, key);
      return plan ? [{ entity, key, plan }] : [];
    }),
  );

function fieldMembership(entity: SQL, field: SQL) {
  return sql`(${entity} || '.' || (${field})) = ANY(${textArrayParam(
    supportedFields().map(({ entity, key }) => `${entity}.${key}`),
  )})`;
}

function currentValue(entity: SQL, field: SQL, id: SQL) {
  const byEntity = groupBy(supportedFields(), ({ entity }) => entity);
  const branches = Object.entries(byEntity).flatMap(([kind, fields]) => {
    const table = fields[0]?.plan.entity.table;
    if (!table) return [];
    const columns = getTableColumns(table);
    const cases = fields.map(
      ({ key }) => sql`WHEN ${key} THEN to_jsonb(${columns[key]})`,
    );
    return [
      sql`WHEN ${entity} = ${kind} THEN (
      SELECT CASE ${field} ${sql.join(cases, sql` `)} END
      FROM ${table} WHERE ${table.id} = ${id}
    )`,
    ];
  });
  return sql`CASE ${sql.join(branches, sql` `)} END`;
}

const formattedTime = (value: SQL) =>
  sql`to_char(${value}::timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function pendingFieldCandidates(scope: FieldScope, withCurrent: boolean) {
  const entity = entityPart(sql`s."scopeKey"`);
  const field = sql`k.input->${"input"}->>${"field"}`;
  const proposal = sql`a.output->'proposal'`;
  const scopes = scope.records?.map(subjectKey);
  const askJoin =
    scope.ids || scope.runId
      ? sql`
    JOIN "Ask" k ON s."scopeKey" = (k.input->${"input"}->>'entity') || ':' || (k.input->${"input"}->>'recordId')
      AND s.inputs @> jsonb_build_array(jsonb_build_object('inputHash', k."inputHash"))
    JOIN "Answer" a ON a."inputHash"=k."inputHash" AND a."askId"=k.id
  `
      : sql`
    CROSS JOIN LATERAL jsonb_array_elements(s.inputs) used
    JOIN "Answer" a ON a."inputHash"=used->>'inputHash'
    JOIN "Ask" k ON k.id=a."askId"
  `;
  const endpointKeys = scope.endpoints?.map(subjectKey);
  const targetMatches =
    scope.endpoints &&
    supportedFields().flatMap(({ entity, key, plan }) => {
      if (!scope.relations?.has(`${entity}.${key}`)) return [];
      const ids =
        scope.endpoints
          ?.filter((target) => target.entity === plan.field.reference)
          .map((target) => target.id) ?? [];
      return ids.length
        ? [
            sql`(${entityPart(sql`s."scopeKey"`)} = ${entity} AND
          action.value->>${"field"} = ${key} AND action.value->>'value' = ANY(${textArrayParam(ids)}))`,
          ]
        : [];
    });
  const matchingAction = endpointKeys
    ? sql`AND (s."scopeKey" = ANY(${textArrayParam(endpointKeys)})${
        targetMatches?.length
          ? sql` OR ${sql.join(targetMatches, sql` OR `)}`
          : sql``
      })`
    : sql``;
  return sql`
    SELECT DISTINCT k.id, a."inputHash", ${entity} AS entity,
      e.id AS "recordId", e.shortcode AS code,
      ${field} AS field, a.model, a."createdAt", ${proposal} AS proposal,
      ${withCurrent ? currentValue(entity, field, sql`e.id`) : sql`NULL::jsonb`} AS "currentValue"
    FROM (
      SELECT s."scopeKey", s.inputs, gap.value AS gap
      FROM "ScopeState" s
      CROSS JOIN LATERAL jsonb_array_elements(s.gaps) gap
      WHERE s."scopeKind"='fields'
        AND s.gaps @> '[{"actor":"you"}]'::jsonb
        AND gap.value->>'actor' = 'you'
        ${scope.entity ? sql`AND ${entity} = ${scope.entity}` : sql``}
        ${scopes ? sql`AND s."scopeKey" = ANY(${textArrayParam(scopes)})` : sql``}
    ) s
    JOIN "Entity" e ON e.id = ${entityIdPart(sql`s."scopeKey"`)}
    CROSS JOIN LATERAL jsonb_array_elements(s.gap->'actions') action
    ${askJoin}
    WHERE a.feature='field-suggestion'
      AND jsonb_typeof(${proposal})='object'
      AND action.value->>${"field"}=${field}
      AND action.value->'value'=${proposal}->'value'
      AND ${fieldMembership(entity, field)}
      ${matchingAction}
      ${scope.relations ? sql`AND (${entity} || '.' || (${field})) = ANY(${textArrayParam([...scope.relations.keys()])})` : sql``}
      ${scope.ids ? sql`AND k.id = ANY(${uuidArrayParam(scope.ids)})` : sql``}
      ${
        scope.runId
          ? sql`AND EXISTS (
        SELECT 1 FROM "AskScope" receipt JOIN "Run" owner ON owner.id=receipt."runId"
        WHERE receipt."askId"=k.id AND owner.shortcode=${scope.runId} AND ${notDeleted("owner")}
      )`
          : sql``
      }`;
}

const VETO = sqlEnumConstant(decisionChannel, "veto");
const ASSIGNMENT = sqlEnumConstant(decisionChannel, "assignment");
const RELEASE = sqlEnumConstant(decisionKind, "release");

function fieldDecisionCandidates(
  scope: FieldScope,
  status?: "applied" | "rejected",
) {
  const sources = scope.records?.map(subjectKey);
  return sql`
    SELECT d.id, d.field, d.channel, d.value, d.at, e.kind AS entity, e.shortcode AS code
    FROM "Decision" d
    JOIN "Entity" e ON e.id=${entityIdPart(sql`d.subject`)}
      AND d.subject=e.kind || ':' || e.id::text
    WHERE ${status === "rejected" ? sql`d.channel=${VETO}` : status === "applied" ? sql`d.channel=${ASSIGNMENT}` : sql`d.channel IN (${ASSIGNMENT}, ${VETO})`}
      AND d.kind <> ${RELEASE} AND ${fieldMembership(sql`e.kind`, sql`d.field`)}
      ${scope.ids ? sql`AND d.id=ANY(${uuidArrayParam(scope.ids)})` : sql``}
      ${sources ? sql`AND d.subject=ANY(${textArrayParam(sources)})` : sql``}
      ${scope.entity ? sql`AND e.kind=${scope.entity}` : sql``}`;
}

export function fieldFacts(
  scope: FieldScope,
  status: string,
  needs: ReadonlySet<string>,
) {
  const pending = status === "pending";
  if (!pending && status !== "applied" && status !== "rejected") return null;
  return {
    from: sql`(${pending ? pendingFieldCandidates(scope, needs.has("kind")) : fieldDecisionCandidates(scope, status)}) s`,
    where: sql`true`,
    columns: {
      entity: sql`s.entity`,
      field: sql`s.field`,
      createdAt: formattedTime(pending ? sql`s."createdAt"` : sql`s.at`),
      kind: pending
        ? sql`CASE WHEN s."currentValue" IS NULL OR s."currentValue" = 'null'::jsonb THEN ${suggestionReviewRowSchema.shape.kind.enum.addition}::text ELSE ${suggestionReviewRowSchema.shape.kind.enum.correction}::text END`
        : sql`${suggestionReviewRowSchema.shape.kind.enum.correction}`,
      confidence: pending ? sql`s.proposal->>'confidence'` : sql`1`,
      disposition: sql`${"needs_you"}`,
      strength: sql`${suggestionStrength.enum.weak}`,
      clean: sql`'false'`,
      impact: sql`0`,
    },
  };
}

export async function readFieldSuggestions(
  db: Database,
  scope: FieldScope = {},
) {
  const result = await repositoryQueries(db).execute<z.input<typeof row>>(
    pendingFieldCandidates(scope, true),
  );
  const items = z
    .array(row)
    .parse(result.rows)
    .flatMap((item) => {
      const plan = fieldReviewPlan(item.entity, item.field);
      return plan ? [{ item, reference: plan.field.reference }] : [];
    });
  const codes = await lookupShortcodes(
    db,
    items.flatMap(({ item, reference }) =>
      reference
        ? [
            item.proposal.value,
            item.proposal.runnerUp?.value,
            item.currentValue,
          ]
            .filter((value): value is string => typeof value === "string")
            .map((value) => parseEntityRef(reference, value))
        : [],
    ),
  );
  return items.map(({ item, reference }) => {
    const value = (v: unknown) =>
      reference && typeof v === "string"
        ? (codes.get(`${reference}:${v}`) ?? v)
        : (v ?? null);
    return suggestionReviewRowSchema.parse({
      id: item.id,
      suggestionId: item.id,
      runId: scope.runId ?? null,
      entity: item.entity,
      recordId: item.code,
      field: item.field,
      currentValue: value(item.currentValue),
      suggestedValue: value(item.proposal.value),
      confidence: item.proposal.confidence,
      model: item.model ?? "unknown",
      kind: item.currentValue == null ? "addition" : "correction",
      status: "pending",
      runnerUpValue: value(item.proposal.runnerUp?.value),
      runnerUpConfidence: item.proposal.runnerUp?.confidence ?? null,
      correctValue: null,
      createdAt: item.createdAt.toISOString(),
    });
  });
}

export async function suggestionCounts(db: Database, scope: FieldScope = {}) {
  if (scope.runId) return [];
  const result = await repositoryQueries(db).execute<{
    entity: string;
    field: string;
    applied: number;
    rejected: number;
  }>(sql`
    SELECT entity, field,
      count(*) FILTER (WHERE channel = ${ASSIGNMENT})::int AS applied,
      count(*) FILTER (WHERE channel = ${VETO})::int AS rejected
    FROM (${fieldDecisionCandidates(scope)}) d
    GROUP BY entity, field
  `);
  return result.rows.map((row) => ({
    ...row,
    pending: 0,
    superseded: 0,
    resolved: 0,
  }));
}

/** Decided field history is immutable Decision history, including independent vetoes. */
export async function readFieldDecisions(
  db: Database,
  status: string,
  scope: FieldScope = {},
) {
  if (status !== "applied" && status !== "rejected") return [];
  const historyRow = z.object({
    id: z.uuid(),
    field: z.string(),
    value: z.json().nullable(),
    at: z.coerce.date(),
    entity: suggestionReviewRowSchema.shape.entity,
    code: suggestionReviewRowSchema.shape.recordId,
  });
  const selected = await repositoryQueries(db).execute<
    z.input<typeof historyRow>
  >(fieldDecisionCandidates(scope, status));
  const history = selected.rows.flatMap((row) => {
    const parsed = historyRow.safeParse(row);
    if (!parsed.success) return [];
    const item = parsed.data;
    const reference = fieldReviewPlan(item.entity, item.field)?.field.reference;
    const ref =
      reference &&
      typeof item.value === "string" &&
      z.uuid().safeParse(item.value).success
        ? parseEntityRef(reference, item.value)
        : null;
    return [{ item, ref }];
  });
  const codes = await lookupShortcodes(
    db,
    history.flatMap(({ ref }) => (ref ? [ref] : [])),
  );
  return history.map(({ item, ref }) => {
    const value = ref
      ? (codes.get(`${ref.entity}:${ref.id}`) ?? item.value)
      : item.value;
    return suggestionReviewRowSchema.parse({
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
    });
  });
}
