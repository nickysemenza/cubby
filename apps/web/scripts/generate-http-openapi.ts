import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ContractNoBody } from "@ts-rest/core";
import { generateOpenApi, type SchemaTransformerSync } from "@ts-rest/open-api";
import { z } from "zod";
import { getCookies } from "better-auth/cookies";
import { checkHttpRoutes } from "../src/lib/http-api/routes";
import { httpContract } from "../src/lib/generated/http-contract.gen";
import {
  httpSchemaSources,
  httpMetadataSchema,
} from "../src/lib/http-api/contract";

const registries = {
  input: z.registry<{ id: string }>(),
  output: z.registry<{ id: string }>(),
};
checkHttpRoutes(httpContract);
const components: Record<string, z.core.JSONSchema.JSONSchema> = {};
interface ParameterSchema {
  $ref?: string;
  nullable?: boolean;
  type?: string | string[];
  allOf?: ParameterSchema[];
  anyOf?: ParameterSchema[];
  oneOf?: ParameterSchema[];
}
function scalarParameter(schema: ParameterSchema): boolean {
  if (schema.nullable) return false;
  if (schema.$ref) {
    const key = schema.$ref
      .replace("#/components/schemas/", "")
      .replace(/(input|output)___shared#\/definitions\//u, "$1_");
    const resolved = components[key];
    return resolved !== undefined && scalarParameter(resolved);
  }
  const variants = schema.anyOf ?? schema.oneOf ?? schema.allOf;
  return variants
    ? variants.every(scalarParameter)
    : z.enum(["string", "number", "integer", "boolean"]).safeParse(schema.type)
        .success;
}
const makeDocument = () =>
  generateOpenApi(
    httpContract,
    {
      info: { title: "Cubby API", version: "1.0.0" },
      servers: [{ url: "/" }],
      components: {
        securitySchemes: {
          apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
          bearerAuth: { type: "http", scheme: "bearer" },
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: getCookies({}).sessionToken.name,
          },
        },
      },
      security: [{ apiKey: [] }, { bearerAuth: [] }, { sessionCookie: [] }],
    },
    {
      setOperationId: "concatenated-path",
      jsonQuery: true,
      operationMapper: (operation, route) => {
        const metadata = z
          .object({ http: httpMetadataSchema })
          .parse(route.metadata).http;
        operation.tags = [metadata.entity ?? metadata.operation.split(".")[0]!];
        if (metadata.mode === "list") {
          operation.description =
            "Use page=1&pageSize=20&sort=name,-createdAt. Filters are individual query parameters; arrays and objects use JSON. Response pagination metadata remains zero-based. Resource methods depend on entity capabilities.";
          for (const parameter of operation.parameters ?? []) {
            if ("$ref" in parameter || parameter.in !== "query") continue;
            const schema = parameter.content?.["application/json"]?.schema;
            if (schema && scalarParameter(schema)) {
              parameter.schema = schema;
              parameter.style = "form";
              parameter.explode = true;
              delete parameter.content;
            }
          }
        }
        if (metadata.mode === "create") {
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
      schemaTransformer: ({ schema, concatenatedPath, type }) => {
        if (
          schema === undefined ||
          schema === null ||
          schema === ContractNoBody
        )
          return null;
        if (!(schema instanceof z.ZodType))
          throw new Error("HTTP contracts require runtime Zod schemas");
        const source = httpSchemaSources.get(schema) ?? {
          schema,
          io: "output" as const,
        };
        const registry = registries[source.io];
        const id =
          registry.get(source.schema)?.id ??
          `${source.io}_${concatenatedPath}_${type}`;
        if (!registry.has(source.schema)) registry.add(source.schema, { id });
        if (type === "query" || type === "path") {
          const root = components[id];
          if (!root) return { type: "object", properties: {} };
          const resolve = (
            value: z.core.JSONSchema.JSONSchema,
          ): z.core.JSONSchema.JSONSchema => {
            if (!value.$ref) return value;
            const key = value.$ref
              .replace("#/components/schemas/", "")
              .replace(/(input|output)___shared#\/definitions\//u, "$1_");
            const resolved = components[key];
            if (!resolved) throw new Error(`Missing parameter schema ${key}`);
            return resolve(resolved);
          };
          const resolved = resolve(root);
          const variants = (resolved.oneOf ?? resolved.anyOf ?? [resolved]).map(
            resolve,
          );
          if (variants.some((variant) => variant.type !== "object"))
            throw new Error(`Parameters must be objects: ${id}`);
          const names = new Set(
            variants.flatMap((variant) =>
              Object.keys(variant.properties ?? {}),
            ),
          );
          // SAFETY: Zod emits OpenAPI 3.0 schemas; its broader JSON Schema type also permits booleans.
          return {
            type: "object",
            required: [...names].filter((name) =>
              variants.every((variant) => variant.required?.includes(name)),
            ),
            properties: Object.fromEntries(
              [...names].map((name) => {
                const schemas = variants.flatMap((variant) =>
                  variant.properties?.[name] ? [variant.properties[name]] : [],
                );
                return [
                  name,
                  schemas.length === 1 ? schemas[0] : { anyOf: schemas },
                ];
              }),
            ),
          } as NonNullable<ReturnType<SchemaTransformerSync>>;
        }
        return { $ref: `#/components/schemas/${id}` };
      },
    },
  );
makeDocument();
for (const io of ["input", "output"] as const) {
  const { schemas } = z.toJSONSchema(registries[io], {
    target: "openapi-3.0",
    io,
    reused: "ref",
    unrepresentable: "any",
    uri: (id) =>
      `#/components/schemas/${id === "__shared" ? `${io}___shared` : id}`,
    override: ({ zodSchema, jsonSchema, path }) => {
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
      const type = zodSchema._zod.def.type;
      if (
        zodSchema._zod.def.type === "literal" &&
        zodSchema._zod.def.values.some(
          (value) => !z.json().safeParse(value).success,
        )
      )
        throw new Error("HTTP literals must be JSON values");
      if (type === "date") {
        if (
          io === "input" &&
          !(zodSchema instanceof z.ZodDate && zodSchema.def.coerce)
        )
          throw new Error(
            `HTTP input dates must accept ISO strings with z.coerce.date(): ${path.join(".")}`,
          );
        jsonSchema.type = "string";
        jsonSchema.format = "date-time";
      } else if (
        [
          "custom",
          "function",
          "promise",
          "file",
          "bigint",
          "symbol",
          "map",
          "set",
          "nan",
          "undefined",
          "void",
        ].includes(type)
      )
        throw new Error(`HTTP schema contains unsupported ${type}`);
      else if (type === "transform" && io === "output")
        throw new Error("HTTP output transforms need a concrete output schema");
    },
  });
  for (const [id, schema] of Object.entries(schemas)) {
    if (id === "__shared") {
      for (const [name, definition] of Object.entries(schema.definitions ?? {}))
        components[`${io}_${name}`] = definition;
    } else components[id] = schema;
  }
}
const document = makeDocument();
// Parameter roots are inlined by OpenAPI; retain only components reachable from the document.
const references = (
  value: ReturnType<typeof generateOpenApi> | z.core.JSONSchema.JSONSchema,
) =>
  [
    ...JSON.stringify(value).matchAll(
      /"\$ref":"#\/components\/schemas\/([^" ]+)"/gu,
    ),
  ].map((match) =>
    match[1]!.replace(/(input|output)___shared#\/definitions\//u, "$1_"),
  );
const reachable = new Set<string>();
const pending = references(document);
for (const name of pending) {
  if (reachable.has(name)) continue;
  reachable.add(name);
  const schema = components[name];
  if (!schema) throw new Error(`Unresolved HTTP component ${name}`);
  pending.push(...references(schema));
}
for (const name of Object.keys(components))
  if (!reachable.has(name)) delete components[name];

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
