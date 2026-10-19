import type { Entity } from "@cubby/schemas/entity";
import {
  isCollectionPatch,
  type ValueCollectionPatch,
  valueCollectionPatch,
} from "@cubby/schemas/entity-collection";
import {
  type EntityFieldModel,
  entityFieldModels,
} from "@cubby/schemas/entity-fields";
import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import { z } from "zod";

import { readPathValue } from "~/entity/read-path";
import { createAppError } from "~/server/errors/app-error";

import type {
  EntityBindingSchemas,
  EntityKernelContext,
  EntityKernelCoreBinding,
} from "./adapter";
import type { EntityKernelEntity } from "./contracts";

/**
 * Apply `{op, key}` patch items to a value-keyed collection (a text array).
 * Every replace/remove must name a present value, checked before any change,
 * so a refused patch changes nothing. The result keeps order and drops
 * duplicates a rename would create.
 */
function applyValueCollectionPatch(
  entity: Entity,
  field: string,
  current: readonly string[],
  patch: ValueCollectionPatch,
  bulk: boolean,
): string[] {
  const present = new Set(current);
  for (const item of patch) {
    if (
      item.op === "add" ||
      present.has(item.key) ||
      (bulk && item.op === "remove")
    )
      continue;
    throw createAppError(
      "COLLECTION_PATCH_PRECONDITION_FAILED",
      `${entityInspectorMetadata[entity].singular} ${field} has no "${item.key}" to ${item.op}; it holds ${current.length ? current.map((value) => `"${value}"`).join(", ") : "nothing"}.`,
    );
  }
  let result = [...current];
  for (const item of patch) {
    if (item.op === "add") result.push(item.key);
    else if (item.op === "remove")
      result = result.filter((value) => value !== item.key);
    else
      result = result.map((value) => (value === item.key ? item.value : value));
  }
  return [...new Set(result)];
}

const record = z.record(z.string(), z.unknown());

/**
 * The full value of every value-keyed collection patched in an update, read
 * from the entity's detail inside the write transaction; the caller lays it
 * over the update. Record collections (`collection.key` naming identity
 * fields) are absent: their repository applies them.
 */
export async function resolveValueCollectionPatches<
  E extends EntityKernelEntity,
  S extends EntityBindingSchemas,
>(
  context: EntityKernelContext,
  binding: EntityKernelCoreBinding<E, S>,
  id: z.output<S["id"]>,
  data: unknown,
  options: { bulk?: boolean } = {},
): Promise<Map<string, string[]>> {
  const input = record.parse(data);
  const declared: EntityFieldModel["fields"] =
    entityFieldModels[binding.entity].fields;
  const fields = declared.filter(
    (field) =>
      (field.collection?.key === "value" ||
        field.reference?.multiple === true) &&
      isCollectionPatch(input[field.key]),
  );
  const resolved = new Map<string, string[]>();
  if (fields.length === 0) return resolved;
  const found = await binding.repository.get(context, id);
  // A missing record is the repository's refusal to report.
  if (found === null) return resolved;
  const detail = record.parse(found);
  for (const field of fields) {
    resolved.set(
      field.key,
      applyValueCollectionPatch(
        binding.entity,
        field.key,
        z
          .array(z.string())
          .parse(
            readPathValue(
              detail,
              field.readKey ?? field.display.readPath ?? field.key,
            ) ?? [],
          ),
        valueCollectionPatch.parse(input[field.key]),
        options.bulk ?? false,
      ),
    );
  }
  return resolved;
}
