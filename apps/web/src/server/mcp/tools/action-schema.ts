import type { JSONType } from "zod";

type JsonObject = Extract<JSONType, { [key: string]: JSONType }>;

/**
 * The published input JSON Schema of a multi-action tool.
 *
 * A tool takes `{ action, ...input }`, but a union at the schema ROOT is not
 * portable: Anthropic's API rejects `anyOf`/`oneOf`/`allOf` at the top level
 * of `input_schema`, and a non-object root makes the MCP SDK advertise no
 * arguments. So the root stays one object: `action` is a required enum, and
 * every other property is the union of what the actions declare for that
 * name, each alternative labelled with the actions (and discriminating
 * `entity` values) it belongs to. Exact per-action validation happens
 * server-side against the action's own schema; the published schema is the
 * agent's map, not the gate.
 *
 * Subtrees repeated across actions (a kind's `data` schema in both `create`
 * and `commands`) are hoisted into `definitions` once, because every mounted
 * tool schema is resent on every model call.
 */

export interface ActionInputSchema {
  name: string;
  description: string;
  schema: JsonObject;
}

const HOIST_MIN_CHARS = 600;
const ROOT_KEYS = new Set(["action", "_runExecution"]);

function isObject(value: JSONType | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value: JSONType | undefined): value is string {
  return typeof value === "string";
}

function asObjects(value: JSONType | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

const canonical = (value: JSONType): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
    .join(",")}}`;
};

function rewriteRefs(value: JSONType, rename: Map<string, string>): JSONType {
  if (Array.isArray(value))
    return value.map((item) => rewriteRefs(item, rename));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key === "$ref" && isText(entry)) {
        const name = entry.split("/").at(-1) ?? "";
        const renamed = rename.get(name);
        return [key, renamed ? `#/definitions/${renamed}` : entry];
      }
      return [key, rewriteRefs(entry, rename)];
    }),
  );
}

type Leaf = { properties: JsonObject; required: string[] };

/** Every object alternative of a (possibly unioned or intersected) schema. */
function leaves(schema: JsonObject): Leaf[] {
  const alternatives = [...asObjects(schema.anyOf), ...asObjects(schema.oneOf)];
  if (alternatives.length > 0 && !isObject(schema.properties))
    return alternatives.flatMap(leaves);
  const parts = asObjects(schema.allOf);
  if (parts.length > 0) {
    const own: Leaf = {
      properties: isObject(schema.properties) ? schema.properties : {},
      required: Array.isArray(schema.required)
        ? schema.required.filter(isText)
        : [],
    };
    return parts.reduce<Leaf[]>(
      (combined, part) =>
        combined.flatMap((left) =>
          leaves(part).map((right) => ({
            properties: { ...left.properties, ...right.properties },
            required: [...new Set([...left.required, ...right.required])],
          })),
        ),
      [own],
    );
  }
  return [
    {
      properties: isObject(schema.properties) ? schema.properties : {},
      required: Array.isArray(schema.required)
        ? schema.required.filter(isText)
        : [],
    },
  ];
}

/** `entity=product`-style labels from a leaf's single-valued discriminators. */
function discriminators(leaf: Leaf): string {
  return Object.entries(leaf.properties)
    .filter(([key]) => !ROOT_KEYS.has(key))
    .flatMap(([key, value]) => {
      if (!isObject(value)) return [];
      if (isText(value.const)) return [`${key}=${value.const}`];
      if (
        Array.isArray(value.enum) &&
        value.enum.length === 1 &&
        isText(value.enum[0])
      )
        return [`${key}=${value.enum[0]}`];
      return [];
    })
    .join(" ");
}

function stringValues(schema: JsonObject): string[] | null {
  const extra = Object.keys(schema).filter(
    (key) => !["type", "const", "enum", "description"].includes(key),
  );
  if (extra.length > 0 || schema.type !== "string") return null;
  if (isText(schema.const)) return [schema.const];
  if (Array.isArray(schema.enum) && schema.enum.every(isText))
    return schema.enum.filter(isText);
  return null;
}

