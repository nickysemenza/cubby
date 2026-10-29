import { dateTime } from "@cubby/schemas/codec";
/**
 * `entity_read` get/list field selection and the compact preset. Both are
 * generic over the generated MCP output schemas and list-read declarations,
 * so no entity carries a hand-curated field list.
 */
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { z } from "zod";

import {
  listEntities,
  type ListEntity,
} from "~/entity/generated/entity-lists.gen";
import {
  listReadRowSchema,
  type ListReadRow,
} from "~/entity/model/list-read-fields";
import { createAppError } from "~/server/errors/app-error";
import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";
import { listReadSchema } from "~/server/generic/list/repo/list-read-schema";

export type ReadSelection =
  | { kind: "fields"; paths: string[][] }
  | { kind: "compact"; keys: readonly string[] };

/** Image payloads and counters stay out of compact MCP field selections. */
const imagePayloadFields = new Set([
  "displayImages",
  "images",
  "labelImages",
  "itemImageCount",
  "labelImageCount",
  "logo",
  "vendorLogo",
]);

const selectedItem = z.object({ id: z.string() }).passthrough();
/** A get/list result narrowed by `fields` or the compact preset. */
export const entitySelectedResultSchema = z
  .object({
    action: z.enum(["get", "list"]),
    entity: z.string(),
    item: selectedItem.nullable().optional(),
    items: z.array(selectedItem).optional(),
  })
  .passthrough();

const listEntityOf = (entity: string) =>
  listEntities.find((candidate) => candidate === entity);

const boundEntity = (
  entity: string,
): entity is keyof typeof ENTITY_SCHEMA_BINDINGS =>
  Object.hasOwn(ENTITY_SCHEMA_BINDINGS, entity);

/** The published MCP read schema a get/list item is projected through. */
function publishedSchema(entity: string, action: "get" | "list") {
  if (!boundEntity(entity)) return null;
  const binding = ENTITY_SCHEMA_BINDINGS[entity];
  const schema: z.core.$ZodType =
    action === "list" ? binding.mcpList : binding.mcpDetail;
  return schema instanceof z.ZodObject ? schema : null;
}

/** Peel wrappers that do not change the shape of a value. */
function peel(schema: z.core.$ZodType): z.core.$ZodType {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodCatch
  )
    return peel(schema.def.innerType);
  if (schema instanceof z.ZodPipe) return peel(schema.def.in);
  if (schema instanceof z.ZodLazy) return peel(schema.def.getter());
  return schema;
}

/** Peel wrappers that do not change which keys a value can carry. */
function unwrap(schema: z.core.$ZodType): z.core.$ZodType {
  const node = peel(schema);
  // A path through an array addresses every element.
  return node instanceof z.ZodArray ? unwrap(node.def.element) : node;
}

const objectLike = (schema: z.core.$ZodType): boolean => {
  const node = peel(schema);
  if (node instanceof z.ZodUnion) return node.options.some(objectLike);
  return (
    node instanceof z.ZodObject ||
    node instanceof z.ZodRecord ||
    node instanceof z.ZodIntersection
  );
};

/**
 * Whether a read may omit the key, looking through wrappers: Location detail
 * declares `parent` as `z.lazy(() => location.optional())`. A default fills
 * the key, so it is not omittable.
 */
const declaredOptional = (schema: z.core.$ZodType): boolean => {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodUndefined)
    return true;
  if (
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodCatch
  )
    return declaredOptional(schema.def.innerType);
  if (schema instanceof z.ZodLazy) return declaredOptional(schema.def.getter());
  if (schema instanceof z.ZodPipe)
    return declaredOptional(
      schema.def.out instanceof z.ZodTransform ? schema.def.in : schema.def.out,
    );
  if (schema instanceof z.ZodUnion)
    return schema.options.some(declaredOptional);
  return false;
};

