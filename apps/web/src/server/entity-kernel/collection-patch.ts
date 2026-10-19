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
import type { StructuredValueSchema } from "@cubby/schemas/structured-value-schema";
import { structuredValueSchemas } from "@cubby/schemas/structured-value-schemas";
import { z } from "zod";

import { project, wireValue } from "~/entity/editing/structured-value";
import { readPathValue } from "~/entity/read-path";
import {
  canonicalJson,
  entityDetailJson,
} from "~/server/entity-kernel/repo/entity-source";
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
): string[] {
  const present = new Set(current);
  for (const item of patch) {
    if (item.op === "add" || present.has(item.key)) continue;
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
const jsonRecord = z.record(z.string(), z.json());
const bulkPatchItems = z.array(
  z.discriminatedUnion("op", [
    z.strictObject({
      op: z.literal("add"),
      key: z.json(),
      value: z.json().optional(),
    }),
    z.strictObject({ op: z.literal("remove"), key: z.json() }),
  ]),
);

function applyBulkCollectionPatch(
  field: string,
  current: z.infer<ReturnType<typeof z.json>>[],
  identity: "value" | readonly string[],
  patch: z.infer<typeof bulkPatchItems>,
  itemSchema: StructuredValueSchema | undefined,
) {
  // Generated UUIDs and opaque read identities survive writes but do not make
  // the same shared item different on each selected record or on retry.
  const content = (item: z.infer<ReturnType<typeof z.json>>) =>
    itemSchema
      ? entityDetailJson.parse(
          wireValue(
            project(item, itemSchema, { includeHidden: false }),
            itemSchema,
          ),
        )
      : item;
  const keyOf = (item: z.infer<ReturnType<typeof z.json>>) =>
    identity === "value"
      ? canonicalJson(content(item))
      : canonicalJson(
          Object.fromEntries(
            identity.map((key) => [key, jsonRecord.parse(item)[key] ?? null]),
          ),
        );
  let result = [...current];
  for (const operation of patch) {
    const key = keyOf(operation.key);
    if (operation.op === "remove") {
      result = result.filter((item) => keyOf(item) !== key);
      continue;
    }
    const next =
      identity === "value"
        ? operation.key
        : {
            ...jsonRecord.parse(operation.key),
            ...jsonRecord.parse(operation.value ?? {}),
          };
    const existing = result.find((item) => keyOf(item) === key);
    if (existing !== undefined) {
      const comparable =
        identity === "value"
          ? content(existing)
          : Object.fromEntries(
              Object.keys(jsonRecord.parse(next)).map((key) => [
                key,
                jsonRecord.parse(existing)[key] ?? null,
              ]),
            );
      if (
        canonicalJson(comparable) !==
        canonicalJson(identity === "value" ? content(next) : next)
      )
        throw createAppError(
          "COLLECTION_PATCH_PRECONDITION_FAILED",
          `${field} already holds this identity with different values; remove it before adding the changed item.`,
        );
      continue;
    }
    result.push(next);
  }
  return result;
}

/**
 * Resolve bulk list patches and normal value-list patches from authoritative
 * reads in the write transaction. Structured reads project through the normal
 * input description before patching, retaining writable identities and links.
 */
export async function resolveCollectionPatches<
  E extends EntityKernelEntity,
  S extends EntityBindingSchemas,
>(
  context: EntityKernelContext,
  binding: EntityKernelCoreBinding<E, S>,
  id: z.output<S["id"]>,
  data: unknown,
  options: { bulk?: boolean } = {},
): Promise<Map<string, z.infer<ReturnType<typeof z.json>>[]>> {
  const input = record.parse(data);
  const declared: EntityFieldModel["fields"] =
    entityFieldModels[binding.entity].fields;
  const fields = declared.filter(
    (field) =>
      ((options.bulk && field.collection) ||
        field.collection?.key === "value" ||
        field.reference?.multiple === true) &&
      isCollectionPatch(input[field.key]),
  );
  const resolved = new Map<string, z.infer<ReturnType<typeof z.json>>[]>();
  if (fields.length === 0) return resolved;
  const found = await binding.repository.get(context, id);
  // A missing record is the repository's refusal to report.
  if (found === null) return resolved;
  const detail = record.parse(found);
  for (const field of fields) {
    const value = readPathValue(
      detail,
      field.collection?.readPath ??
        field.readKey ??
        field.display.readPath ??
        field.key,
    );
    if (value === undefined)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Cannot patch ${binding.entity}.${field.key}: its authoritative collection read is unavailable.`,
      );
    if (options.bulk) {
      const schema = Object.entries(structuredValueSchemas).find(
        ([key]) => key === `${binding.entity}.${field.key}`,
      )?.[1];
      const current = entityDetailJson.parse(value ?? []);
      const projected = schema
        ? wireValue(project(current, schema), schema)
        : current;
      resolved.set(
        field.key,
        applyBulkCollectionPatch(
          field.key,
          z.array(z.json()).parse(projected),
          field.collection?.key ?? "value",
          bulkPatchItems.parse(input[field.key]),
          schema && "array" in schema.node ? schema.node.array.item : undefined,
        ),
      );
      continue;
    }
    resolved.set(
      field.key,
      applyValueCollectionPatch(
        binding.entity,
        field.key,
        z.array(z.string()).parse(value ?? []),
        valueCollectionPatch.parse(input[field.key]),
      ),
    );
  }
  return resolved;
}
