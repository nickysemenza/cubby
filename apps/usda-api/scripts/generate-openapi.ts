import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { usdaContract } from "@cubby/usda-contract";
import { z } from "zod";

interface ContractRoute {
  method: string;
  path: string;
  summary?: string;
  body?: unknown;
  query?: unknown;
  pathParams?: unknown;
  responses: Record<string, unknown>;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(scriptDir, "../src/generated/openapi.json");

function schema(value: unknown): Record<string, unknown> {
  if (!(value instanceof z.ZodType)) return {};
  return z.toJSONSchema(value, {
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as Record<string, unknown>;
}

function parameters(
  value: unknown,
  location: "path" | "query",
): Array<Record<string, unknown>> {
  const json = schema(value);
  const properties = (json.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = new Set(
    Array.isArray(json.required) ? (json.required as string[]) : [],
  );
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

const paths: Record<string, Record<string, unknown>> = {};
for (const [operationId, route] of Object.entries(
  usdaContract as unknown as Record<string, ContractRoute>,
)) {
  const openApiPath = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  const operation: Record<string, unknown> = {
    operationId,
    summary: route.summary,
    responses: Object.fromEntries(
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
    ...parameters(route.pathParams, "path"),
    ...parameters(route.query, "query"),
  ];
  if (routeParameters.length > 0) operation.parameters = routeParameters;
  if (route.body instanceof z.ZodType) {
    operation.requestBody = {
      required: true,
      content: { "application/json": { schema: schema(route.body) } },
    };
  }

  paths[openApiPath] ??= {};
  paths[openApiPath]![route.method.toLowerCase()] = operation;
}

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
  paths,
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