/** An array or record of objects: a child collection, empty or not. */
const objectCollection = (schema: z.core.$ZodType): boolean => {
  const node = peel(schema);
  if (node instanceof z.ZodUnion) return node.options.some(objectCollection);
  if (node instanceof z.ZodArray) return objectLike(node.def.element);
  if (node instanceof z.ZodRecord) return objectLike(node.def.valueType);
  return false;
};

/** The schemas published at `key` beneath an object-like schema. */
function childSchemas(schema: z.core.$ZodType, key: string): z.core.$ZodType[] {
  const node = unwrap(schema);
  if (node instanceof z.ZodObject)
    return Object.hasOwn(node.shape, key) ? [node.shape[key]] : [];
  if (node instanceof z.ZodRecord)
    return z.safeParse(node.def.keyType, key).success
      ? [node.def.valueType]
      : [];
  if (node instanceof z.ZodUnion)
    return node.options.flatMap((option) => childSchemas(option, key));
  if (node instanceof z.ZodIntersection)
    return [
      ...childSchemas(node.def.left, key),
      ...childSchemas(node.def.right, key),
    ];
  return [];
}

/** Keys an object-like Zod schema publishes. */
function schemaKeys(schema: z.core.$ZodType): string[] {
  const node = unwrap(schema);
  if (node instanceof z.ZodObject) return Object.keys(node.shape);
  if (node instanceof z.ZodUnion)
    return [...new Set(node.options.flatMap(schemaKeys))];
  if (node instanceof z.ZodIntersection)
    return [
      ...new Set([...schemaKeys(node.def.left), ...schemaKeys(node.def.right)]),
    ];
  return [];
}

/** The first segment of `path` the schema does not publish, with the keys it does. */
function unknownSegment(schema: z.core.$ZodType, path: string[]) {
  let level = [schema];
  for (const [index, key] of path.entries()) {
    const next = level.flatMap((node) => childSchemas(node, key));
    if (next.length === 0)
      return {
        path: path.slice(0, index + 1).join("."),
        expected: [...new Set(level.flatMap(schemaKeys))],
      };
    level = next;
  }
  return null;
}

const fieldModelEntity = (
  entity: string,
): entity is keyof typeof entityFieldModels =>
  Object.hasOwn(entityFieldModels, entity);

/** Declared long free text (notes, markdown): a `textarea` control. */
function longText(entity: string, key: string) {
  if (!fieldModelEntity(entity)) return false;
  const fields: readonly {
    key: string;
    readKey: string | null;
    control: { kind: string } | null;
  }[] = entityFieldModels[entity].fields;
  return fields.some(
    (field) =>
      (field.readKey ?? field.key) === key &&
      field.control?.kind === "textarea",
  );
}

/** A governed field is selected as one complete envelope, including its controls. */
function envelopeSchema(schema: z.core.$ZodType): boolean {
  const node = peel(schema);
  return (
    node instanceof z.ZodObject &&
    ["current", "result", "work"].every((key) => Object.hasOwn(node.shape, key))
  );
}

/** An atomic envelope cannot drop child collections without changing its contract. */
function containsObjectCollection(
  schema: z.core.$ZodType,
  seen = new Set<z.core.$ZodType>(),
): boolean {
  const node = peel(schema);
  if (seen.has(node)) return false;
  seen.add(node);
  if (objectCollection(node)) return true;
  if (node instanceof z.ZodUnion)
    return node.options.some((option) =>
      containsObjectCollection(option, seen),
    );
  return schemaKeys(node).some((key) =>
    childSchemas(node, key).some((child) =>
      containsObjectCollection(child, seen),
    ),
  );
}

/** The canonical public path for a flat repository loading key. */
function publishedPath(schema: z.ZodObject, key: string): string[] | null {
  if (Object.hasOwn(schema.shape, key)) return [key];
  return childSchemas(schema, "fields").some(
    (fields) => childSchemas(fields, key).length > 0,
  )
    ? ["fields", key]
    : null;
}

