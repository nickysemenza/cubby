import { z } from "zod";
import { isObjectSchema, type JsonSchema } from "./document-passes.ts";
import type { OpenApiDocument } from "./openapi.ts";

const swiftMethods = new Map([
  ["get", ".get"],
  ["post", ".post"],
  ["patch", ".patch"],
  ["delete", ".delete"],
]);
export const swiftString = (value: string) => {
  const literal = JSON.stringify(value);
  if (literal.includes("\\u"))
    throw new Error(`Non-ASCII in Swift literal: ${value}`);
  return literal;
};
export const httpVerbs = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
]);
const routableOperation = z.object({
  operationId: z.string(),
  parameters: z
    .array(
      z.looseObject({
        name: z.string().optional(),
        in: z.string().optional(),
      }),
    )
    .optional(),
  requestBody: z.unknown().optional(),
});

export type SwiftRoute = Readonly<{
  id: string;
  method: string;
  route: string;
  pathParameters: string[];
  queryParameters: string[];
  hasBody: boolean;
}>;

/** Every (operationId, method, path) triple in the document, sorted by id. */
export const collectSwiftRoutes = (document: OpenApiDocument): SwiftRoute[] => {
  const swiftRoutes = Object.entries(document.paths)
    .flatMap(([route, item]) =>
      Object.entries(item)
        .filter(([method]) => httpVerbs.has(method))
        .map(([method, raw]) => ({
          route,
          method,
          operation: routableOperation.parse(raw),
        })),
    )
    .map(({ route, method, operation }) => {
      const swiftMethod = swiftMethods.get(method);
      if (!swiftMethod)
        throw new Error(`Unsupported HTTP method ${method} on ${route}`);
      const names = (location: string) =>
        (operation.parameters ?? [])
          .flatMap((parameter) =>
            parameter.in === location && parameter.name !== undefined
              ? [parameter.name]
              : [],
          )
          .sort();
      return {
        id: operation.operationId,
        method: swiftMethod,
        route,
        pathParameters: names("path"),
        queryParameters: names("query"),
        hasBody: operation.requestBody !== undefined,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (
    swiftRoutes.some((entry) => entry.id === "") ||
    new Set(swiftRoutes.map((entry) => entry.id)).size !== swiftRoutes.length
  )
    throw new Error("Every operation needs a unique operationId");
  // The native wire rule (apps/apple/AGENTS.md): a flat read takes plain query
  // parameters and anything structured takes a JSON body, never both.
  const mixed = swiftRoutes.filter(
    (entry) => entry.hasBody && entry.queryParameters.length > 0,
  );
  if (mixed.length > 0)
    throw new Error(
      `Operations take a body or query parameters, not both: ${mixed.map((entry) => entry.id).join(", ")}`,
    );
  return swiftRoutes;
};

const componentRef = z.object({ $ref: z.string() });
export const requestBodyRef = (document: OpenApiDocument, route: string) =>
  componentRef
    .safeParse(
      document.paths[route]?.patch?.requestBody?.content?.["application/json"]
        ?.schema,
    )
    .data?.$ref.replace("#/components/schemas/", "");

/** The component schema name of an operation's JSON request body, whatever its method. */
export const operationBodyRef = (
  document: OpenApiDocument,
  route: string,
  method: string,
) =>
  componentRef
    .safeParse(
      document.paths[route]?.[method.slice(1)]?.requestBody?.content?.[
        "application/json"
      ]?.schema,
    )
    .data?.$ref.replace("#/components/schemas/", "");

/** Entity keys whose `resources.<key>.update` body declares `property`. */
export const updateBodyHas = (
  document: OpenApiDocument,
  components: Record<string, JsonSchema>,
  swiftRoutes: readonly SwiftRoute[],
  entity: string,
  property: string,
) => {
  const route = swiftRoutes.find(
    (entry) => entry.id === `resources.${entity}.update`,
  )?.route;
  const ref = route === undefined ? undefined : requestBodyRef(document, route);
  const body = ref === undefined || ref === null ? undefined : components[ref];
  return (
    body !== undefined &&
    isObjectSchema(body) &&
    body.properties?.[property] !== undefined
  );
};

export const swiftList = (values: readonly string[]) =>
  `[${values.map(swiftString).join(", ")}]`;

// The native client carries every resources.<entity>.{list,get,create,update,delete,
// timeline} operation the HTTP document exposes: the generic list, detail and
// editor screens run over every resource entity, so the op set is the
// document's, not an opt-in list (the hero-action runner needs delete, and
// confirms it behind the connection-impact preview). RPC ids are opt-in through
// `native:` on the contract member; the generator config is written from
// the document and those flags so they cannot drift.
const isAutomaticResourceOperation = (id: string) =>
  /^resources\.[^.]+\.(?:list|get|create|update|delete|timeline)$/u.test(id);
/**
 * The operation ids the swift-openapi-generator client carries: every
 * automatic one plus the flagged ones (sorted, deduplicated by the caller).
 */
export const nativeOperationIds = (
  swiftRoutes: readonly SwiftRoute[],
  nativeOperations: readonly string[],
): string[] => {
  const operationIds = new Set(swiftRoutes.map((entry) => entry.id));
  for (const id of nativeOperations) {
    if (!operationIds.has(id))
      throw new Error(
        `${id} is flagged native but has no HTTP route (an \`http: false\` member cannot be native)`,
      );
    if (isAutomaticResourceOperation(id))
      throw new Error(
        `${id} is flagged native, but resource list/get/create/update/timeline operations are automatic; drop the flag`,
      );
  }
  const generatedOperations = [
    ...new Set([
      ...swiftRoutes
        .map((entry) => entry.id)
        .filter((id) => isAutomaticResourceOperation(id)),
      ...nativeOperations,
    ]),
  ].sort();
  return generatedOperations;
};
