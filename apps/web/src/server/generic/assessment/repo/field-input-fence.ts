import { entitySchema } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getProductClassificationEvidence } from "~/server/db/computed/product-classification-evidence";
import { getDb } from "~/server/db/helpers";
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import { refreshInputKeys } from "~/server/generic/derived-refresh/repo/input-keys";
import { readInputRevisions } from "~/server/generic/derived-refresh/repo/revisions";

/** Exact authoritative target/basis snapshot also catches SQL-only writers. */
export async function fieldInputFingerprint(
  db: Database,
  entity: string,
  recordId: string,
  field: string,
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
    SELECT to_jsonb(r) AS value FROM ${table} r WHERE r.id=${recordId}::uuid AND r."deletedAt" IS NULL LIMIT 1
  `)
  ).rows;
  if (!source)
    throw new Error(
      `Suggestion subject is no longer live: ${entity}:${recordId}`,
    );
  const row = z.record(z.string(), z.json()).parse(source.value);
  const backings =
    policy && "backedBy" in policy ? (policy.backedBy ?? []) : [];
  const keys = [
    ...new Set([
      field,
      ...(policy?.basis ?? []),
      ...backings.map((backing) =>
        "via" in backing ? backing.via : backing.column,
      ),
    ]),
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
      FROM ${target} r WHERE r.id=${id}::uuid AND r."deletedAt" IS NULL LIMIT 1
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
  // Own writes have a point revision. An unrelated row of the same kind must
  // not invalidate adjacent review actions; inherited bases still need the
  // kind epoch because their deciding ancestor can be a different row.
  const inherited = keys.some((key) =>
    entityFieldModels[kind].fields.some(
      (field) => field.key === key && field.resolution,
    ),
  );
  const revisionKeys = [
    ...refreshInputKeys(kind).filter(
      (key) => inherited || key !== `kind:${kind}`,
    ),
    `entity:${kind}:${recordId}`,
  ];
  basis.scopeRevisions = z
    .json()
    .parse(await readInputRevisions(db, revisionKeys));
  return sha256Hex(canonicalJson(basis));
}
