import { type JSONType, z } from "zod";

import { toWire } from "~/lib/http-api/wire";

type JsonObject = Extract<JSONType, { [key: string]: JSONType }>;

const EMPTY_OBJECT_JSON_SCHEMA = {
  type: "object",
  properties: {},
} satisfies JsonObject;

function isJsonObject(value: JSONType): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function stripMockMetadata(value: JSONType): JSONType {
  if (Array.isArray(value)) return value.map(stripMockMetadata);
  if (!isJsonObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "mock")
      .map(([key, entry]) => [key, stripMockMetadata(entry)]),
  );
}

export function stripMockFromJsonSchema(schema: JsonObject): JsonObject {
  const stripped = stripMockMetadata(schema);
  if (!isJsonObject(stripped)) {
    throw new Error("A JSON Schema root must be an object");
  }
  return stripped;
}

export function sdkOutputSchema(schema: z.core.$ZodType): z.ZodType {
  // The SDK normalizer returns undefined for non-object outputs, then its
  // validator crashes while parsing structured content. This guard prevents
  // the regression that took out union-returning `list_problems` in #341;
  // response validation still uses the real schema.
  return schema instanceof z.ZodObject ? schema : z.looseObject({});
}

export function safeToJsonSchema(
  schema: z.core.$ZodType,
  io: "input" | "output",
): JsonObject {
  try {
    if (!(schema instanceof z.ZodType)) {
      throw new Error("Expected a Zod schema instance for the wire walker");
    }
    // `toWire` already turns every `z.date()` into `z.iso.datetime()`
    // (`format: "date-time"`), so there is no separate date override here —
    // one walk decides the wire shape for both the HTTP contract and the
    // MCP-advertised JSON Schema.
    const converted = z.toJSONSchema(toWire(schema, io), {
      target: "draft-7",
      // Repeated entity outputs otherwise expand the catalog into megabytes
      // that ChatGPT rejects during discovery. References retain constraints.
      reused: io === "output" ? "ref" : "inline",
      io,
      unrepresentable: "any",
      override: ({ jsonSchema }) => {
        // Clients validate tool schemas as 2020-12, where `items` is one
        // schema; a draft-7 tuple (`items: [...]`) made them reject the whole
        // tool. Publish a tuple as an array of its member schemas bounded to
        // its length: valid in both drafts, and the response is still parsed
        // with the exact Zod tuple.
        if (Array.isArray(jsonSchema.items)) {
          const prefix = jsonSchema.items;
          const rest = jsonSchema.additionalItems;
          const members =
            rest === undefined || rest === true || rest === false
              ? prefix
              : [...prefix, rest];
          // `anyOf` takes object schemas; `true`/`false` are `{}`/`{not: {}}`.
          const asObject = (member: (typeof members)[number]) =>
            member === true ? {} : member === false ? { not: {} } : member;
          jsonSchema.items =
            members.length === 0
              ? (rest ?? true)
              : members.length === 1
                ? members[0]
                : { anyOf: members.map(asObject) };
          if (prefix.length > 0) jsonSchema.minItems = prefix.length;
          if (rest === false) jsonSchema.maxItems = prefix.length;
          delete jsonSchema.additionalItems;
        }
      },
    });
    const parsed = z.json().parse(converted);
    if (!isJsonObject(parsed)) {
      throw new Error("A generated JSON Schema root must be an object");
    }
    const stripped = stripMockFromJsonSchema(parsed);
    return io === "output" && stripped.type === undefined
      ? { ...stripped, type: "object" }
      : stripped;
  } catch {
    return { type: "object", additionalProperties: true };
  }
}

export function advertisedJsonSchema(
  toolName: string,
  schema: z.core.$ZodType | undefined,
  io: "input" | "output",
): JsonObject {
  if (!schema) return EMPTY_OBJECT_JSON_SCHEMA;
  if (io === "output") return safeToJsonSchema(schema, io);
  if (!(schema instanceof z.ZodType)) {
    throw new Error(
      `${toolName}: registered input schema is not a Zod schema.`,
    );
  }
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(
      `${toolName}: registered ${io} schema is not an object schema, so it cannot be advertised without dropping every field.`,
    );
  }
  return safeToJsonSchema(schema, io);
}
