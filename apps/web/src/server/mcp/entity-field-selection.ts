/**
 * `entity_read` get/list field selection and the compact preset. Both are
 * generic over the generated MCP output schemas and list-read declarations,
 * so no entity carries a hand-curated field list.
 */
import { z } from "zod";

import {
  listEntities,
  type ListEntity,
} from "~/entity/generated/entity-lists.gen";
import {
  listReadRowSchema,
  type ListReadRow,
} from "~/entity/model/list-read-fields";
import { listReadFields } from "~/entity/model/list-read-schema";
import { createAppError } from "~/server/errors/app-error";
import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";

export type ReadSelection =
  | { kind: "fields"; paths: string[][] }
  | { kind: "compact"; keys: readonly string[] };

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

/** Peel wrappers that do not change which keys a value can carry. */
function unwrap(schema: z.core.$ZodType): z.core.$ZodType {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodCatch
  )
    return unwrap(schema.def.innerType);
  if (schema instanceof z.ZodPipe) return unwrap(schema.def.in);
  if (schema instanceof z.ZodLazy) return unwrap(schema.def.getter());
  // A path through an array addresses every element.
  if (schema instanceof z.ZodArray) return unwrap(schema.def.element);
  return schema;
}

/** The schemas published at `key` beneath an object-like schema. */
function childSchemas(schema: z.core.$ZodType, key: string): z.core.$ZodType[] {
  const node = unwrap(schema);
  if (node instanceof z.ZodObject)
    return Object.hasOwn(node.shape, key) ? [node.shape[key]] : [];
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
  const listEntity = listEntityOf(command.entity);
  return {
    kind: "compact",
    // Media URLs and image rows are the bulk of a list row; compact omits them.
    keys: listEntity
      ? (["core", "relations", "derived", "quality"] as const).flatMap(
          (group) => listReadFields(listEntity)[group],
        )
      : published
        ? schemaKeys(published)
        : [],
  };
}

/** List fields to read for a selection, when the progressive list reader can serve it. */
export function selectionListFields(
  entity: ListEntity,
  selection: ReadSelection,
): string[] | null {
  const declared = new Set(Object.values(listReadFields(entity)).flat());
  const keys =
    selection.kind === "compact"
      ? [...selection.keys]
      : [...new Set(selection.paths.map(([head = ""]) => head))].filter(
          (key) => key !== "id",
        );
  return keys.every((key) => declared.has(key)) ? keys : null;
}

const isChildCollection = (value: ListReadRow[string]) =>
  Array.isArray(value) &&
  value.some((entry) => typeof entry === "object" && entry !== null);

const nested = listReadRowSchema.omit({ id: true });
type NestedRow = z.infer<typeof nested>;

function selectItem(row: ListReadRow, selection: ReadSelection): ListReadRow {
  const output: ListReadRow = { id: row.id };
  if (selection.kind === "compact") {
    for (const key of selection.keys)
      if (Object.hasOwn(row, key) && !isChildCollection(row[key]))
        output[key] = row[key];
    return output;
  }
  for (const path of selection.paths) {
    let source: ListReadRow[string] = row;
    for (const key of path) {
      const parsed = nested.safeParse(source);
      source = parsed.success ? parsed.data[key] : undefined;
    }
    if (source === undefined) continue;
    let target: NestedRow = output;
    for (const key of path.slice(0, -1)) {
      const parsed = nested.safeParse(target[key]);
      const next = parsed.success ? parsed.data : {};
      target[key] = next;
      target = next;
    }
    target[path.at(-1) ?? ""] = source;
  }
  return output;
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
  // Field-selected list reads load only the selected columns.
  const row = published.partial().pipe(listReadRowSchema);
  const select = (raw: unknown) => selectItem(row.parse(raw), selection);
  return {
    ...parsed,
    ...(parsed.items ? { items: parsed.items.map(select) } : {}),
    ...(parsed.item ? { item: select(parsed.item) } : {}),
  };
}
