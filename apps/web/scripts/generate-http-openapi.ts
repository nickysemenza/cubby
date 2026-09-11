import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { generateOpenApi } from "@ts-rest/open-api";
import { z } from "zod";
import { httpContract } from "../src/lib/generated/http-contract.gen";
import { httpSchemaSources } from "../src/lib/http-api/contract";

const registries = {
  input: z.registry<{ id: string }>(),
  output: z.registry<{ id: string }>(),
};
const document = generateOpenApi(
  httpContract,
  {
    info: { title: "Cubby API", version: "1.0.0" },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      },
    },
    security: [{ apiKey: [] }],
  },
  {
    setOperationId: "concatenated-path",
    schemaTransformer: ({ schema, concatenatedPath, type }) => {
      if (schema === undefined || schema === null) return null;
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
      return { $ref: `#/components/schemas/${id}` };
    },
  },
);
const components: Record<string, z.core.JSONSchema.JSONSchema> = {};
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
