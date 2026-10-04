import type {
  StructuredField,
  StructuredJson,
  StructuredValueSchema,
} from "@cubby/schemas/structured-value-schema";
import { z } from "zod";

/**
 * The editor model for a structured field's value, driven by its generated `StructuredValueSchema`:
 * the pure operations the one generic structured-value editor needs, none of them per entity or per
 * field. The server stays the only validator; this only keeps a value shaped like the input schema
 * (so a read payload can round-trip into a patch) and starts new rows. It mirrors CubbyKit's
 * `StructuredValue`; `golden-vectors/structured-roundtrip.json` pins both to the same
 * read-to-input results.
 */
type Json = StructuredJson;
type JsonObject = { readonly [key: string]: Json };

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isList = (value: Json | undefined): value is readonly Json[] =>
  Array.isArray(value);

const AMOUNT_KEYS = ["value", "unit"];
const RANGE_AMOUNT_KEYS = ["value", "unit", "upperValue"];

const valueAt = (path: readonly string[], root: Json): Json | undefined => {
  let current: Json | undefined = root;
  for (const step of path) {
    if (!isObject(current)) return undefined;
    current = current[step];
  }
  return current;
};

/** The case of a variant value that its discriminator names, or undefined. */
const caseOf = <
  Case extends {
    readonly value: string;
    readonly fields: readonly StructuredField[];
  },
>(
  value: JsonObject,
  discriminator: string,
  cases: readonly Case[],
) => {
  const tag = z.string().safeParse(value[discriminator]);
  const match = tag.success
    ? cases.find((candidate) => candidate.value === tag.data)
    : undefined;
  return tag.success && match !== undefined ? { tag: tag.data, match } : null;
};

/**
 * A key the read payload does not carry at its own name is read from the field's `readPath` (the
 * nested record a flat input id names), and a required key the schema fixes (a union's `null` arm)
 * is written as that constant, so a read line is exactly the input line.
 */
const projectFields = (
  object: JsonObject,
  fields: readonly StructuredField[],
) =>
  Object.fromEntries(
    fields.flatMap((field) => {
      const child = object[field.key];
      if (child !== undefined)
        return [[field.key, project(child, field.schema)]];
      const found =
        field.readPath === undefined
          ? undefined
          : valueAt(field.readPath.split("."), object);
      if (found !== undefined && found !== null)
        return [[field.key, project(found, field.schema)]];
      return field.required && "constant" in field.schema.node
        ? [[field.key, field.schema.node.constant.value]]
        : [];
    }),
  );

/**
 * `value` clipped to what `schema` declares. A read payload carries keys the input schema rejects
 * (a mapping's `sourceMetadata`, timestamps); sending them back would fail a strict schema and make
 * an untouched row look edited. Hidden keys the schema declares (`id`, a claim's `sourceKey`) stay,
 * so an untouched row keeps its identity.
 */
export function project(value: Json, schema: StructuredValueSchema): Json {
  const { node } = schema;
  if ("amount" in node) {
    const keys = node.amount.upper ? RANGE_AMOUNT_KEYS : AMOUNT_KEYS;
    return isObject(value)
      ? Object.fromEntries(
          Object.entries(value).filter(([key]) => keys.includes(key)),
        )
      : value;
  }
  if ("object" in node)
    return isObject(value) ? projectFields(value, node.object.fields) : value;
  if ("array" in node)
    return isList(value)
      ? value.map((item) => project(item, node.array.item))
      : value;
  if ("map" in node) {
    if (!isObject(value)) return value;
    const allowed = new Set(node.map.keys.map((key) => key.value));
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => allowed.has(key))
        .map(([key, item]) => [key, project(item, node.map.value)]),
    );
  }
  if ("variant" in node) {
    if (!isObject(value)) return value;
    const chosen = caseOf(
      value,
      node.variant.discriminator,
      node.variant.cases,
    );
    return chosen === null
      ? value
      : {
          ...projectFields(value, chosen.match.fields),
          [node.variant.discriminator]: chosen.tag,
        };
  }
  return value;
}

const blankFields = (fields: readonly StructuredField[]) =>
  Object.fromEntries(
    fields
      .filter((field) => field.required)
      .map((field) => [field.key, blank(field.schema)]),
  );