/** Compact shares declared scalar reads across list and detail, retaining whole envelopes. */
function compactKeys(entity: string): string[] {
  const list = publishedSchema(entity, "list");
  const detail = publishedSchema(entity, "get");
  if (!list || !detail) return [];
  const listEntity = listEntityOf(entity);
  const declared = listEntity
    ? Object.keys(listReadSchema(listEntity).shape)
    : schemaKeys(list);
  return declared.flatMap((key) => {
    if (imagePayloadFields.has(key) || longText(entity, key)) return [];
    const path = publishedPath(list, key);
    if (!path || path.join(".") !== publishedPath(detail, key)?.join("."))
      return [];
    const schemas = [list, detail].flatMap((schema) =>
      path.reduce<z.core.$ZodType[]>(
        (nodes, segment) =>
          nodes.flatMap((node) => childSchemas(node, segment)),
        [schema],
      ),
    );
    return schemas.every(
      (schema) =>
        !declaredOptional(schema) &&
        !objectCollection(schema) &&
        (!envelopeSchema(schema) || !containsObjectCollection(schema)),
    )
      ? [path.join(".")]
      : [];
  });
}

/** The selection a read command asked for, validated against the entity's published schema. */
export function readSelection(command: {
  action: string;
  entity: string;
  resultDetail?: string;
  fields?: string[];
}): ReadSelection | null {
  if (command.action !== "get" && command.action !== "list") return null;
  const published = publishedSchema(command.entity, command.action);
  if (command.fields) {
    const paths = command.fields.map((field) => field.split("."));
    const unknown = paths.flatMap((path) => {
      const miss = published
        ? unknownSegment(published, path)
        : { path: path.join("."), expected: [] };
      return miss ? [miss] : [];
    });
    if (unknown.length > 0)
      throw createAppError(
        "MCP_FIELD_UNKNOWN",
        unknown
          .map(
            (miss) =>
              `Unknown ${command.entity} field "${miss.path}"; expected one of ${miss.expected.join(", ")}`,
          )
          .join("; "),
      );
    return { kind: "fields", paths };
  }
  if (command.resultDetail !== "compact") return null;
  return { kind: "compact", keys: compactKeys(command.entity) };
}

/** List fields to read for a selection, when the progressive list reader can serve it. */
export function selectionListFields(
  entity: ListEntity,
  selection: ReadSelection,
): string[] | null {
  const declared = new Set(Object.keys(listReadSchema(entity).shape));
  const paths =
    selection.kind === "compact"
      ? selection.keys.map((key) => key.split("."))
      : selection.paths;
  const keys = [
    ...new Set(
      paths.flatMap(([head = "", field]) => {
        if (head === "id") return [];
        if (head !== "fields") return [head];
        if (field) return [field];
        const published = publishedSchema(entity, "list");
        return published
          ? childSchemas(published, "fields").flatMap(schemaKeys)
          : [];
      }),
    ),
  ];
  return keys.every((key) => declared.has(key)) ? keys : null;
}

/** A value in a projected read row: JSON plus the dates read schemas emit. */
type SelectedValue =
  | null
  | undefined
  | string
  | number
  | boolean
  | Date
  | SelectedValue[]
  | { [key: string]: SelectedValue };
const selectedValue: z.ZodType<SelectedValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.undefined(),
    z.string(),
    z.number(),
    z.boolean(),
    dateTime,
    z.array(selectedValue),
    z.record(z.string(), selectedValue),
  ]),
);
const selectedObject = z.record(z.string(), selectedValue);
type SelectedObject = z.output<typeof selectedObject>;

/**
 * The part of `value` a path selects, shaped like `value`: an array maps the
 * rest of the path over its elements in order (an element without it reads
 * `{}`), and a null parent reads null. Undefined when the path is absent.
 */
function pick(value: SelectedValue, path: readonly string[]): SelectedValue {
  const [key, ...rest] = path;
  if (key === undefined) return value;
  if (Array.isArray(value))
    return value.map((element) => pick(element, path) ?? {});
  if (value === null) return null;
  const object = selectedObject.safeParse(value);
  if (!object.success || !Object.hasOwn(object.data, key)) return undefined;
  const selected = pick(object.data[key], rest);
  return selected === undefined ? undefined : { [key]: selected };
}

