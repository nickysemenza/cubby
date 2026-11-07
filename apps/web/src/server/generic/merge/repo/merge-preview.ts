import { entityRefKey } from "@cubby/schemas/entity";
import {
  type EntityConnectionsOut,
  entityMergePreviewInput,
  type EntityMergePreviewInput,
  type EntityMergePreviewOut,
} from "@cubby/schemas/entity-connections";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import type { z } from "zod";

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

type Json = z.infer<ReturnType<typeof z.json>>;

type MergeConflicts = {
  entity: MergeEntity;
  candidates: Omit<
    EntityMergePreviewOut["candidates"][number],
    "connections"
  >[];
  suggestedKeepId: string;
  conflicts: EntityMergePreviewOut["conflicts"];
};

/** Reads one code's public detail, so values match what `entity.detail` shows. */
type ReadMergeRecord = (
  entity: MergeEntity,
  code: string,
) => Promise<object | null>;

/**
 * The suggested survivor (`suggestMergeSurvivor`) and every scalar update
 * field the candidates disagree on, with each candidate's value. The merge
 * preview and the merge's `survivorValues` check share it, so a value the
 * merge accepts is one the preview offered.
 */
async function readMergeConflicts(
  db: Database | DrizzleTransaction,
  input: { entity: EntityMergePreviewInput["entity"]; ids: readonly string[] },
  readRecord: ReadMergeRecord,
): Promise<MergeConflicts> {
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

/**
 * The kernel merge preview: the conflicts above, each candidate's incoming
 * connections with the merge's declared disposition, and what would refuse
 * merging into `keepId` (blocking connections on the other candidates and
 * the entity's own merge rules, `mergeBlockers`).
 */
export async function previewEntityMerge(
  db: Database | DrizzleTransaction,
  rawInput: EntityMergePreviewInput,
  ports: {
    readRecord: ReadMergeRecord;
    connections: (code: string) => Promise<EntityConnectionsOut>;
    mergeBlockers: (
      entity: MergeEntity,
      plan: { keepId: string; mergeIds: string[] },
    ) => Promise<string[]>;
  },
): Promise<EntityMergePreviewOut> {
  const input = entityMergePreviewInput.parse(rawInput);
  const preview = await readMergeConflicts(db, input, ports.readRecord);
  const keepId = input.keepId ?? preview.suggestedKeepId;
  if (!preview.candidates.some((candidate) => candidate.id === keepId))
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `keepId ${keepId} is not one of the merge candidates.`,
    );
  const candidates = await Promise.all(
    preview.candidates.map(async (candidate) => ({
      ...candidate,
      connections: (await ports.connections(candidate.id)).groups.filter(
        (group) => group.direction === "incoming" && group.count > 0,
      ),
    })),
  );
  const mergeIds = candidates
    .filter((candidate) => candidate.id !== keepId)
    .map((candidate) => candidate.id);
  const blockingConnections = candidates.flatMap((candidate) =>
    candidate.id === keepId
      ? []
      : candidate.connections.flatMap((group) =>
          group.disposition?.effect === "block"
            ? [
                `${candidate.name ?? candidate.id}: ${group.count} ${group.label} — ${group.disposition.description}`,
              ]
            : [],
        ),
  );
  return {
    ...preview,
    candidates,
    keepId,
    blockers: [
      ...blockingConnections,
      ...(await ports.mergeBlockers(preview.entity, { keepId, mergeIds })),
    ],
  };
}

/**
 * Validates `entity.mutate` merge `survivorValues` against the preview's
 * conflicts for the same selection: each key must be a conflicting field and
 * each value one a candidate holds. Read before the merge, while the
 * merged-away candidates are still live.
 */
export async function checkSurvivorValues(
  db: Database | DrizzleTransaction,
  input: {
    entity: EntityMergePreviewInput["entity"];
    keepId: string;
    mergeIds: readonly string[];
    survivorValues: Readonly<Record<string, Json>>;
  },
  readRecord: ReadMergeRecord,
): Promise<Record<string, Json>> {
  const { conflicts } = await readMergeConflicts(
    db,
    { entity: input.entity, ids: [input.keepId, ...input.mergeIds] },
    readRecord,
  );
  for (const [field, value] of Object.entries(input.survivorValues)) {
    const conflict = conflicts.find((candidate) => candidate.field === field);
    if (!conflict)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `survivorValues.${field} is not a field these ${input.entity} records disagree on.`,
      );
    if (
      !conflict.values.some(
        (candidate) =>
          JSON.stringify(candidate.value) === JSON.stringify(value),
      )
    )
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `survivorValues.${field} must be one of the merge candidates' values (${conflict.values.map((candidate) => `${candidate.id}: ${candidate.display}`).join(", ")}).`,
      );
  }
  return { ...input.survivorValues };
}
