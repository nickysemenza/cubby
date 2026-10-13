import { bundleFromString, createConfig } from "@redocly/openapi-core";
import { z } from "zod";
import type { JsonSchema } from "./document-passes.ts";
import type { OpenApiDocument } from "./openapi.ts";
import {
  collectSwiftRoutes,
  httpVerbs,
  nativeOperationIds,
} from "./swift-routes.ts";

const operationId = z.object({ operationId: z.string() });

// Native lists render from the entity manifest: ProgressiveEntityLists.swift
// re-encodes these responses into JSONValue before reading a field, so their
// per-entity typed variants (~140 generated types) were compile cost only.
const nativeJsonValueOutputs = [
  "EntityListBaseOutput",
  "EntityListEnrichmentOutput",
  "EntityListSummaryOutput",
] as const;

/** The components the native client is generated from: the HTTP ones, with JSONValue-read outputs left untyped. */
export const nativeComponents = (
  components: Readonly<Record<string, JsonSchema>>,
) => {
  const native = { ...components };
  for (const name of nativeJsonValueOutputs) {
    if (native[name] === undefined)
      throw new Error(
        `Native JSONValue output #/components/schemas/${name} is not in the document`,
      );
    native[name] = { type: "object", additionalProperties: true };
  }
  return native;
};

/** Keep the native operation set and the reference closure it actually uses. */
export const projectNativeDocument = async (
  document: OpenApiDocument,
  nativeOperations: readonly string[],
  schemas: ReturnType<typeof nativeComponents>,
): Promise<OpenApiDocument> => {
  const selected = new Set(
    nativeOperationIds(collectSwiftRoutes(document), nativeOperations),
  );
  const paths = Object.fromEntries(
    Object.entries(document.paths).flatMap(([path, item]) => {
      const entries = Object.entries(item).filter(
        ([method, value]) =>
          !httpVerbs.has(method) ||
          selected.has(operationId.parse(value).operationId),
      );
      return entries.some(([method]) => httpVerbs.has(method))
        ? [[path, Object.fromEntries(entries)]]
        : [];
    }),
  );
  const { bundle, problems } = await bundleFromString({
    source: JSON.stringify({
      ...document,
      paths,
      components: { ...document.components, schemas },
    }),
    config: await createConfig({}),
    removeUnusedComponents: true,
  });
  const errors = problems.filter((problem) => problem.severity === "error");
  if (errors.length > 0)
    throw new Error(
      `Native OpenAPI projection failed: ${errors.map((problem) => `${problem.message} (${problem.location.map((location) => location.pointer).join(", ")})`).join("; ")}`,
    );
  // SAFETY: Redocly bundled a typed OpenAPI document without errors; filtering
  // paths and removing unused components preserves the OpenAPI object shape.
  return bundle.parsed as OpenApiDocument;
};
