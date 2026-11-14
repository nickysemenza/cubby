import { entitySchema } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { fieldSuggestionContextKeys } from "@cubby/schemas/field-suggestion";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getProductClassificationEvidence } from "~/server/db/computed/product-classification-evidence";
import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";
import {
  repositoryQueries as getDb,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import { fieldWriteRevision } from "~/server/generic/audit-log/repo/field-write";
import { canonicalJson } from "~/server/lib/canonical-json";

type FieldSubject = { entity: string; recordId: string; field: string };

const sourceRow = z.record(z.string(), z.json());
type SourceRow = z.infer<typeof sourceRow>;
const sourceKey = (entity: string, id: string) =>
  JSON.stringify([entity, id.toLowerCase()]);
const subjectKey = (subject: FieldSubject) =>
  JSON.stringify([
    subject.entity,
    subject.recordId.toLowerCase(),
    subject.field,
  ]);
const sourceTable = (entity: string) => {
  const table = Object.entries(SHORTCODE_TABLE).find(
    ([key]) => key === entity,
  )?.[1];
  if (!table) throw new Error(`No authoritative table: ${entity}`);
  return table;
};

function fieldInputPolicy(entity: string, field: string) {
  const kind = entitySchema.parse(entity);
  const model = entityFieldModels[kind].fields.find(
    (candidate) => candidate.key === field,
  );
  if (!model) throw new Error(`Unknown suggestion field: ${entity}.${field}`);
  const policy = model.control?.suggest;
  const backings =
    policy && "backedBy" in policy ? (policy.backedBy ?? []) : [];
  const keys = [
    ...new Set(
      fieldSuggestionContextKeys(kind, [
        field,
        ...(policy?.basis ?? []),
        ...backings.map((backing) =>
          "via" in backing ? backing.via : backing.column,
        ),
      ]),
    ),
  ].sort();
  return {
    kind,
    table: sourceTable(entity),
    backings,
    keys,
  };
}

function inputSpec(subject: FieldSubject) {
  return { ...subject, ...fieldInputPolicy(subject.entity, subject.field) };
}

type InputSpec = ReturnType<typeof inputSpec>;

const readsClassification = (spec: InputSpec) =>
  spec.kind === "product" && spec.keys.includes("classificationEvidence");

const referenceValue = (row: SourceRow | undefined): SourceRow | null => {
  if (!row) return null;
  const value = { ...row };
  for (const key of [
    "createdAt",
    "updatedAt",
    "verifiedAt",
    "lastVerifiedAt",
    "lastSeenAt",
  ])
    delete value[key];
  return value;
};

type PreparedInputs = {
  sources: Map<string, SourceRow>;
  liveSources: ReadonlySet<string>;
  classifications: Map<string, string>;
  revisions: Map<string, string | null>;
};

/** The direct reference and backing rows one live source row reads, live or not. */

/** The direct reference and backing rows one live source row reads, live or not. */

/** One subject's fingerprint and the read set a background publication retains. */

/**
 * Request-local source preparation; no retained cache or relaxed freshness gate.
 * The dependencies are the canonical read set, not proof that a capture covers it.
 */

/** Exact authoritative target/basis snapshot also catches SQL-only writers. */
export async function fieldInputFingerprint(
  db: RepositoryQueryInput,
  entity: string,
  recordId: string,
  field: string,
  options: { lock?: boolean } = {},
) {
  const fingerprint = await fieldInputFingerprintIfLive(
    db,
    entity,
    recordId,
    field,
    options,
  );
  if (fingerprint === null)
    throw new Error(
      `Suggestion subject is no longer live: ${entity}:${recordId}`,
    );
  return fingerprint;
}

/** Discovery skips deleted subjects; write fences still require a live subject. */
async function fieldInputFingerprintIfLive(
  db: RepositoryQueryInput,
  entity: string,
  recordId: string,
  field: string,
  options: { lock?: boolean } = {},
) {
  return fingerprintFromInputs(
    db,
    inputSpec({ entity, recordId, field }),
    options,
  );
}

async function fingerprintFromInputs(
  db: RepositoryQueryInput,
  spec: InputSpec,
  options: { lock?: boolean },
  prepared?: PreparedInputs,
) {
  const { entity, recordId, field, kind, table, backings, keys } = spec;
  const key = sourceKey(entity, recordId);
  const preparedRow = prepared?.liveSources.has(key)
    ? prepared.sources.get(key)
    : undefined;
  const source = prepared
    ? preparedRow
      ? { value: preparedRow }
      : undefined
    : (
        await getDb(db).execute<{ value: unknown }>(sql`
    SELECT to_jsonb(r) AS value FROM ${table} r WHERE r.id=${recordId}::uuid AND ${notDeleted("r")} LIMIT 1 ${options.lock ? sql`FOR UPDATE` : sql``}
  `)
      ).rows[0];
  if (!source) return null;
  const row = z.record(z.string(), z.json()).parse(source.value);
  const basis = Object.fromEntries(keys.map((key) => [key, row[key] ?? null]));
  for (const backing of backings) {
    if (!("entity" in backing)) continue;
    const target = Object.entries(SHORTCODE_TABLE).find(
      ([key]) => key === backing.entity,
    )?.[1];
    if (!target) throw new Error(`Unknown backing table: ${backing.entity}`);
    const id = row[backing.via];
    const [related] =
      typeof id === "string"
        ? prepared
          ? [
              {
                value: referenceValue(
                  prepared.sources.get(sourceKey(backing.entity, id)),
                ),
              },
            ]
          : (
              await getDb(db).execute<{ value: unknown }>(sql`
      SELECT to_jsonb(r)-ARRAY['createdAt','updatedAt','verifiedAt','lastVerifiedAt','lastSeenAt']::text[] AS value
      FROM ${target} r WHERE r.id=${id}::uuid AND ${notDeleted("r")} LIMIT 1 ${options.lock ? sql`FOR SHARE` : sql``}
    `)
            ).rows
        : [];
    basis[`${backing.entity}.${backing.column}`] = z
      .json()
      .parse(related?.value ?? null);
  }
  if (readsClassification(spec))
    basis.classificationEvidence = z
      .json()
      .parse(
        prepared
          ? prepared.classifications.get(recordId.toLowerCase())
          : await getProductClassificationEvidence(
              db,
              parseEntityId("product", recordId),
            ),
      );
  // Direct reference rows are input; the model sees no ancestor beyond them.
  // Inherited classification resolves through `classificationEvidence`, and
  // finance fields check their own review fingerprint.
  for (const key of keys) {
    const reference = entityFieldModels[kind].fields.find(
      (candidate) => candidate.key === key,
    )?.reference;
    if (!reference) continue;
    const target = Object.entries(SHORTCODE_TABLE).find(
      ([entity]) => entity === reference.entity,
    )?.[1];
    if (!target) continue;
    const raw = row[key];
    const ids = z
      .array(z.uuid())
      .parse(raw == null ? [] : Array.isArray(raw) ? raw : [raw]);
    const related = ids.length
      ? prepared
        ? [...new Set(ids.map((id) => id.toLowerCase()))]
            .sort()
            .flatMap((id) => {
              const value = referenceValue(
                prepared.sources.get(sourceKey(reference.entity, id)),
              );
              return value ? [{ value }] : [];
            })
        : (
            await getDb(db).execute<{ value: unknown }>(sql`
        SELECT to_jsonb(r)-ARRAY['createdAt','updatedAt','verifiedAt','lastVerifiedAt','lastSeenAt']::text[] AS value
        FROM ${target} r WHERE r.id=ANY(${uuidArrayParam(ids)}) AND ${notDeleted("r")} ORDER BY r.id ${options.lock ? sql`FOR SHARE` : sql``}
      `)
          ).rows
      : [];
    basis[`reference:${key}`] = related.map((item) =>
      z.json().parse(item.value),
    );
  }
  basis.fieldWriteIntent = prepared
    ? (prepared.revisions.get(subjectKey(spec)) ?? null)
    : await fieldWriteRevision(db, kind, recordId, field);
  return sha256Hex(canonicalJson(basis));
}
