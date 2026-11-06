import { entityRefKey } from "@cubby/schemas/entity";
import {
  entityMergePreviewInput,
  type EntityMergePreviewInput,
  type EntityMergePreviewOut,
} from "@cubby/schemas/entity-connections";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { parseEntityRef } from "@cubby/schemas/identifiers";

import { readPathValue } from "~/entity/read-path";
import type { Database, DrizzleTransaction } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { generatedMergeEntityKernelEntities } from "~/server/generated/entity-kernel-entities.gen";
import { readMergeCandidates } from "~/server/generic/entity-links/repo/entity-edge-source";
import {
  lookupEntityLabels,
  resolveShortcodes,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

import { suggestMergeSurvivor } from "./core";

const mergeEntities: readonly MergeEntity[] =
  generatedMergeEntityKernelEntities;
type MergeEntity = (typeof generatedMergeEntityKernelEntities)[number];

/** Scalar update fields a member can pick one candidate's value for. */
const CONFLICT_KINDS = new Set([
  "text",
  "number",
  "enum",
  "boolean",
  "date",
  "identifier",
]);

const present = (value: unknown) =>
  value !== null && value !== undefined && value !== "";

/**
 * The kernel merge preview: the suggested survivor (`suggestMergeSurvivor`)
 * and every scalar update field the candidates disagree on, with each
 * candidate's value. `readRecord` is the public detail read of one code, so
 * values match what `entity.detail` shows.
 */
export async function previewEntityMerge(
  db: Database | DrizzleTransaction,
  rawInput: EntityMergePreviewInput,
  readRecord: (entity: MergeEntity, code: string) => Promise<object | null>,
): Promise<EntityMergePreviewOut> {
  const input = entityMergePreviewInput.parse(rawInput);
  const entity = mergeEntities.find((candidate) => candidate === input.entity);
  if (entity === undefined)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${input.entity} records do not merge through the kernel.`,
    );
  const identities = await readMergeCandidates(db, entity, input.ids);
  const [names, records] = await Promise.all([
    lookupEntityLabels(
      db,
      identities.map((identity) => parseEntityRef(entity, identity.id)),
    ),
    Promise.all(
      identities.map((identity) => readRecord(entity, identity.code)),
    ),
  ]);
  const candidates = identities.map((identity) => ({
    id: identity.code,
    name: names.get(entityRefKey(entity, identity.id)) ?? null,
    connectionCount: identity.connectionCount,
    createdAt: identity.createdAt,
  }));
  const suggested = suggestMergeSurvivor(candidates);
  if (!suggested) throw new Error("A merge preview needs candidates");

  const model = entityFieldModels[entity];
  const updatable = new Set<string>(model.update);
  const fields = model.fields.filter(
    (field) =>
      updatable.has(field.key) &&
      field.readKey !== null &&
      CONFLICT_KINDS.has(field.kind) &&
      field.reference?.multiple !== true,
  );
  const drafts = fields.flatMap((field) => {
    const values = records.flatMap((record, index) => {
      const value = readPathValue(record, field.readKey ?? field.key);
      const candidate = candidates[index];
      return candidate && present(value)
        ? [{ id: candidate.id, value, record }]
        : [];
    });
    return new Set(values.map(({ value }) => JSON.stringify(value))).size > 1
      ? [{ field, values }]
      : [];
  });
  // Reference values without a declared label path read their target's title.
  const referenceCodes = drafts.flatMap(({ field, values }) =>
    field.reference && !field.display.labelPath
      ? values.flatMap(({ value }) =>
          typeof value === "string" ? [value] : [],
        )
      : [],
  );
  const refs = await resolveShortcodes(db, referenceCodes);
  const referenceLabels = await lookupEntityLabels(db, [...refs.values()]);
  const display = (
    field: (typeof fields)[number],
    value: unknown,
    record: unknown,
  ): string => {
    if (field.display.labelPath) {
      const label = readPathValue(record, field.display.labelPath);
      if (typeof label === "string" && label) return label;
    }
    if (field.reference && typeof value === "string") {
      const ref = refs.get(value);
      return (
        (ref && referenceLabels.get(entityRefKey(ref.entity, ref.id))) ?? value
      );
    }
    if (typeof value === "boolean") return value ? "Yes" : "No";
    const option = field.control?.options?.find(
      (candidate) => candidate.value === value,
    );
    if (option) return option.label;
    return typeof value === "string" ? value : JSON.stringify(value);
  };
  return {
    entity,
    suggestedKeepId: suggested.id,
    candidates,
    conflicts: drafts.map(({ field, values }) => ({
      field: field.key,
      label: field.label,
      values: values.map(({ id, value, record }) => ({
        id,
        value,
        display: display(field, value, record),
      })),
    })),
  };
}
