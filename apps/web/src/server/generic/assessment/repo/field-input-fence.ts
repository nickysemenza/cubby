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
  repositoryBeforeCommit,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import { fieldWriteRevision } from "~/server/generic/audit-log/repo/field-write";
import { canonicalJson } from "~/server/lib/canonical-json";

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
  const kind = entitySchema.parse(entity);
  const model = entityFieldModels[kind].fields.find(
    (candidate) => candidate.key === field,
  );
  const policy = model?.control?.suggest;
  if (!model) throw new Error(`Unknown assessment field: ${entity}.${field}`);
  const table = Object.entries(SHORTCODE_TABLE).find(
    ([key]) => key === entity,
  )?.[1];
  if (!table) throw new Error(`No authoritative table: ${entity}`);
  const [source] = (
    await getDb(db).execute<{ value: unknown }>(sql`
    SELECT to_jsonb(r) AS value FROM ${table} r WHERE r.id=${recordId}::uuid AND ${notDeleted("r")} LIMIT 1 ${options.lock ? sql`FOR UPDATE` : sql``}
  `)
  ).rows;
  if (!source) return null;
  const row = z.record(z.string(), z.json()).parse(source.value);
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
        ? (
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
        await getProductClassificationEvidence(
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
      ? (
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
  basis.fieldWriteIntent = await fieldWriteRevision(db, kind, recordId, field);
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
