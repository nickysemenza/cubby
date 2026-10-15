import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Pure rewrites over the assembled `components.schemas` map. Each pass is one
 * recursive visit plus one predicate, so the emitter reads as a pipeline.
 */

type ZodJsonSchema = z.core.JSONSchema.JSONSchema;
type Structural =
  | "type"
  | "properties"
  | "items"
  | "prefixItems"
  | "additionalProperties"
  | "anyOf"
  | "oneOf"
  | "allOf";
/**
 * Zod's JSON Schema type widened for OpenAPI 3.1: `type` may list several
 * types (`["string", "null"]`) and a union carries a `discriminator`. Every
 * Zod-emitted schema is assignable to it.
 */
export type JsonSchema = Omit<ZodJsonSchema, Structural> & {
  $ref?: string;
  $id?: string;
  $schema?: string;
  $defs?: Record<string, JsonSchema | boolean>;
  definitions?: Record<string, JsonSchema | boolean>;
  description?: string;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  type?: string | string[];
  properties?: Record<string, JsonSchema | boolean>;
  items?: JsonSchema | boolean | (JsonSchema | boolean)[];
  prefixItems?: (JsonSchema | boolean)[];
  additionalProperties?: JsonSchema | boolean;
  anyOf?: (JsonSchema | boolean)[];
  oneOf?: (JsonSchema | boolean)[];
  allOf?: (JsonSchema | boolean)[];
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
};
type Components = Record<string, JsonSchema>;

const COMPONENT_PREFIX = "#/components/schemas/";

/** JSON Schema allows bare booleans; the document never emits them. */
export const isObjectSchema = (
  value: JsonSchema | boolean,
): value is JsonSchema => value !== true && value !== false;

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
 * Deep-stable JSON: object keys sorted at every nesting depth, arrays kept in
 * order, primitives unchanged. `JSON.stringify(value, keys)` looks like it
 * does this when `keys` is an array, but that second argument is actually a
 * property ALLOWLIST applied at every depth, not just the top — so nested
 * objects with different keys (or different key sets nested under `anyOf`)
 * both collapse to `{}` and compare equal even though their shapes differ.
 */
type JsonBody = z.core.util.JSONType;
const jsonRecord = z.record(z.string(), z.json());
const stable = (value: JsonBody): JsonBody => {
  if (Array.isArray(value)) return value.map(stable);
  const record = jsonRecord.safeParse(value);
  return record.success
    ? Object.fromEntries(
        Object.entries(record.data)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, member]) => [key, stable(member)]),
      )
    : value;
};

/**
 * A body's identity up to its own name: a recursive schema references itself
 * by component name, so the name is replaced before comparing.
 */
