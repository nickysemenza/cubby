import { z } from "zod";

import type {
  StructuredField,
  StructuredNode,
  StructuredOption,
  StructuredValueSchema,
} from "../../../../packages/schemas/src/structured-value-schema.ts";

export type ValueSchemaJSON = StructuredValueSchema;
type NodeJSON = StructuredNode;
type FieldJSON = StructuredField;
type OptionJSON = StructuredOption;

/** Resolves an entity from a shortcode prefix such as `ING-`; null when no entity owns it. */
export type EntityForPrefix = (prefix: string) => string | null;

/** The JSON Schema keywords `z.toJSONSchema` emits for an input type that this reads. */
type JsonSchema = {
  $ref?: string | undefined;
  type?: string | string[] | undefined;
  anyOf?: JsonSchema[] | undefined;
  oneOf?: JsonSchema[] | undefined;
  properties?: Record<string, JsonSchema> | undefined;
  required?: string[] | undefined;
  items?: JsonSchema | undefined;
  enum?: z.core.util.JSONType[] | undefined;
  const?: z.core.util.JSONType | undefined;
  pattern?: string | undefined;
  format?: string | undefined;
  readFrom?: string | undefined;
  opaque?: boolean | undefined;
  propertyNames?: { enum?: z.core.util.JSONType[] | undefined } | undefined;
  additionalProperties?: JsonSchema | undefined;
};
const jsonSchema: z.ZodType<JsonSchema> = z.lazy(() =>
  z.object({
    $ref: z.string().optional(),
    type: z.union([z.string(), z.array(z.string())]).optional(),
    anyOf: z.array(jsonSchema).optional(),
    oneOf: z.array(jsonSchema).optional(),
    properties: z.record(z.string(), jsonSchema).optional(),
    required: z.array(z.string()).optional(),
    items: jsonSchema.optional(),
    enum: z.array(z.json()).optional(),
    const: z.json().optional(),
    pattern: z.string().optional(),
    format: z.string().optional(),
    readFrom: z.string().optional(),
    opaque: z.boolean().optional(),
    propertyNames: z.object({ enum: z.array(z.json()).optional() }).optional(),
    // `false` (a strict object) carries no schema to read.
    additionalProperties: z
      .union([z.boolean().transform(() => undefined), jsonSchema])
      .optional(),
  }),
);