const withNote = (schema: JsonObject, note: string): JsonObject => ({
  ...schema,
  description: isText(schema.description)
    ? `${schema.description} (${note})`
    : note,
});

function mergeProperty(
  variants: Array<{ schema: JsonObject; label: string; action: string }>,
  actionCount: number,
): JsonObject {
  const actions = new Set(variants.map((variant) => variant.action));
  const scope =
    actions.size === actionCount ? "" : `action: ${[...actions].join(", ")}`;
  const values = variants.map((variant) => stringValues(variant.schema));
  if (values.every((value) => value !== null)) {
    const merged = [...new Set(values.flat())];
    const base: JsonObject = { type: "string", enum: merged };
    const described = variants.find((variant) =>
      isText(variant.schema.description),
    )?.schema.description;
    if (isText(described)) base.description = described;
    return scope ? withNote(base, scope) : base;
  }
  const unique = new Map<string, { schema: JsonObject; labels: string[] }>();
  for (const variant of variants) {
    const key = canonical(variant.schema);
    const existing = unique.get(key);
    if (existing) existing.labels.push(variant.label);
    else unique.set(key, { schema: variant.schema, labels: [variant.label] });
  }
  if (unique.size === 1) {
    const [only] = unique.values();
    return scope ? withNote(only!.schema, scope) : only!.schema;
  }
  // The label wraps the alternative instead of editing it, so an alternative
  // repeated elsewhere (a kind's `data` inside `commands[]`) stays identical
  // and is hoisted once.
  return {
    anyOf: [...unique.values()].map(({ schema, labels }) => ({
      description: `for ${[...new Set(labels)].join("; ")}`,
      allOf: [schema],
    })),
  };
}

/**
 * Replace every subtree of at least `HOIST_MIN_CHARS` that occurs more than
 * once with a `$ref` to one `definitions` entry. One counting pass and one
 * top-down replacement pass: a replaced subtree's own children are not
 * visited, so the largest repeat wins.
 */
function hoistRepeats(root: JsonObject): JsonObject {
  const texts = new WeakMap<object, string>();
  const textOf = (value: JSONType): string => {
    if (!isObject(value) && !Array.isArray(value)) return JSON.stringify(value);
    const cached = texts.get(value);
    if (cached !== undefined) return cached;
    const text = Array.isArray(value)
      ? `[${value.map(textOf).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${textOf(value[key]!)}`)
          .join(",")}}`;
    texts.set(value, text);
    return text;
  };
  const definitions: JsonObject = isObject(root.definitions)
    ? root.definitions
    : {};
  const counts = new Map<string, { count: number; value: JsonObject }>();
  // Only a SCHEMA position may become a `$ref`: a `properties` map or an
  // `enum` list is not a schema, so its entries are walked by their role.
  const walk = (
    value: JSONType,
    role: "schema" | "map" | "other",
    visit: (schema: JsonObject) => void,
  ): void => {
    if (role === "map") {
      if (isObject(value))
        for (const entry of Object.values(value)) walk(entry, "schema", visit);
      return;
    }
    if (role === "other" || !isObject(value)) return;
    visit(value);
    for (const [key, entry] of Object.entries(value)) {
      if (SCHEMA_MAP_KEYS.has(key)) walk(entry, "map", visit);
      else if (SCHEMA_LIST_KEYS.has(key) || key === "items") {
        if (Array.isArray(entry))
          for (const item of entry) walk(item, "schema", visit);
        else walk(entry, "schema", visit);
      } else if (SCHEMA_KEYS.has(key)) walk(entry, "schema", visit);
    }
  };
  const countSchema = (schema: JsonObject) => {
    const text = textOf(schema);
    if (text.length < HOIST_MIN_CHARS) return;
    const entry = counts.get(text);
    if (entry) entry.count += 1;
    else counts.set(text, { count: 1, value: schema });
  };
  walk(root.properties ?? {}, "map", countSchema);
  for (const definition of Object.values(definitions))
    walk(definition, "schema", countSchema);
  const chosen = new Map<string, string>();
  for (const [text, entry] of counts)
    if (entry.count > 1) chosen.set(text, `shared${chosen.size}`);
  if (chosen.size === 0) return root;
  const replace = (
    value: JSONType,
    role: "schema" | "map" | "other",
    isDefinitionRoot = false,
  ): JSONType => {
    if (role === "map")
      return isObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [
              key,
              replace(entry, "schema"),
            ]),
          )
        : value;
    if (role === "other" || !isObject(value)) return value;
    const name = isDefinitionRoot ? undefined : chosen.get(textOf(value));
    if (name) return { $ref: `#/definitions/${name}` };
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (SCHEMA_MAP_KEYS.has(key)) return [key, replace(entry, "map")];
        if (SCHEMA_LIST_KEYS.has(key) || key === "items")
          return [
            key,
            Array.isArray(entry)
              ? entry.map((item) => replace(item, "schema"))
              : replace(entry, "schema"),
          ];
        if (SCHEMA_KEYS.has(key)) return [key, replace(entry, "schema")];
        return [key, entry];
      }),
    );
  };
  const hoisted: JsonObject = Object.fromEntries(
    Object.entries(definitions).map(([key, definition]) => [
      key,
      replace(definition, "schema", true),
    ]),
  );
  for (const [text, name] of chosen)
    hoisted[name] = replace(counts.get(text)!.value, "schema", true);
  return {
    ...root,
    properties: replace(root.properties ?? {}, "map"),
    definitions: hoisted,
  };
}