const canonical = (name: string, schema: JsonSchema): string => {
  const { description: _description, $id: _id, ...rest } = schema;
  return JSON.stringify(stable(z.json().parse(rest))).replaceAll(
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

const isNull = (schema: JsonSchema | boolean): boolean =>
  isObjectSchema(schema) && schema.type === "null";

/** `anyOf`/`oneOf` of exactly one non-null member and `{ type: "null" }`. */
const nullableMember = (schema: JsonSchema): JsonSchema | undefined => {
  const members = schema.anyOf ?? schema.oneOf;
  if (members?.length !== 2) return undefined;
  const other = members.find((member) => !isNull(member));
  return other !== undefined &&
    isObjectSchema(other) &&
    members.some(isNull) &&
    !("discriminator" in schema)
    ? other
    : undefined;
};

/**
 * A component whose whole body is `anyOf: [M, null]` hides the nullability
 * behind a name, where the property rule below cannot see it, so it is
 * inlined at every reference. Runs to a fixed point: one such component may
 * wrap another.
 */
export function inlineNullableComponents(components: Components): Components {
  let current = components;
  for (;;) {
    const inlined = new Map<string, JsonSchema>();
    for (const [name, schema] of Object.entries(current)) {
      const member = nullableMember(schema);
      if (member !== undefined) inlined.set(name, schema);
    }
    if (inlined.size === 0) return current;
    const visit = (node: JsonSchema): JsonSchema => {
      const target = inlined.get(componentName(node.$ref) ?? "");
      if (target === undefined) return node;
      const { $ref: _ref, ...siblings } = node;
      const { $id: _id, $schema: _schema, ...body } = target;
      // The inlined body may itself reference another inlined component,
      // which this iteration deletes, so it is resolved on the way in.
      return mapSchemas({ ...body, ...siblings }, visit);
    };
    current = Object.fromEntries(
      Object.entries(current)
        .filter(([name]) => !inlined.has(name))
        .map(([name, schema]) => [name, mapSchemas(schema, visit)]),
    );
  }
}

const isString = (value: unknown): value is string =>
  z.string().safeParse(value).success;

const hasSingleType = (
  schema: JsonSchema,
): schema is JsonSchema & { type: string } =>
  schema.$ref === undefined &&
  schema.anyOf === undefined &&
  schema.oneOf === undefined &&
  schema.allOf === undefined &&
  schema.enum === undefined &&
  schema.const === undefined &&
  isString(schema.type);

/**
 * `anyOf: [T, null]` for a single-typed T becomes `type: [T, "null"]`, the
 * OpenAPI 3.1 spelling every generator reads as an optional value. Enums,
 * references and unions are left for `optionalNullableProperties`.
 */
export function collapseNullableUnions(components: Components): Components {
  const visit = (node: JsonSchema): JsonSchema => {
    const member = nullableMember(node);
    if (member === undefined || !hasSingleType(member)) return node;
    const { anyOf: _anyOf, oneOf: _oneOf, ...siblings } = node;
    return { ...member, ...siblings, type: [member.type, "null"] };
  };
  return Object.fromEntries(
    Object.entries(components).map(([name, schema]) => [
      name,
      mapSchemas(schema, visit),
    ]),
  );
}

/**
 * A property whose schema is `anyOf: [X, null]` where X is a reference or an
 * enum becomes an optional property of type X. swift-openapi-generator drops a
 * `oneOf [ref, null]` property outright (verified against 1.13.1) and reads
 * `enum: [..., null]` as a bogus empty case, while an optional property whose
 * JSON value is `null` decodes as nil. The server still sends explicit nulls;
 * only the document's `required` list loses the key.
 */
export function optionalNullableProperties(components: Components): Components {
  const visit = (node: JsonSchema): JsonSchema => {
    if (!node.properties) return node;
    const required = new Set(node.required ?? []);
    const properties = Object.fromEntries(
      Object.entries(node.properties).map(([key, value]) => {
        if (!isObjectSchema(value)) return [key, value];
        const member = nullableMember(value);
        if (member === undefined) return [key, value];
        const { anyOf: _anyOf, oneOf: _oneOf, ...siblings } = value;
        required.delete(key);
        return [key, { ...member, ...siblings }];
      }),
    );
    const copy: JsonSchema = { ...node, properties };
    if (node.required !== undefined) copy.required = [...required];
    return copy;
  };
  return Object.fromEntries(
    Object.entries(components).map(([name, schema]) => [
      name,
      mapSchemas(schema, visit),
    ]),
  );
}

/**
 * Every `{ type: "null" }` union member still in the document, as JSON
 * pointers, so a nullability the passes above could not express fails
 * generation instead of silently disappearing from a generated client.
 */
export function residualNullPointers(components: Components): string[] {
  const pointers: string[] = [];
  const walk = (node: JsonSchema | boolean, pointer: string): void => {
    if (!isObjectSchema(node)) return;
    for (const keyword of ["anyOf", "oneOf"] as const)
      if (node[keyword]?.some(isNull)) pointers.push(pointer);
    for (const [key, value] of Object.entries(node.properties ?? {}))
      walk(value, `${pointer}/properties/${key}`);
    if (node.items !== undefined && !Array.isArray(node.items))
      walk(node.items, `${pointer}/items`);
    if (node.additionalProperties !== undefined)
      walk(node.additionalProperties, `${pointer}/additionalProperties`);
    for (const keyword of ["anyOf", "oneOf", "allOf"] as const)
      node[keyword]?.forEach((member, index) =>
        walk(member, `${pointer}/${keyword}/${index}`),
      );
  };
  for (const [name, schema] of Object.entries(components))
    walk(schema, `#/components/schemas/${name}`);
  return pointers;
}

/** The constant a schema's tag property carries, if it is a string. */
const tagOf = (schema: JsonSchema, property: string): string | undefined => {
  const tag = schema.properties?.[property];
  if (!tag || !isObjectSchema(tag)) return undefined;
  const value = tag.const ?? tag.enum?.[0];
  return isString(value) ? value : undefined;
};

/**
 * Fill `discriminator.mapping` for every discriminated union whose members
 * are tagged by a string: each member must be a reference to a component,
 * because a mapping with a hole is worse than none. A union tagged by a
 * boolean or a number keeps a plain `oneOf`: discriminator values are
 * strings in OpenAPI.
 */
export function fillDiscriminatorMappings(components: Components): Components {
  const visit = (node: JsonSchema): JsonSchema => {
    const discriminator = node.discriminator;
    if (!discriminator || !node.oneOf) return node;
    const property = discriminator.propertyName;
    const members = node.oneOf.map((member) => {
      const name = isObjectSchema(member)
        ? componentName(member.$ref)
        : undefined;
      const body = name === undefined ? member : (components[name] ?? member);
      return {
        name,
        tag: isObjectSchema(body) ? tagOf(body, property) : undefined,
      };
    });
    const { discriminator: _discriminator, ...plain } = node;
    if (members.some(({ tag }) => tag === undefined)) return plain;
    const mapping: Record<string, string> = {};
    for (const { name, tag } of members) {
      if (name === undefined || tag === undefined)
        throw new Error(
          `Discriminated union member ${property}=${tag} is not a named component`,
        );
      mapping[tag] = `${COMPONENT_PREFIX}${name}`;
    }
    return { ...node, discriminator: { propertyName: property, mapping } };
  };
  return Object.fromEntries(
    Object.entries(components).map(([name, schema]) => [
      name,
      mapSchemas(schema, visit),
    ]),
  );
}

/** `{ allOf: [X] }` collapses onto X (a 3.0 artefact that 3.1 never needs). */
export function collapseSingleAllOf(components: Components): Components {
  const visit = (node: JsonSchema): JsonSchema => {
    const [only] = node.allOf ?? [];
    if (node.allOf?.length !== 1 || only === undefined || !isObjectSchema(only))
      return node;
    const { allOf: _allOf, ...siblings } = node;
    return { ...only, ...siblings };
  };
  return Object.fromEntries(
    Object.entries(components).map(([name, schema]) => [
      name,
      mapSchemas(schema, visit),
    ]),
  );
}

/**
 * `anyOf: [{ anyOf: [X, null] }, null]` — a `.describe()` on an already
 * nullable schema clones the outer wrapper — flattens onto `anyOf: [X, null]`
 * so the nullability rules see one union. Children are rewritten first, so
 * one visit reaches a fixed point.
 */
export function flattenNestedNullables(components: Components): Components {
  const visit = (node: JsonSchema): JsonSchema => {
    const member = nullableMember(node);
    if (member === undefined || nullableMember(member) === undefined)
      return node;
    const { anyOf: _anyOf, oneOf: _oneOf, ...siblings } = node;
    return { ...member, ...siblings };
  };
  return Object.fromEntries(
    Object.entries(components).map(([name, schema]) => [
      name,
      mapSchemas(schema, visit),
    ]),
  );
}

const refersTo = (schema: JsonSchema | boolean | undefined, name: string) =>
  schema !== undefined &&
  isObjectSchema(schema) &&
  schema.$ref === `${COMPONENT_PREFIX}${name}`;

/** `z.json()`: a union of the scalars, null, and arrays and maps of itself. */
const isJsonValue = (name: string, schema: JsonSchema): boolean =>
  (schema.anyOf ?? []).some(isNull) &&
  (schema.anyOf ?? []).some(
    (member) =>
      isObjectSchema(member) &&
      member.type === "array" &&
      !Array.isArray(member.items) &&
      refersTo(member.items, name),
  ) &&
  (schema.anyOf ?? []).some(
    (member) =>
      isObjectSchema(member) &&
      member.type === "object" &&
      refersTo(member.additionalProperties, name),
  );

/** The recursive JSON value schema `z.json()` builds is named `JsonValue`. */
export function nameJsonValues(components: Components): Components {
  const renames = new Map<string, string>();
  let counter = 0;
  for (const [name, schema] of Object.entries(components))
    if (isPositional(name) && isJsonValue(name, schema)) {
      counter += 1;
      renames.set(name, counter === 1 ? "JsonValue" : `JsonValue${counter}`);
    }
  if (renames.size === 0) return components;
  const visit = (node: JsonSchema): JsonSchema => {
    const target = renames.get(componentName(node.$ref) ?? "");
    return target === undefined
      ? node
      : { ...node, $ref: `${COMPONENT_PREFIX}${target}` };
  };
  // The recursive union is more than a generated client keeps: a member
  // typed `null` is dropped with a warning and the self-reference does not
  // survive it. An empty schema is the same value space and generates as a
  // free-form container.
  const freeForm: JsonSchema = {
    description:
      "Any JSON value: a string, number, boolean, null, array or object.",
  };
  return Object.fromEntries(
    Object.entries(components).map(([name, schema]) => [
      renames.get(name) ?? name,
      renames.has(name) ? freeForm : mapSchemas(schema, visit),
    ]),
  );
}

/** Give Zod's anonymous shared definitions names independent of emission order. */
export function nameStructuralComponents(components: Components): Components {
  const fingerprints = new Map<string, string>();
  const active = new Set<string>();
  const bodies = new Map<string, string>();
  const fingerprint = (name: string): string => {
    const cached = fingerprints.get(name);
    if (cached !== undefined) return cached;
    const schema = components[name];
    if (schema === undefined)
      throw new Error(`Missing OpenAPI component ${name}`);
    if (active.has(name))
      throw new Error(
        `Anonymous OpenAPI component cycle at ${name}; name this schema explicitly`,
      );
    active.add(name);
    const normalized = mapSchemas(schema, (node) => {
      const {
        description: _description,
        $id: _id,
        $schema: _schema,
        ...body
      } = node;
      const referenced = componentName(body.$ref);
      if (referenced !== undefined && isPositional(referenced))
        body.$ref = `${COMPONENT_PREFIX}${fingerprint(referenced)}`;
      return body;
    });
    active.delete(name);
    const body = JSON.stringify(stable(z.json().parse(normalized)));
    const prefix = name.startsWith("input_") ? "InputShared" : "OutputShared";
    const renamed = `${prefix}${createHash("sha256").update(body).digest("hex").slice(0, 16).toUpperCase()}`;
    const collision = bodies.get(renamed);
    if (collision !== undefined && collision !== body)
      throw new Error(
        `OpenAPI structural component hash collision at ${renamed}`,
      );
    bodies.set(renamed, body);
    fingerprints.set(name, renamed);
    return renamed;
  };
  for (const name of Object.keys(components))
    if (isPositional(name)) fingerprint(name);
  const rewrite = (schema: JsonSchema) =>
    mapSchemas(schema, (node) => {
      const referenced = componentName(node.$ref);
      const renamed =
        referenced === undefined ? undefined : fingerprints.get(referenced);
      return renamed === undefined
        ? node
        : { ...node, $ref: `${COMPONENT_PREFIX}${renamed}` };
    });
  const result = new Map<string, JsonSchema>();
  const owners = new Map<string, boolean>();
  for (const [name, schema] of Object.entries(components)) {
    const renamed = fingerprints.get(name) ?? name;
    const anonymous = fingerprints.has(name);
    const rewritten = rewrite(schema);
    const existing = result.get(renamed);
    if (existing !== undefined) {
      if (
        !anonymous ||
        !owners.get(renamed) ||
        JSON.stringify(stable(z.json().parse(existing))) !==
          JSON.stringify(stable(z.json().parse(rewritten)))
      )
        throw new Error(`OpenAPI component name collision at ${renamed}`);
      continue;
    }
    result.set(renamed, rewritten);
    owners.set(renamed, anonymous);
  }
  return Object.fromEntries(result);
}

/**
 * An exhaustive record (`z.record(z.enum([...]), value)`) is emitted with a
 * `required` list and no `properties`; a generated client reads the map
 * through `additionalProperties`, and OpenAPI tooling rejects a required key
 * that no property declares.
 */
export function dropRequiredWithoutProperties(
  components: Components,
): Components {
  const visit = (node: JsonSchema): JsonSchema => {
    if (node.required === undefined || node.properties !== undefined)
      return node;
    const { required: _required, ...rest } = node;
    return rest;
  };
  return Object.fromEntries(
    Object.entries(components).map(([name, schema]) => [
      name,
      mapSchemas(schema, visit),
    ]),
  );
}

/**
 * A property whose only value is `null` (a discriminated-union member that
 * carries `ingredientId: null` to say "no ingredient") has no type a
 * generated client can hold, so it leaves the document: the server still
 * sends the null, which decodes as absent. Recorded on the parent's
 * description so the omission is visible.
 */
export function dropNullOnlyProperties(components: Components): Components {
  const visit = (node: JsonSchema): JsonSchema => {
    if (!node.properties) return node;
    const dropped = Object.entries(node.properties)
      .filter(([, value]) => isObjectSchema(value) && value.type === "null")
      .map(([key]) => key);
    if (dropped.length === 0) return node;
    const properties = Object.fromEntries(
      Object.entries(node.properties).filter(([key]) => !dropped.includes(key)),
    );
    const note = `Always null on the wire: ${dropped.join(", ")}.`;
    const copy: JsonSchema = {
      ...node,
      properties,
      description: node.description ? `${node.description} ${note}` : note,
    };
    if (node.required !== undefined)
      copy.required = node.required.filter((key) => !dropped.includes(key));
    return copy;
  };
  return Object.fromEntries(
    Object.entries(components).map(([name, schema]) => [
      name,
      mapSchemas(schema, visit),
    ]),
  );
}

/**
 * A `z.literal(1)` (a schema version, an algorithm revision) emits
 * `{ type: "number", const: 1 }`, which a generated Swift client types as
 * `Double`. Every whole-number literal or all-integer enum is an integer on
 * the wire, so say so; a non-integer literal keeps `number`.
 */
export function integerLiterals(components: Components): Components {
  const visit = (node: JsonSchema): JsonSchema => {
    if (node.type !== "number") return node;
    const values =
      node.const !== undefined ? [node.const] : (node.enum ?? undefined);
    if (
      values === undefined ||
      values.length === 0 ||
      !values.every((value) => Number.isInteger(value))
    )
      return node;
    return { ...node, type: "integer" };
  };
  return Object.fromEntries(
    Object.entries(components).map(([name, schema]) => [
      name,
      mapSchemas(schema, visit),
    ]),
  );
}

/**
 * Zod 4.2 closes a `z.tuple()` with `items: false` beside `prefixItems`.
 * OpenAPIKit (swift-openapi-generator's parser) rejects a boolean `items`, so
 * the closing keyword is dropped; the tuple stays `prefixItems`-only, which
 * the Swift client already renders as an untyped array.
 */
export function openTupleItems(components: Components): Components {
  const visit = (node: JsonSchema): JsonSchema => {
    if (node.items !== false || node.prefixItems === undefined) return node;
    const { items: _items, ...rest } = node;
    return rest;
  };
  return Object.fromEntries(
    Object.entries(components).map(([name, schema]) => [
      name,
      mapSchemas(schema, visit),
    ]),
  );
}
