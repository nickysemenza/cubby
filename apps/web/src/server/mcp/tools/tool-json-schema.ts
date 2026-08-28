import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { type JSONType, z } from "zod";

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

export function requireObjectInputSchema<TInput extends z.ZodObject>(
  toolName: string,
  schema: TInput,
): TInput {
  if (!normalizeObjectSchema(schema)) {
    throw new Error(
      `registerMcpTool(${toolName}): inputSchema must be an object schema. ` +
        "A union, pipe, or other non-object schema advertises the tool as taking no arguments " +
        "and causes the MCP SDK to strip every argument before the handler runs.",
    );
  }
  return schema;
}

export function sdkOutputSchema(schema: z.core.$ZodType): z.ZodType {
  return schema instanceof z.ZodObject ? schema : z.looseObject({});
}

function safeToJsonSchema(
  schema: z.core.$ZodType,
  io: "input" | "output",
): JsonObject {
  try {
    const converted = z.toJSONSchema(schema, {
      target: "draft-7",
      io,
      unrepresentable: "any",
      override: (ctx) => {
        if (ctx.zodSchema._zod.def.type === "date") {
          ctx.jsonSchema.type = "string";
          ctx.jsonSchema.format = "date-time";
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
  const normalized = normalizeObjectSchema(schema);
  if (!(normalized instanceof z.ZodType)) {
    throw new Error(
      `${toolName}: registered ${io} schema is not an object schema, so it cannot be advertised without dropping every field.`,
    );
  }
  return safeToJsonSchema(normalized, io);
}
