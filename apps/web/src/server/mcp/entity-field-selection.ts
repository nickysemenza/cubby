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

/** Top-level keys an object-like Zod schema can publish. */
function schemaKeys(schema: z.core.$ZodType): string[] {
  if (schema instanceof z.ZodObject) return Object.keys(schema.shape);
  if (schema instanceof z.ZodUnion)
    return [...new Set(schema.options.flatMap(schemaKeys))];
  if (schema instanceof z.ZodIntersection)
    return [
      ...new Set([
        ...schemaKeys(schema.def.left),
        ...schemaKeys(schema.def.right),
      ]),
    ];
  if (schema instanceof z.ZodPipe) return schemaKeys(schema.def.in);
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  )
    return schemaKeys(schema.def.innerType);
  return [];
}

const allowedKeys = (entity: string, action: "get" | "list") => {
  if (!boundEntity(entity)) return [];
  const binding = ENTITY_SCHEMA_BINDINGS[entity];
  return schemaKeys(action === "list" ? binding.mcpList : binding.mcpDetail);
};

/** The selection a read command asked for, validated against the entity's published keys. */
export function readSelection(command: {
  action: string;
  entity: string;
  resultDetail?: string;
  fields?: string[];
}): ReadSelection | null {
  if (command.action !== "get" && command.action !== "list") return null;
  if (command.fields) {
    const allowed = allowedKeys(command.entity, command.action);
    const paths = command.fields.map((field) => field.split("."));
    const unknown = paths
      .map(([head = ""]) => head)
      .filter((head) => !allowed.includes(head));
    if (unknown.length > 0)
      throw createAppError(
        "MCP_FIELD_UNKNOWN",
        `Unknown ${command.entity} field ${unknown.map((key) => `"${key}"`).join(", ")}; expected one of ${allowed.join(", ")}`,
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
      : allowedKeys(command.entity, command.action),
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
    item: listReadRowSchema.nullable().optional(),
    items: z.array(listReadRowSchema).optional(),
  })
  .passthrough();

/** Project a get/list kernel result to the selection. */
export function projectSelection(result: unknown, selection: ReadSelection) {
  const parsed = projectable.parse(result);
  return {
    ...parsed,
    ...(parsed.items
      ? { items: parsed.items.map((row) => selectItem(row, selection)) }
      : {}),
    ...(parsed.item ? { item: selectItem(parsed.item, selection) } : {}),
  };
}
