import { entitySchema } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { fieldSuggestionContextKeys } from "@cubby/schemas/field-suggestion";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  getProductClassificationEvidence,
  productClassificationEvidenceSql,
} from "~/server/db/computed/product-classification-evidence";
import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";
import {
  repositoryQueries as getDb,
  repositoryBeforeCommit,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import {
  fieldWriteRevision,
  fieldWriteRevisions,
} from "~/server/generic/audit-log/repo/field-write";
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

function inputSpec(subject: FieldSubject) {
  const kind = entitySchema.parse(subject.entity);
  const model = entityFieldModels[kind].fields.find(
    (candidate) => candidate.key === subject.field,
  );
  if (!model)
    throw new Error(
      `Unknown assessment field: ${subject.entity}.${subject.field}`,
    );
  const policy = model.control?.suggest;
  const backings =
    policy && "backedBy" in policy ? (policy.backedBy ?? []) : [];
  const keys = [
    ...new Set(
      fieldSuggestionContextKeys(kind, [
        subject.field,
        ...(policy?.basis ?? []),
        ...backings.map((backing) =>
          "via" in backing ? backing.via : backing.column,
        ),
      ]),
    ),
  ].sort();
  return {
    ...subject,
    kind,
    table: sourceTable(subject.entity),
    backings,
    keys,
  };
}

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
  classifications: Map<string, string>;
  revisions: Map<string, string | null>;
};

async function readSources(
  db: RepositoryQueryInput,
  subjects: readonly Pick<FieldSubject, "entity" | "recordId">[],
) {
  const groups = new Map<string, Set<string>>();
  for (const subject of subjects) {
    const ids = groups.get(subject.entity) ?? new Set<string>();
    ids.add(subject.recordId.toLowerCase());
    groups.set(subject.entity, ids);
  }
  const rows = new Map<string, SourceRow>();
  for (const [entity, ids] of groups) {
    const result = await getDb(db).execute<{ id: string; value: unknown }>(sql`
      SELECT r.id::text AS id, to_jsonb(r) AS value FROM ${sourceTable(entity)} r
      WHERE r.id=ANY(${uuidArrayParam([...ids])}) AND ${notDeleted("r")}`);
    for (const row of result.rows)
      rows.set(sourceKey(entity, row.id), sourceRow.parse(row.value));
  }
  return rows;
}

/** Request-local source preparation; no retained cache or relaxed freshness gate. */
export async function fieldInputFingerprintsIfLive(
  db: RepositoryQueryInput,
  subjects: readonly FieldSubject[],
): Promise<(string | null)[]> {
  if (!subjects.length) return [];
  const specs = subjects.map(inputSpec);
  const sources = await readSources(db, subjects);
  const references: Pick<FieldSubject, "entity" | "recordId">[] = [];
  const products = new Set<string>();
  for (const spec of specs) {
    const row = sources.get(sourceKey(spec.entity, spec.recordId));
    if (!row) continue;
    for (const backing of spec.backings) {
      if (!("entity" in backing)) continue;
      const id = row[backing.via];
      if (typeof id === "string")
        references.push({ entity: backing.entity, recordId: id });
    }
    for (const key of spec.keys) {
      const reference = entityFieldModels[spec.kind].fields.find(
        (candidate) => candidate.key === key,
      )?.reference;
      if (
        !reference ||
        !Object.keys(SHORTCODE_TABLE).includes(reference.entity)
      )
        continue;
      const raw = row[key];
      const ids = z
        .array(z.uuid())
        .parse(raw == null ? [] : Array.isArray(raw) ? raw : [raw]);
      for (const id of ids)
        references.push({ entity: reference.entity, recordId: id });
    }
    if (spec.kind === "product" && spec.keys.includes("classificationEvidence"))
      products.add(spec.recordId.toLowerCase());
  }
  const related = await readSources(
    db,
    references.filter(
      (subject) => !sources.has(sourceKey(subject.entity, subject.recordId)),
    ),
  );
  for (const [key, row] of related) sources.set(key, row);
  const classifications = new Map<string, string>();
  if (products.size) {
    const result = await getDb(db).execute<{
      id: string;
      evidence: string;
    }>(sql`
      SELECT requested.id::text AS id, ${productClassificationEvidenceSql(sql`requested.id`)} AS evidence
      FROM unnest(${uuidArrayParam([...products])}) AS requested(id)`);
    for (const row of result.rows) classifications.set(row.id, row.evidence);
  }
  const live = subjects.filter((subject) =>
    sources.has(sourceKey(subject.entity, subject.recordId)),
  );
  const revisions = await fieldWriteRevisions(db, live);
  const prepared: PreparedInputs = {
    sources,
    classifications,
    revisions: new Map(
      live.map((subject, index) => [
        subjectKey(subject),
        revisions[index] ?? null,
      ]),
    ),
  };
  return Promise.all(
    specs.map((spec) => fingerprintFromInputs(db, spec, {}, prepared)),
  );
}

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
export async function fieldInputFingerprintIfLive(
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
  spec: ReturnType<typeof inputSpec>,
  options: { lock?: boolean },
  prepared?: PreparedInputs,
) {
  const { entity, recordId, field, kind, table, backings, keys } = spec;
  const preparedRow = prepared?.sources.get(sourceKey(entity, recordId));
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
  if (kind === "product" && keys.includes("classificationEvidence"))
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

/** Hold actual inputs through commit and refuse later changes in a caller's batch. */
export async function fenceFieldInputsAtCommit(
  db: RepositoryQueryInput,
  entity: string,
  recordId: string,
  field: string,
) {
  const expected = await fieldInputFingerprint(db, entity, recordId, field, {
    lock: true,
  });
  await repositoryBeforeCommit(
    db,
    async (tx) => {
      if (
        (await fieldInputFingerprint(tx, entity, recordId, field, {
          lock: true,
        })) !== expected
      )
        throw new Error(
          "Suggestion inputs changed later in the same transaction",
        );
    },
    { phase: "validation" },
  );
}