/** Combine two selections of the same value: objects by key, arrays by element. */
function merge(left: SelectedValue, right: SelectedValue): SelectedValue {
  if (Array.isArray(left) && Array.isArray(right))
    return right.map((element, index) => merge(left[index], element));
  const a = selectedObject.safeParse(left);
  const b = selectedObject.safeParse(right);
  if (!a.success || !b.success) return right;
  const merged = { ...a.data };
  for (const [key, value] of Object.entries(b.data))
    merged[key] = Object.hasOwn(merged, key)
      ? merge(merged[key], value)
      : value;
  return merged;
}

/**
 * A compact value: nested objects keep only what the schema publishes beneath
 * them, minus child collections, so a nested `dataQuality` reads as its
 * status and score. Undefined when every candidate schema is a collection.
 */
function compactValue(
  schemas: z.core.$ZodType[],
  value: SelectedValue,
): SelectedValue {
  if (schemas.length === 0 || schemas.some(objectCollection)) return undefined;
  if (schemas.some(envelopeSchema)) return value;
  if (!schemas.some(objectLike)) return value;
  if (value instanceof Date || Array.isArray(value)) return value;
  const object = selectedObject.safeParse(value);
  if (!object.success) return value;
  const output: SelectedObject = {};
  for (const [key, child] of Object.entries(object.data)) {
    const compact = compactValue(
      schemas.flatMap((schema) => childSchemas(schema, key)),
      child,
    );
    if (compact !== undefined) output[key] = compact;
  }
  return output;
}

function selectItem(
  row: ListReadRow,
  selection: ReadSelection,
  published: z.ZodObject,
): ListReadRow {
  if (selection.kind === "compact") {
    const source = selectedObject.parse(row);
    let output: SelectedValue = { id: row.id };
    for (const key of selection.keys) {
      const selected = pick(source, key.split("."));
      if (selected === undefined) continue;
      const compact = compactValue([published], selected);
      if (compact !== undefined) output = merge(output, compact);
    }
    return listReadRowSchema.parse(output);
  }
  const source = selectedObject.parse(row);
  return listReadRowSchema.parse(
    selection.paths.reduce<SelectedValue>(
      (output, path) => merge(output, pick(source, path) ?? {}),
      { id: row.id },
    ),
  );
}

const projectable = z
  .object({
    action: z.enum(["get", "list"]),
    entity: z.string(),
    item: z.unknown().optional(),
    items: z.array(z.unknown()).optional(),
  })
  .passthrough();

/**
 * Project a get/list kernel result to the selection. Rows pass through the
 * published MCP read schema first (the projection `resultDetail: "full"`
 * returns), so a selection never exposes storage-only keys that schema strips.
 */
export function projectSelection(result: unknown, selection: ReadSelection) {
  const parsed = projectable.parse(result);
  const published = publishedSchema(parsed.entity, parsed.action);
  if (!published)
    throw new Error(
      `${parsed.entity} publishes no MCP ${parsed.action} schema to select from`,
    );
  // Field-selected list reads load only the selected columns, so every key is
  // optional, including the governed-field roster; each present envelope stays
  // complete. Rebuild from the shape: `.partial()` throws on refined objects,
  // and object-level refinements check whole records, not selections.
  const row = z
    .object(
      Object.fromEntries(
        Object.entries(published.shape).map(([key, value]) => [
          key,
          key === "fields" && value instanceof z.ZodObject
            ? z
                .object(
                  Object.fromEntries(
                    Object.entries(value.shape).map(([field, envelope]) => [
                      field,
                      envelope.optional(),
                    ]),
                  ),
                )
                .optional()
            : value.optional(),
        ]),
      ),
    )
    .pipe(listReadRowSchema);
  const select = (raw: unknown) =>
    selectItem(row.parse(raw), selection, published);
  return {
    ...parsed,
    ...(parsed.items ? { items: parsed.items.map(select) } : {}),
    ...(parsed.item ? { item: select(parsed.item) } : {}),
  };
}
