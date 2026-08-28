import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { usdaContract } from "@cubby/usda-contract";
import { z } from "zod";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(scriptDir, "../src/generated/openapi.json");

type JsonSchema = z.core.JSONSchema.JSONSchema;
type JsonSchemaValue = z.core.JSONSchema._JSONSchema;

interface OpenApiParameter {
  name: string;
  in: "path" | "query";
  required: boolean;
  schema: JsonSchemaValue;
}

interface OpenApiResponse {
  description: string;
  content: { "application/json": { schema: JsonSchema } };
}

interface OpenApiOperation {
  operationId: string;
  summary?: string;
  responses: Map<string, OpenApiResponse>;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required: true;
    content: { "application/json": { schema: JsonSchema } };
  };
}

interface SerializedOpenApiOperation {
  operationId: string;
  summary?: string;
  responses: Record<string, OpenApiResponse>;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiOperation["requestBody"];
}

function schema(value: z.ZodType): JsonSchema {
  return z.toJSONSchema(value, {
    target: "draft-2020-12",
    unrepresentable: "any",
  });
}

function parameters(
  value: z.ZodObject,
  location: "path" | "query",
): OpenApiParameter[] {
  const json = schema(value);
  const properties = json.properties ?? {};
  const required = new Set(json.required ?? []);
  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: location,
    required: location === "path" || required.has(name),
    schema: propertySchema,
  }));
}

function responseDescription(status: string): string {
  if (status.startsWith("2")) return "Successful response";
  if (status === "404") return "Not found";
  return "Error response";
}

const routes = [
  ["counts", usdaContract.counts],
  ["getFood", usdaContract.getFood],
  ["findByLookup", usdaContract.findByLookup],
  ["findByLookupBatch", usdaContract.findByLookupBatch],
  ["listFoods", usdaContract.listFoods],
] as const;

const paths = new Map<string, Map<string, OpenApiOperation>>();
for (const [operationId, route] of routes) {
  const openApiPath = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  const operation: OpenApiOperation = {
    operationId,
    summary: route.summary,
    responses: new Map(
      Object.entries(route.responses).map(([status, responseSchema]) => [
        status,
        {
          description: responseDescription(status),
          content: {
            "application/json": { schema: schema(responseSchema) },
          },
        },
      ]),
    ),
  };

  const routeParameters = [
    ...("pathParams" in route ? parameters(route.pathParams, "path") : []),
    ...("query" in route ? parameters(route.query, "query") : []),
  ];
  if (routeParameters.length > 0) operation.parameters = routeParameters;
  if ("body" in route) {
    operation.requestBody = {
      required: true,
      content: { "application/json": { schema: schema(route.body) } },
    };
  }

  const pathOperations = paths.get(openApiPath) ?? new Map();
  pathOperations.set(route.method.toLowerCase(), operation);
  paths.set(openApiPath, pathOperations);
}

function serializeOperation(
  operation: OpenApiOperation,
): SerializedOpenApiOperation {
  const serialized: SerializedOpenApiOperation = {
    operationId: operation.operationId,
    summary: operation.summary,
    responses: Object.fromEntries(operation.responses),
  };
  if (operation.parameters) serialized.parameters = operation.parameters;
  if (operation.requestBody) serialized.requestBody = operation.requestBody;
  return serialized;
}

const serializedPaths = Object.fromEntries(
  Array.from(paths, ([pathName, operations]) => [
    pathName,
    Object.fromEntries(
      Array.from(operations, ([method, operation]) => [
        method,
        serializeOperation(operation),
      ]),
    ),
  ]),
);

const document = {
  openapi: "3.1.0",
  info: {
    title: "USDA Food Data Central API",
    version: "1.0.0",
    description:
      "USDA FoodData Central search, lookup, nutrition, and portion data used by Cubby.",
  },
  servers: [
    {
      url: "/",
      description: "Current USDA API origin",
    },
  ],
  paths: serializedPaths,
};

const formatted = spawnSync(
  "pnpm",
  ["exec", "oxfmt", "--stdin-filepath", outputPath],
  { input: `${JSON.stringify(document, null, 2)}\n`, encoding: "utf8" },
);
if (formatted.status !== 0 || !formatted.stdout) {
  throw new Error(`Failed to format OpenAPI document: ${formatted.stderr}`);
}
const rendered = formatted.stdout;
if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== rendered) {
    console.error("Generated OpenAPI document is out of date");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, rendered);
  console.log(`Wrote ${path.relative(process.cwd(), outputPath)}`);
}
