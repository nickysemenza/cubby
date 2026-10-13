import { bundleFromString, createConfig } from "@redocly/openapi-core";
import { z } from "zod";
import type { OpenApiDocument } from "./openapi.ts";
import {
  collectSwiftRoutes,
  httpVerbs,
  nativeOperationIds,
} from "./swift-routes.ts";

const operationId = z.object({ operationId: z.string() });

/** Keep the native operation set and the reference closure it actually uses. */
export const projectNativeDocument = async (
  document: OpenApiDocument,
  nativeOperations: readonly string[],
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
    source: JSON.stringify({ ...document, paths }),
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