/** Keys whose value is a name → schema map. */
const SCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependencies",
]);
/** Keys whose value is a list of schemas. */
const SCHEMA_LIST_KEYS = new Set(["anyOf", "oneOf", "allOf"]);
/** Keys whose value is one schema. */
const SCHEMA_KEYS = new Set([
  "additionalProperties",
  "additionalItems",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
]);

export function mergeActionInputSchemas(
  actions: readonly ActionInputSchema[],
  extraProperties: JsonObject = {},
): JsonObject {
  const definitions: JsonObject = {};
  const variants = new Map<
    string,
    Array<{ schema: JsonObject; label: string; action: string }>
  >();
  for (const action of actions) {
    // Each action's schema carries its own `definitions`; a name reused with
    // a different body is renamed so the merged document stays sound.
    const rename = new Map<string, string>();
    const own = isObject(action.schema.definitions)
      ? action.schema.definitions
      : {};
    for (const [name, definition] of Object.entries(own)) {
      const existing = definitions[name];
      if (
        existing === undefined ||
        canonical(existing) === canonical(definition)
      )
        continue;
      rename.set(name, `${name}_${action.name}`);
    }
    const schema = rewriteRefs(action.schema, rename);
    if (!isObject(schema)) continue;
    for (const [name, definition] of Object.entries(own))
      definitions[rename.get(name) ?? name] = rewriteRefs(definition, rename);
    for (const leaf of leaves(schema)) {
      const label = [action.name, discriminators(leaf)]
        .filter(Boolean)
        .join(" ");
      for (const [key, value] of Object.entries(leaf.properties)) {
        if (ROOT_KEYS.has(key) || !isObject(value)) continue;
        const list = variants.get(key) ?? [];
        list.push({ schema: value, label, action: action.name });
        variants.set(key, list);
      }
    }
  }
  const properties: JsonObject = {
    action: {
      type: "string",
      enum: actions.map((action) => action.name),
      description:
        "Which action to run; the tool description says what each does.",
    },
  };
  for (const [key, list] of variants)
    properties[key] = mergeProperty(list, actions.length);
  Object.assign(properties, extraProperties);
  return hoistRepeats({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties,
    required: ["action"],
    definitions,
  });
}

/**
 * The fields an action always needs, for its line in the tool description —
 * including the root `_runExecution` envelope when the action's writer
 * requires it, since the merged root can only publish it as optional.
 */
export function requiredFields(schema: JsonObject): string[] {
  return leaves(schema)
    .map((leaf) => leaf.required.filter((key) => key !== "action"))
    .reduce((common, keys) => common.filter((key) => keys.includes(key)));
}