/** A variant value of `match`, carrying its tag and required keys. */
export function blankCase(
  discriminator: string,
  match: {
    readonly value: string;
    readonly fields: readonly StructuredField[];
  },
) {
  return { ...blankFields(match.fields), [discriminator]: match.value };
}

/**
 * What a new row or newly added object starts as. Only required keys are present; text is empty
 * and a number unset, so an unfilled row is rejected by the server rather than guessed. A nullable
 * schema starts `null` unless `populated`, and a variant starts `null` (no case chosen): the
 * person picks one, never a default the editor guessed.
 */
export function blank(schema: StructuredValueSchema, populated = false): Json {
  if (schema.nullable && !populated) return null;
  const { node } = schema;
  if ("text" in node) return "";
  if ("boolean" in node) return false;
  if ("enum" in node) return node.enum.options[0]?.value ?? null;
  if ("amount" in node) return { value: null, unit: "" };
  if ("constant" in node) return node.constant.value;
  if ("object" in node) return blankFields(node.object.fields);
  if ("array" in node) return [];
  if ("map" in node) return {};
  // A number or reference is unset; a variant has no case chosen.
  return null;
}

type Normalized = Json | undefined;

/**
 * What an unfilled value becomes: `null` where the schema takes it, as typed where the key is
 * required, otherwise absent.
 */
const unfilled = (
  schema: StructuredValueSchema,
  required: boolean,
  typed: Json,
): Normalized => {
  if (schema.nullable) return null;
  return required ? typed : undefined;
};

const normalizeFields = (
  object: JsonObject,
  fields: readonly StructuredField[],
) =>
  Object.fromEntries(
    fields.flatMap((field) => {
      const child = object[field.key];
      if (child === undefined) return [];
      const wire = normalize(child, field.schema, field.required);
      return wire === undefined ? [] : [[field.key, wire]];
    }),
  );

const normalizeAmount = (
  value: JsonObject,
  schema: StructuredValueSchema,
  required: boolean,
): Normalized => {
  const { upperValue, ...rest } = value;
  // The range end is optional and not nullable: an emptied one is absent.
  const object = upperValue === null ? rest : value;
  const quantity = object.value;
  return quantity === undefined || quantity === null
    ? unfilled(schema, required, object)
    : object;
};

function normalize(
  value: Json,
  schema: StructuredValueSchema,
  required: boolean,
): Normalized {
  if (value === null) return unfilled(schema, required, null);
  const { node } = schema;
  if ("text" in node)
    return value === "" ? unfilled(schema, required, value) : value;
  if ("amount" in node)
    return isObject(value) ? normalizeAmount(value, schema, required) : value;
  if ("object" in node)
    return isObject(value) ? normalizeFields(value, node.object.fields) : value;
  if ("array" in node) {
    if (!isList(value)) return value;
    // An empty optional list is absent (the input says `.min(1).optional()`).
    if (value.length === 0 && !required)
      return unfilled(schema, required, value);
    return value.map(
      (entry) => normalize(entry, node.array.item, true) ?? null,
    );
  }
  if ("map" in node) {
    if (!isObject(value)) return value;
    // A map's present keys are its rows: an emptied one is removed, never sent as `null`.
    return Object.fromEntries(
      Object.entries(value)
        .map(
          ([key, entry]) =>
            [key, normalize(entry, node.map.value, true) ?? null] as const,
        )
        .filter(([, entry]) => entry !== null),
    );
  }
  if ("variant" in node) {
    if (!isObject(value)) return value;
    const chosen = caseOf(
      value,
      node.variant.discriminator,
      node.variant.cases,
    );
    return chosen === null
      ? value
      : {
          ...normalizeFields(value, chosen.match.fields),
          [node.variant.discriminator]: chosen.tag,
        };
  }
  return value;
}

/**
 * The value the editor sends: an unfilled optional text/number is left out (or `null` where the
 * schema takes `null`). A required one is kept as typed so the server's rejection, not a silent
 * omission, tells the person what to fill.
 */
export function wireValue(value: Json, schema: StructuredValueSchema): Json {
  return normalize(value, schema, true) ?? null;
}

/** Whether the editor draws a control for this schema: a fixed constant and an opaque id are carried, never shown. */
export function isDrawn(schema: StructuredValueSchema): boolean {
  const { node } = schema;
  if ("constant" in node) return false;
  if ("text" in node)
    return node.text.format !== "uuid" && node.text.format !== "opaque";
  return true;
}
