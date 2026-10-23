import type { AppRouter } from "@ts-rest/core";
import { z } from "zod";

import { httpMetadataSchema } from "../../src/lib/http-api/router.ts";
import { checkHttpRoutes, httpRoutes } from "../../src/lib/http-api/routes.ts";
import {
  discriminatorOf,
  wireProjection,
  wireRegistry,
} from "../../src/lib/http-api/wire.ts";
import { pascal } from "./schema-names.ts";

export interface NativeOperation {
  id: string;
  method: string;
  path: string;
  input: "object" | "wrapped" | "none" | "null";
  query?: string;
  body?: string;
  output: string;
}

/** JSON Schema is a model description here, not an HTTP/OpenAPI document. */
export interface NativeContract {
  operations: readonly NativeOperation[];
  models: Readonly<Record<string, z.core.JSONSchema.JSONSchema>>;
  records: readonly string[];
}

/**
 * Collect the native interface from the same projected declarations the HTTP
 * handler uses. Keep optionality and nullability intact; Swift owns their codecs.
 */
export function collectNativeContract(
  router: AppRouter,
  named: ReadonlyMap<string, z.ZodType> = new Map(),
  records: ReadonlyMap<string, z.ZodType> = new Map(),
): NativeContract {
  checkHttpRoutes(router);
  const registries = {
    input: z.registry<{ id: string }>(),
    output: z.registry<{ id: string }>(),
    query: z.registry<{ id: string }>(),
  };
  for (const [name, schema] of named) {
    const output = wireProjection(schema, "output");
    const input = wireProjection(schema, "input");
    const query = wireProjection(schema, "query");
    for (const io of ["input", "output", "query"] as const) {
      const projected =
        io === "input" ? input : io === "query" ? query : output;
      if (projected !== undefined && !registries[io].has(projected)) {
        const id =
          io === "input" && output !== undefined && input !== output
            ? `${name}${name.endsWith("Input") ? "Request" : "Input"}`
            : name;
        registries[io].add(projected, { id });
      }
    }
  }
  for (const [id, schema] of records) {
    if (!registries.output.has(schema)) registries.output.add(schema, { id });
  }
  const register = (
    schema: unknown,
    io: "input" | "output" | "query",
    fallback: string,
  ): string => {
    if (!(schema instanceof z.ZodType))
      throw new Error(`${fallback}: expected a projected Zod schema`);
    const registry = registries[io];
    const id =
      registry.get(schema)?.id ??
      wireRegistry.get(schema)?.id ??
      z.globalRegistry.get(schema)?.id ??
      fallback;
    if (!registry.has(schema)) registry.add(schema, { id });
    return `${io}/${id}`;
  };
  let errorSchema: z.ZodType | undefined;
  const json = z.json();
  const operations = httpRoutes(router)
    .map((route): NativeOperation => {
      const metadata = httpMetadataSchema.parse(route.metadata);
      if (/[:{}]/u.test(route.path))
        throw new Error(
          `${metadata.operation}: native paths cannot contain parameters`,
        );
      if (route.headers !== undefined)
        throw new Error(
          `${metadata.operation}: native custom request headers require an explicit transport change`,
        );
      const name = metadata.operation.split(".").map(pascal).join("");
      const operation: NativeOperation = {
        id: metadata.operation,
        method: route.method,
        path: route.path,
        input: metadata.input ?? "object",
        output: register(
          metadata.nativeModels?.output === "json"
            ? json
            : route.responses[200],
          "output",
          metadata.nativeModels?.output === "json"
            ? "NativeJSON"
            : `${name}Output`,
        ),
      };
      if (route.query instanceof z.ZodType)
        operation.query = register(route.query, "query", `${name}Query`);
      if ("body" in route && route.body instanceof z.ZodType)
        operation.body = register(
          metadata.nativeModels?.input === "json" ? json : route.body,
          "input",
          metadata.nativeModels?.input === "json"
            ? "NativeJSON"
            : `${name}Input`,
        );
      for (const [status, schema] of Object.entries(route.responses)) {
        if (Number(status) >= 400) {
          if (
            !(schema instanceof z.ZodType) ||
            (errorSchema !== undefined && errorSchema !== schema)
          )
            throw new Error(
              `${operation.id}: error status ${status} differs from the shared native error contract`,
            );
          errorSchema = schema;
          register(schema, "output", "ApiError");
        } else if (status !== "200")
          throw new Error(
            `${operation.id}: unsupported native success status ${status}`,
          );
      }
      return operation;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(operations.map(({ id }) => id)).size !== operations.length)
    throw new Error("Native operation identities must be unique");
  const models: Record<string, z.core.JSONSchema.JSONSchema> = {};
  for (const io of ["input", "output", "query"] as const) {
    const emitted = z.toJSONSchema(registries[io], {
      target: "draft-2020-12",
      io: io === "query" ? "output" : io,
      reused: "ref",
      uri: (id) => `native://${io}/${id}`,
      override: ({ zodSchema, jsonSchema }) => {
        const discriminator = discriminatorOf(zodSchema);
        if (discriminator !== undefined)
          jsonSchema["x-native-discriminator"] = discriminator;
      },
    });
    for (const [id, schema] of Object.entries(emitted.schemas))
      models[`${io}/${id}`] = schema;
  }
  return {
    operations,
    models,
    records: [...records].map(
      ([id, schema]) => `output/${registries.output.get(schema)?.id ?? id}`,
    ),
  };
}