/** `externalId` -> `External id`; `saturated_fat` -> `Saturated fat`. */
const humanize = (raw: string) => {
  const words = raw
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll(/([a-z]{2})(\d)/gu, "$1 $2")
    .replaceAll(/[_-]+/gu, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const options = (values: readonly z.core.util.JSONType[] = []): OptionJSON[] =>
  values.flatMap((value) => {
    const parsed = z.string().safeParse(value);
    return parsed.success
      ? [{ value: parsed.data, label: humanize(parsed.data) }]
      : [];
  });

const CALENDAR_DAY = String.raw`^\d{4}-\d{2}-\d{2}$`;
const SHORTCODE_PREFIX = /^\^([A-Z]+-)\[/u;
const TEXT_FORMATS = z.enum(["uri", "uuid", "email"]);

const textNode = (
  schema: JsonSchema,
  entityForPrefix: EntityForPrefix,
): NodeJSON => {
  // Carried untouched and never shown (`.meta({ opaque: true })`): a claim's identity key.
  if (schema.opaque === true) return { text: { format: "opaque" } };
  const pattern = schema.pattern ?? "";
  if (pattern === CALENDAR_DAY) return { text: { format: "date" } };
  const entity = entityForPrefix(SHORTCODE_PREFIX.exec(pattern)?.[1] ?? "");
  if (entity !== null) return { reference: { entity } };
  const format = TEXT_FORMATS.safeParse(schema.format);
  return { text: { format: format.success ? format.data : null } };
};

type Context = { where: string; entityForPrefix: EntityForPrefix };

const fieldsOf = (
  schema: JsonSchema,
  skip: string | null,
  context: Context,
): FieldJSON[] => {
  const required = new Set(schema.required);
  return Object.entries(schema.properties ?? {})
    .filter(([key]) => key !== skip)
    .map(([key, property]) => {
      const field = {
        key,
        label: humanize(key),
        required: required.has(key),
        schema: convert(property, {
          ...context,
          where: `${context.where}.${key}`,
        }),
      };
      return property.readFrom === undefined
        ? field
        : { ...field, readPath: property.readFrom };
    });
};

const isAmount = (schema: JsonSchema) => {
  const properties = schema.properties ?? {};
  const keys = Object.keys(properties).sort().join();
  return (
    (keys === "unit,value" || keys === "unit,upperValue,value") &&
    properties.value?.type === "number" &&
    properties.unit?.type === "string"
  );
};

/** A union of objects that share one literal key (`kind: "cash"`), told apart by it. */
const variantNode = (branches: JsonSchema[], context: Context): NodeJSON => {
  const discriminator = Object.keys(branches[0]?.properties ?? {}).find((key) =>
    branches.every(
      (branch) => z.string().safeParse(branch.properties?.[key]?.const).success,
    ),
  );
  if (discriminator === undefined)
    throw new Error(
      `${context.where}: a union is only describable as a variant over a shared literal key.`,
    );
  return {
    variant: {
      discriminator,
      cases: branches.map((branch) => {
        const tag = z.string().parse(branch.properties?.[discriminator]?.const);
        return {
          value: tag,
          label: humanize(tag),
          fields: fieldsOf(branch, discriminator, context),
        };
      }),
    },
  };
};

const objectNode = (schema: JsonSchema, context: Context): NodeJSON => {
  if (
    schema.propertyNames !== undefined &&
    schema.additionalProperties !== undefined
  )
    return {
      map: {
        keys: options(schema.propertyNames.enum),
        value: convert(schema.additionalProperties, {
          ...context,
          where: `${context.where}{}`,
        }),
      },
    };
  if (isAmount(schema))
    return { amount: { upper: schema.properties?.upperValue !== undefined } };
  return { object: { fields: fieldsOf(schema, null, context) } };
};

const unsupported = (context: Context, why: string): never => {
  throw new Error(
    `${context.where}: ${why}; the native structured editor cannot describe it. Add the case to value-schema.ts.`,
  );
};

const scalarNode = (
  type: string,
  schema: JsonSchema,
  context: Context,
): NodeJSON => {
  switch (type) {
    case "string":
      return textNode(schema, context.entityForPrefix);
    case "number":
      return { number: { integer: false } };
    case "integer":
      return { number: { integer: true } };
    case "boolean":
      return { boolean: {} };
    case "array":
      return {
        array: {
          item: convert(schema.items, {
            ...context,
            where: `${context.where}[]`,
          }),
        },
      };
    case "object":
      return objectNode(schema, context);
    default:
      return unsupported(context, `a ${type} value`);
  }
};

const convertUnion = (branches: JsonSchema[], context: Context) => {
  const live = branches.filter((branch) => branch.type !== "null");
  const nullable = live.length < branches.length;
  const [only] = live;
  if (live.length === 1 && only !== undefined)
    return { ...convert(only, context), nullable };
  return { nullable, node: variantNode(live, context) };
};

const convert = (
  raw: JsonSchema | undefined,
  context: Context,
): ValueSchemaJSON => {
  if (raw === undefined) return unsupported(context, "a missing item type");
  if (raw.$ref !== undefined) return unsupported(context, "a recursive type");
  const branches = raw.anyOf ?? raw.oneOf;
  if (branches !== undefined) return convertUnion(branches, context);

  const types = Array.isArray(raw.type) ? raw.type : [raw.type];
  const nullable = types.includes("null");
  const type = types.find((candidate) => candidate !== "null");
  if (raw.const !== undefined)
    return { nullable, node: { constant: { value: raw.const } } };
  if (type === undefined)
    return nullable
      ? { nullable, node: { constant: { value: null } } }
      : unsupported(context, "an untyped value");
  if (raw.enum !== undefined)
    return { nullable, node: { enum: { options: options(raw.enum) } } };
  return { nullable, node: scalarNode(type, raw, context) };
};

/**
 * The description of the value a client sends for `schema` (a field's create/update input).
 * Throws on anything it cannot describe — a transform, a custom check with no JSON form, a
 * recursive type — so a new structured field fails `pnpm generate` instead of silently losing
 * its editor.
 */
export const valueSchemaOf = (
  schema: z.ZodType,
  where: string,
  entityForPrefix: EntityForPrefix,
): ValueSchemaJSON =>
  convert(
    jsonSchema.parse(
      z.toJSONSchema(schema, {
        io: "input",
        target: "draft-2020-12",
        unrepresentable: "any",
      }),
    ),
    { where, entityForPrefix },
  );
