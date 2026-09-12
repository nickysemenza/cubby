import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { generateOpenApi, type SchemaTransformerSync } from "@ts-rest/open-api";
import { z } from "zod";
import { getCookies } from "better-auth/cookies";
import { httpContract } from "../src/lib/generated/http-contract.gen";
import { httpMetadataSchema } from "../src/lib/http-api/router";
import { checkHttpRoutes } from "../src/lib/http-api/routes";
import { wireRegistry } from "../src/lib/http-api/wire";

checkHttpRoutes(httpContract);

type JsonSchema = z.core.JSONSchema.JSONSchema;
// JSON Schema allows bare booleans; OpenAPI parameters need object schemas.
const isObjectSchema = (value: JsonSchema | boolean): value is JsonSchema =>
  value !== true && value !== false;
const registries = {
  input: z.registry<{ id: string }>(),
  output: z.registry<{ id: string }>(),
};
const responseStatus = (route: { responses: object }, schema: z.ZodType) =>
  Object.entries(route.responses).find(([, value]) => value === schema)?.[0];

/** Every route schema is real Zod, so the JSON Schema comes straight from it. */
const inlineSchema = (schema: z.ZodType, io: "input" | "output") =>
  z.toJSONSchema(schema, {
    target: "openapi-3.0",
    io,
    reused: "inline",
    unrepresentable: "any",
    override: stripMockHints,
  });

const stripMockHints: NonNullable<
  Parameters<typeof z.toJSONSchema>[1]
>["override"] = ({ jsonSchema }) => {
  delete jsonSchema.mock;
  delete jsonSchema.mockValue;
  if (jsonSchema.nullable && !jsonSchema.type) {
    const { nullable: _nullable, ...inner } = jsonSchema;
    for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
    jsonSchema.anyOf = [
      inner,
      { type: "string", nullable: true, enum: [null] },
    ];
  }
};

/**
 * Query parameters must be listed individually, so a query schema is inlined
 * as one object; a union of objects (the entity list) merges its variants into
 * a single object whose members are required only when every variant needs
 * them.
 */
function parameterObject(schema: JsonSchema): JsonSchema {
  const variants = (schema.oneOf ?? schema.anyOf ?? [schema]).map((variant) =>
    isObjectSchema(variant) ? variant : {},
  );
  if (variants.some((variant) => variant.type !== "object"))
    throw new Error("HTTP query parameters must be objects");
  const names = new Set(
    variants.flatMap((variant) => Object.keys(variant.properties ?? {})),
  );
  return {
    type: "object",
    required: [...names].filter((name) =>
      variants.every((variant) => variant.required?.includes(name)),
    ),
    properties: Object.fromEntries(
      [...names].map((name) => {
        const schemas = variants.flatMap((variant) => {
          const property = variant.properties?.[name];
          return property !== undefined && isObjectSchema(property)
            ? [property]
            : [];
        });
        const [single] = schemas;
        return [
          name,
          schemas.length === 1 && single !== undefined
            ? single
            : { anyOf: schemas },
        ];
      }),
    ),
  };
}

// SAFETY: Zod emits OpenAPI 3.0 schemas; its broader JSON Schema type also
// permits booleans, which no route schema produces.
const asSchemaObject = (schema: JsonSchema) =>
  schema as NonNullable<ReturnType<SchemaTransformerSync>>;

const document = generateOpenApi(
  httpContract,
  {
    info: { title: "Cubby API", version: "1.0.0" },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: getCookies({}).sessionToken.name,
        },
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
    security: [{ apiKey: [] }, { sessionCookie: [] }, { bearerAuth: [] }],
  },
  {
    setOperationId: "concatenated-path",
    jsonQuery: true,
    operationMapper: (operation, route) => {
      const metadata = httpMetadataSchema.parse(route.metadata);
      operation.tags = [metadata.entity ?? metadata.operation.split(".")[0]!];
      if (metadata.resource === "list")
        operation.description =
          "Use page=1&pageSize=20&sort=name,-createdAt. Filters are individual query parameters; plain strings stay literal and every other value is JSON-encoded. Response pagination metadata remains zero-based. Resource methods depend on entity capabilities.";
      if (metadata.resource === "create") {
        const response = operation.responses[201];
        if (response && !("$ref" in response))
          response.headers = {
            Location: {
              schema: { type: "string" },
              description: "Created resource URL",
            },
          };
      }
      return operation;
    },
    schemaTransformer: ({ schema, appRoute, concatenatedPath, type }) => {
      if (!(schema instanceof z.ZodType)) return null;
      if (type === "query" || type === "path")
        return asSchemaObject(parameterObject(inlineSchema(schema, "input")));
      const io = type === "response" ? "output" : "input";
      const registry = registries[io];
      const suffix =
        type === "response" ? `_${responseStatus(appRoute, schema) ?? ""}` : "";
      // Names: a wire schema derived from a `.meta({ id })` domain schema, a
      // schema that carries its own `.meta({ id })`, or the route position.
      const id =
        registry.get(schema)?.id ??
        wireRegistry.get(schema)?.id ??
        z.globalRegistry.get(schema)?.id ??
        `${io}_${concatenatedPath}_${type}${suffix}`;
      if (!registry.has(schema)) registry.add(schema, { id });
      return { $ref: `#/components/schemas/${id}` };
    },
  },
);

const components: Record<string, JsonSchema> = {};
for (const io of ["input", "output"] as const) {
  const { schemas } = z.toJSONSchema(registries[io], {
    target: "openapi-3.0",
    io,
    reused: "ref",
    unrepresentable: "any",
    uri: (id) =>
      `#/components/schemas/${id === "__shared" ? `${io}___shared` : id}`,
    override: stripMockHints,
  });
  for (const [id, schema] of Object.entries(schemas)) {
    if (id === "__shared") {
      for (const [name, definition] of Object.entries(schema.definitions ?? {}))
        components[`${io}_${name}`] = definition;
    } else components[id] = schema;
  }
}

const serialized = `${JSON.stringify(
  { ...document, components: { ...document.components, schemas: components } },
  (key, value) => {
    if (key === "$id") return undefined;
    if (key === "$ref")
      return z
        .string()
        .parse(value)
        .replace(/(input|output)___shared#\/definitions\//u, "$1_");
    return value;
  },
  2,
)}\n`;
const path = new URL(
  "../src/lib/generated/http-openapi.gen.json",
  import.meta.url,
);
const formatted = spawnSync(
  "pnpm",
  ["exec", "oxfmt", "--stdin-filepath", path.pathname],
  { input: serialized, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
if (formatted.status !== 0) throw new Error(formatted.stderr);
const output = formatted.stdout;
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== output)
    throw new Error(
      "HTTP OpenAPI is stale; run pnpm --filter @cubby/web generate:http-api",
    );
} else writeFileSync(path, output);
console.log(`HTTP OpenAPI: ${Object.keys(document.paths).length} operations`);
