import type { z } from "zod";

/**
 * Pure rewrites over the assembled `components.schemas` map. Each pass is one
 * recursive visit plus one predicate, so the emitter reads as a pipeline.
 */

export type JsonSchema = z.core.JSONSchema.JSONSchema;
type Components = Record<string, JsonSchema>;

const COMPONENT_PREFIX = "#/components/schemas/";

/** JSON Schema allows bare booleans; the document never emits them. */
const isObjectSchema = (value: JsonSchema | boolean): value is JsonSchema =>
  value !== true && value !== false;

const componentName = (ref: string | undefined): string | undefined =>
  ref?.startsWith(COMPONENT_PREFIX)
    ? ref.slice(COMPONENT_PREFIX.length)
    : undefined;

/** Rewrite every schema node, children first. */
export function mapSchemas(
  schema: JsonSchema,
  visit: (node: JsonSchema) => JsonSchema,
): JsonSchema {
  const copy: JsonSchema = { ...schema };
  if (copy.properties)
    copy.properties = Object.fromEntries(
      Object.entries(copy.properties).map(([key, value]) => [
        key,
        isObjectSchema(value) ? mapSchemas(value, visit) : value,
      ]),
    );
  if (
    copy.additionalProperties !== undefined &&
    isObjectSchema(copy.additionalProperties)
  )
    copy.additionalProperties = mapSchemas(copy.additionalProperties, visit);
  if (
    copy.items !== undefined &&
    !Array.isArray(copy.items) &&
    isObjectSchema(copy.items)
  )
    copy.items = mapSchemas(copy.items, visit);
  if (copy.prefixItems)
    copy.prefixItems = copy.prefixItems.map((item) =>
      isObjectSchema(item) ? mapSchemas(item, visit) : item,
    );
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const members = copy[keyword];
    if (members)
      copy[keyword] = members.map((member) =>
        isObjectSchema(member) ? mapSchemas(member, visit) : member,
      );
  }
  return visit(copy);
}

const isPositional = (name: string) =>
  /^(?:input|output)_schema\d+$/u.test(name);

/** A body with no structure of its own: a primitive, enum or pattern. */
const isPrimitive = (schema: JsonSchema): boolean =>
  schema.$ref === undefined &&
  schema.properties === undefined &&
  schema.items === undefined &&
  schema.prefixItems === undefined &&
  schema.anyOf === undefined &&
  schema.oneOf === undefined &&
  schema.allOf === undefined &&
  schema.additionalProperties === undefined;

/**
 * Positional components that are bare primitives (`{ type: "string" }`, an
 * enum, a pattern) are inlined where they are referenced: a generated client
 * would otherwise mint a named alias for every shared `z.string()`.
 */
export function inlinePrimitiveComponents(components: Components): Components {
  const inlined = new Map<string, JsonSchema>();
  for (const [name, schema] of Object.entries(components))
    if (isPositional(name) && isPrimitive(schema)) inlined.set(name, schema);
  const visit = (node: JsonSchema): JsonSchema => {
    const target = inlined.get(componentName(node.$ref) ?? "");
    if (target === undefined) return node;
    const { $ref: _ref, ...siblings } = node;
    return { ...target, ...siblings };
  };
  return Object.fromEntries(
    Object.entries(components)
      .filter(([name]) => !inlined.has(name))
      .map(([name, schema]) => [name, mapSchemas(schema, visit)]),
  );
}

/**
 * A body's identity up to its own name: a recursive schema references itself
 * by component name, so the name is replaced before comparing.
 */
const canonical = (name: string, schema: JsonSchema): string => {
  const { description: _description, $id: _id, ...rest } = schema;
  return JSON.stringify(rest, Object.keys(rest).sort()).replaceAll(
    `"${COMPONENT_PREFIX}${name}"`,
    '"#self"',
  );
};

/**
 * A positional component whose body equals a named component (a `.describe()`
 * at a use site clones the schema, which loses the export's identity) folds
 * onto the named one, and one that equals an earlier positional folds onto
 * that (`z.json()` mints a fresh recursive schema per call). Runs to a fixed
 * point because folding one can make another equal.
 */
export function foldPositionalDuplicates(components: Components): Components {
  let current = components;
  for (;;) {
    const survivors = new Map<string, string>();
    const folded = new Map<string, string>();
    // Named components first, so a positional always folds onto a name when
    // one exists; then positionals in emission order.
    const ordered = Object.entries(current).sort(
      ([a], [b]) => Number(isPositional(a)) - Number(isPositional(b)),
    );
    for (const [name, schema] of ordered) {
      const key = canonical(name, schema);
      const target = survivors.get(key);
      if (target !== undefined && isPositional(name)) folded.set(name, target);
      else if (!survivors.has(key)) survivors.set(key, name);
    }
    if (folded.size === 0) return current;
    const visit = (node: JsonSchema): JsonSchema => {
      const target = folded.get(componentName(node.$ref) ?? "");
      return target === undefined
        ? node
        : { ...node, $ref: `${COMPONENT_PREFIX}${target}` };
    };
    current = Object.fromEntries(
      Object.entries(current)
        .filter(([name]) => !folded.has(name))
        .map(([name, schema]) => [name, mapSchemas(schema, visit)]),
    );
  }
}
