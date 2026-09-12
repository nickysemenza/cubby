import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { generateOpenApi, type SchemaTransformerSync } from "@ts-rest/open-api";
import { z } from "zod";
import { getCookies } from "better-auth/cookies";
import type { HttpMetadata } from "../src/lib/http-api/router";
import { discriminatorOf } from "../src/lib/http-api/wire";
import {
  collapseNullableUnions,
  isObjectSchema,
  type JsonSchema,
  collapseSingleAllOf,
  dropNullOnlyProperties,
  dropRequiredWithoutProperties,
  fillDiscriminatorMappings,
  flattenNestedNullables,
  foldPositionalDuplicates,
  inlineNullableComponents,
  inlinePrimitiveComponents,
  mapSchemas,
  nameJsonValues,
  optionalNullableProperties,
  residualNullPointers,
} from "./openapi/document-passes";
import { pascal, registerSchemaNames } from "./openapi/schema-names";

// Component names come from the schema exports, so every exported schema is
// registered before the contract (and with it the wire projections) loads.
const named = await registerSchemaNames(new URL("../src/", import.meta.url));
const { httpContract } = await import("../src/lib/generated/http-contract.gen");
const { httpMetadataSchema } = await import("../src/lib/http-api/router");
const { checkHttpRoutes } = await import("../src/lib/http-api/routes");
const { wireProjection, wireRegistry } =
  await import("../src/lib/http-api/wire");

checkHttpRoutes(httpContract);

const registries = {
  input: z.registry<{ id: string }>(),
  output: z.registry<{ id: string }>(),
};

// A named domain schema's wire projections are components under the export
// name, so a nested reference resolves to `#/components/schemas/<Name>`
// directly. A scalar projects to the same instance on both sides and keeps
// one name; an object that serves both sides gets an `Input` twin.
for (const [name, domain] of named) {
  const output = wireProjection(domain, "output");
  const input = wireProjection(domain, "input");
  // A pass-through projection is the domain instance itself; it can be
  // reached from either side, so it is one component on both.
  if (output === domain || input === domain) {
    for (const registry of [registries.input, registries.output])
      if (!registry.has(domain)) registry.add(domain, { id: name });
    continue;
  }
  if (output && !registries.output.has(output))
    registries.output.add(output, { id: name });
  if (input && !registries.input.has(input))
    registries.input.add(input, {
      id:
        output === undefined
          ? name
          : `${name}${name.endsWith("Input") ? "Request" : "Input"}`,
    });
}

/** Every route schema is real Zod, so the JSON Schema comes straight from it. */
const inlineSchema = (schema: z.ZodType, io: "input" | "output") =>
  inlineDefinitions(
    z.toJSONSchema(schema, {
      target: "draft-2020-12",
      io,
      reused: "inline",
      unrepresentable: "any",
      override: stripMockHints,
    }),
  );

const stripMockHints: NonNullable<
  Parameters<typeof z.toJSONSchema>[1]
>["override"] = ({ zodSchema, jsonSchema }) => {
  delete jsonSchema.mock;
  delete jsonSchema.mockValue;
  // Zod emits `oneOf` for a discriminated union but no discriminator; the
  // mapping is filled once every member is a named component.
  const key = discriminatorOf(zodSchema);
  if (key !== undefined && jsonSchema.oneOf !== undefined)
    jsonSchema.discriminator = { propertyName: key };
};

/**
 * Parameters cannot reference components, and a registered leaf (a shortcode
 * schema, say) is extracted to `definitions` even when the emission is
 * inline: put every definition back where it is referenced.
 */
function inlineDefinitions(schema: JsonSchema): JsonSchema {
  const definitions: Record<string, JsonSchema | boolean> = {};
  for (const source of [schema.definitions, schema.$defs])
    Object.assign(definitions, source ?? {});
  const { definitions: _definitions, $defs: _defs, ...root } = schema;
  const local = /^#\/(?:definitions|\$defs)\/(?<name>.+)$/u;
  const resolve = (node: JsonSchema): JsonSchema => {
    const name =
      node.$ref === undefined ? undefined : local.exec(node.$ref)?.groups?.name;
    const target = name === undefined ? undefined : definitions[name];
    if (target !== undefined && isObjectSchema(target)) {
      const { $ref: _ref, ...rest } = node;
      return { ...resolve(target), ...rest };
    }
    const copy: JsonSchema = { ...node };
    if (copy.properties)
      copy.properties = Object.fromEntries(
        Object.entries(copy.properties).map(([key, value]) => [
          key,
          isObjectSchema(value) ? resolve(value) : value,
        ]),
      );
    if (
      copy.items !== undefined &&
      !Array.isArray(copy.items) &&
      isObjectSchema(copy.items)
    )
      copy.items = resolve(copy.items);
    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      const members = copy[keyword];
      if (members)
        copy[keyword] = members.map((member) =>
          isObjectSchema(member) ? resolve(member) : member,
        );
    }
    return copy;
  };
  return resolve(root);
}

/**
 * Query and path parameters are listed individually, so their schema must be
 * one object: the query projection guarantees that for every GET route.
 */
function parameterObject(schema: JsonSchema): JsonSchema {
  if (schema.type !== "object" || schema.anyOf || schema.oneOf)
    throw new Error("HTTP parameters must be one object schema");
  return {
    type: "object",
    required: schema.required ?? [],
    properties: schema.properties ?? {},
  };
}

// SAFETY: Zod emits JSON Schema 2020-12 objects; its broader type also
// permits booleans, which no route schema produces.
const asSchemaObject = (schema: JsonSchema) =>
  schema as NonNullable<ReturnType<SchemaTransformerSync>>;

/**
 * The component name of a route-level schema that is not a named export:
 * resource routes name their bodies and results after the entity, RPC routes
 * after the operation.
 */
const routeComponentId = (
  metadata: HttpMetadata,
  type: "body" | "response",
): string => {
  if (metadata.resource !== undefined) {
    const entity = pascal(metadata.entity ?? "");
    switch (metadata.resource) {
      case "list":
        return `${entity}ListPage`;
      case "get":
        return `${entity}Detail`;
      case "create":
        return `${entity}Create${type === "body" ? "Body" : "Result"}`;
      case "update":
        return `${entity}Update${type === "body" ? "Body" : "Result"}`;
      case "delete":
        return `${entity}DeleteResult`;
    }
  }
  const operation = metadata.operation.split(".").map(pascal).join("");
  return `${operation}${type === "response" ? "Output" : "Input"}`;
};

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
    operationMapper: (operation, route) => {
      const metadata = httpMetadataSchema.parse(route.metadata);
      operation.tags = [metadata.entity ?? metadata.operation.split(".")[0]!];
      // Query parameters are plain form values: repeat a key for a list.
      for (const parameter of operation.parameters ?? [])
        if (!("$ref" in parameter) && parameter.in === "query")
          Object.assign(parameter, { style: "form", explode: true });
      // One `default` error response instead of seven numeric ones: a client
      // that treats any status >= 400 as a failure needs one error type, and
      // per-status cases cost a generated client a case each. The server
      // still returns the real status codes (405 too, with the same body).
      const errors = Object.entries(operation.responses).filter(
        ([status]) => Number(status) >= 400,
      );
      const [, first] = errors[0] ?? [];
      if (first !== undefined) {
        for (const [status] of errors) delete operation.responses[status];
        operation.responses.default = { ...first, description: "Error" };
      }
      if (metadata.resource === "list")
        operation.description =
          "Use page=1&pageSize=20&sort=name,-createdAt. Filters are individual query parameters: text is literal, numbers and booleans are plain, and a list repeats its key (tag=a&tag=b). Response pagination metadata remains zero-based. Resource methods depend on entity capabilities.";
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
    schemaTransformer: ({ schema, appRoute, type }) => {
      if (!(schema instanceof z.ZodType) || type === "header") return null;
      // A query schema is the coercing projection: emitted on its output
      // side so a parameter documents the logical type (integer, boolean,
      // array) rather than the text it accepts.
      if (type === "query" || type === "path")
        return asSchemaObject(
          parameterObject(
            inlineSchema(schema, type === "query" ? "output" : "input"),
          ),
        );
      const io = type === "response" ? "output" : "input";
      const registry = registries[io];
      // Names: a named export's projection, a schema carrying its own
      // `.meta({ id })`, or the route position.
      const id =
        registry.get(schema)?.id ??
        wireRegistry.get(schema)?.id ??
        z.globalRegistry.get(schema)?.id ??
        routeComponentId(httpMetadataSchema.parse(appRoute.metadata), type);
      if (!registry.has(schema)) registry.add(schema, { id });
      return { $ref: `#/components/schemas/${id}` };
    },
  },
);

/** `…/input___shared#/definitions/schema0` -> `…/input_schema0`. */
const nameSharedDefinitions = (schemas: Record<string, JsonSchema>) =>
  Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      mapSchemas(schema, (node) =>
        node.$ref === undefined
          ? node
          : {
              ...node,
              $ref: node.$ref.replace(
                /(input|output)___shared#\/\$defs\//u,
                "$1_",
              ),
            },
      ),
    ]),
  );

const emitted: Record<string, JsonSchema> = {};
for (const io of ["input", "output"] as const) {
  const { schemas } = z.toJSONSchema(registries[io], {
    target: "draft-2020-12",
    io,
    reused: "ref",
    unrepresentable: "any",
    uri: (id) =>
      `#/components/schemas/${id === "__shared" ? `${io}___shared` : id}`,
    override: stripMockHints,
  });
  for (const [id, schema] of Object.entries(schemas)) {
    if (id === "__shared") {
      for (const [name, definition] of Object.entries(schema.$defs ?? {}))
        emitted[`${io}_${name}`] = definition;
    } else emitted[id] = schema;
  }
}
// What the export walk could not name: shared instances a module never
// exported. Bare primitives are inlined; bodies equal to a named component
// (a `.describe()` clone) fold onto it.
const passes = [
  nameSharedDefinitions,
  inlinePrimitiveComponents,
  foldPositionalDuplicates,
  nameJsonValues,
  collapseSingleAllOf,
  flattenNestedNullables,
  inlineNullableComponents,
  collapseNullableUnions,
  optionalNullableProperties,
  dropNullOnlyProperties,
  dropRequiredWithoutProperties,
  fillDiscriminatorMappings,
];
const components = passes.reduce((current, pass) => pass(current), emitted);
/**
 * Nullability the passes above could not express in a form a generated
 * client keeps. Each pointer here is a decision, not a bucket.
 */
const RESIDUAL_NULL_ALLOWLIST = new Set<string>([
  // A map whose values may be null; a generated client reads the map type
  // and drops the value nullability, which the product summaries tolerate.
  "#/components/schemas/ProductFoodSummariesOut/additionalProperties",
]);
const residual = residualNullPointers(components).filter(
  (pointer) => !RESIDUAL_NULL_ALLOWLIST.has(pointer),
);
if (residual.length > 0)
  throw new Error(
    `Nullable schema a generated client would drop:\n${residual.join("\n")}`,
  );

const serialized = `${JSON.stringify(
  {
    ...document,
    openapi: "3.1.0",
    components: { ...document.components, schemas: components },
  },
  (key, value) => {
    if (key === "$id" || key === "$schema") return undefined;
    if (key === "$ref")
      return z
        .string()
        .parse(value)
        .replace(/(input|output)___shared#\/\$defs\//u, "$1_");
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

// The native client's route table is derived from the same document so the
// Swift side never hand-maintains (method, path) pairs. It is committed next
// to the swift-openapi-generator output and gated by the same --check.
const swiftMethods = new Map([
  ["get", ".get"],
  ["post", ".post"],
  ["patch", ".patch"],
  ["delete", ".delete"],
]);
/** Write a generated file, or with `--check` fail when the committed copy differs. */
const emitGenerated = (target: URL, content: string, label: string) => {
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== content)
      throw new Error(
        `${label} is stale; run pnpm --filter @cubby/web generate:http-api`,
      );
  } else writeFileSync(target, content);
};

const swiftString = (value: string) => {
  const literal = JSON.stringify(value);
  if (literal.includes("\\u"))
    throw new Error(`Non-ASCII in Swift literal: ${value}`);
  return literal;
};
const httpVerbs = new Set([
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
      z.looseObject({ name: z.string().optional(), in: z.string().optional() }),
    )
    .optional(),
  requestBody: z.unknown().optional(),
});
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
const componentRef = z.object({ $ref: z.string() });
const requestBodyRef = (route: string) =>
  componentRef
    .safeParse(
      document.paths[route]?.patch?.requestBody?.content?.["application/json"]
        ?.schema,
    )
    .data?.$ref.replace("#/components/schemas/", "");
const imageAttachable = swiftRoutes
  .flatMap((entry) => {
    const match = /^resources\.([^.]+)\.update$/u.exec(entry.id);
    const ref = match && requestBodyRef(entry.route);
    const body =
      ref === undefined || ref === null ? undefined : components[ref];
    return match &&
      body &&
      isObjectSchema(body) &&
      body.properties?.pendingImageIds
      ? [match[1]!]
      : [];
  })
  .sort();
const swiftList = (values: string[]) =>
  `[${values.map(swiftString).join(", ")}]`;
const swiftSource = `// Generated by apps/web/scripts/generate-http-openapi.ts — do not edit.
// Regenerate with \`pnpm --filter @cubby/web generate:http-api\`; \`pnpm check\` fails when stale.

extension OperationRoute {
    /// Every operation in the HTTP API, keyed by operationId.
    public static let all: [String: OperationRoute] = Dictionary(
        uniqueKeysWithValues: routeTable.map { ($0.operationID, $0) }
    )

    /// Entity keys whose \`resources.<key>.update\` body accepts \`pendingImageIds\`.
    public static let imageAttachableEntities: Set<String> = ${swiftList(imageAttachable)}

    private static let routeTable: [OperationRoute] = [
${swiftRoutes
  .map(
    (entry) =>
      `        OperationRoute(operationID: ${swiftString(entry.id)}, method: ${entry.method}, path: ${swiftString(entry.route)}, pathParameters: ${swiftList(entry.pathParameters)}, queryParameters: ${swiftList(entry.queryParameters)}, hasBody: ${entry.hasBody}),`,
  )
  .join("\n")}
    ]
}
`;
const swiftPath = new URL(
  "../../apple/CubbyKit/Sources/CubbyKit/Generated/OperationRoutes.swift",
  import.meta.url,
);
emitGenerated(swiftPath, swiftSource, "OperationRoutes.swift");

// The native client generates every resource operation plus the RPC
// operations it calls, listed with a reason in native-operations.json; the
// generator config is written from that so the two cannot drift.
const nativeOperations = z
  .object({
    operations: z.array(z.object({ id: z.string(), why: z.string() })),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../apple/openapi/native-operations.json", import.meta.url),
        "utf8",
      ),
    ),
  )
  .operations.map((entry) => entry.id);
const operationIds = new Set(swiftRoutes.map((entry) => entry.id));
for (const [index, id] of nativeOperations.entries()) {
  if (!operationIds.has(id))
    throw new Error(`native-operations.json names an unknown operation ${id}`);
  if (id.startsWith("resources."))
    throw new Error(
      `native-operations.json lists ${id}; resource operations are automatic`,
    );
  if (nativeOperations.indexOf(id) !== index)
    throw new Error(`native-operations.json lists ${id} twice`);
  const previous = nativeOperations[index - 1];
  if (previous !== undefined && previous.localeCompare(id) >= 0)
    throw new Error(`native-operations.json is not sorted at ${id}`);
}
const generatedOperations = [
  ...swiftRoutes
    .map((entry) => entry.id)
    .filter((id) => id.startsWith("resources.")),
  ...nativeOperations,
].sort();
emitGenerated(
  new URL("../../apple/openapi/openapi-generator-config.yaml", import.meta.url),
  `# Generated by apps/web/scripts/generate-http-openapi.ts — do not edit.
# Every resources.* operation plus the RPC ids in native-operations.json;
# \`pnpm --filter @cubby/web generate:http-api\` rewrites it, \`pnpm check\` fails when stale.
generate:
  - types
  - client
# These land in the CubbyAPI target; \`package\` lets CubbyKit name them at its mapping
# boundary while the App target, outside the package, still cannot.
accessModifier: package
namingStrategy: idiomatic
filter:
  operations:
${generatedOperations.map((id) => `    - ${id}`).join("\n")}
`,
  "openapi-generator-config.yaml",
);

// The generic Browse screens run over every catalog entity through one typed
// bridge: a switch per action over the generated per-entity operations,
// re-encoding each typed row into the JSONValue projection EntityRow reads.
const resourceEntities = new Map<string, Set<string>>();
for (const entry of swiftRoutes) {
  const match = /^resources\.([^.]+)\.(list|get|create|update|delete)$/u.exec(
    entry.id,
  );
  if (!match) continue;
  const actions = resourceEntities.get(match[1]!) ?? new Set<string>();
  actions.add(match[2]!);
  resourceEntities.set(match[1]!, actions);
}
const swiftCase = (entity: string) =>
  entity.replace(/-([a-z])/gu, (_match, letter: string) =>
    letter.toUpperCase(),
  );
const swiftMethod = (entity: string, action: string) =>
  `resources_${entity.replace(/-/gu, "_")}_${action}`;
const updateBodyHas = (entity: string, property: string) => {
  const ref = requestBodyRef(
    `/api/v1/${swiftRoutes.find((entry) => entry.id === `resources.${entity}.update`)?.route.replace("/api/v1/", "") ?? ""}`,
  );
  const body = ref === undefined ? undefined : components[ref];
  return (
    body !== undefined &&
    isObjectSchema(body) &&
    body.properties?.[property] !== undefined
  );
};
const entities = [...resourceEntities].sort(([a], [b]) => a.localeCompare(b));
const actionCases = entities
  .map(
    ([entity, actions]) =>
      `        case .${swiftCase(entity)}: [${[...actions]
        .sort()
        .map((action) => `.${action}`)
        .join(", ")}]`,
  )
  .join("\n");
const listCases = entities
  .filter(([, actions]) => actions.has("list"))
  .map(
    ([entity]) => `        case .${swiftCase(entity)}:
            let page = try await client.${swiftMethod(entity, "list")}(
                query: .init(page: page, pageSize: pageSize, sort: sort)
            ).ok.body.json
            return ListPage(
                items: try page.items.map(JSONValue.init(encoding:)),
                meta: PageMeta(page.meta)
            )`,
  )
  .join("\n");
const getCases = entities
  .filter(([, actions]) => actions.has("get"))
  .map(
    ([entity]) => `        case .${swiftCase(entity)}:
            return try JSONValue(encoding: try await client.${swiftMethod(entity, "get")}(path: .init(id: id)).ok.body.json)`,
  )
  .join("\n");
const attachCases = entities
  .filter(
    ([entity, actions]) =>
      actions.has("update") && updateBodyHas(entity, "pendingImageIds"),
  )
  .map(
    ([entity]) => `        case .${swiftCase(entity)}:
            _ = try await client.${swiftMethod(entity, "update")}(
                path: .init(id: id), body: .json(.init(pendingImageIds: imageIds))
            ).ok`,
  )
  .join("\n");
const orderCases = entities
  .filter(
    ([entity, actions]) =>
      actions.has("update") && updateBodyHas(entity, "imageOrder"),
  )
  .map(
    ([entity]) => `        case .${swiftCase(entity)}:
            _ = try await client.${swiftMethod(entity, "update")}(
                path: .init(id: id), body: .json(.init(imageOrder: imageIds))
            ).ok`,
  )
  .join("\n");
emitGenerated(
  new URL(
    "../../apple/CubbyKit/Sources/CubbyKit/Generated/EntityOperations.swift",
    import.meta.url,
  ),
  `// Generated by apps/web/scripts/generate-http-openapi.ts — do not edit.
// Regenerate with \`pnpm --filter @cubby/web generate:http-api\`; \`pnpm check\` fails when stale.

import CubbyAPI

/// Thrown when a catalog entity has no HTTP route for the requested action.
public enum EntityOperationError: Error, Sendable, Hashable {
    case unsupported(EntityKey, EntityAction)
}

extension EntityKey {
    /// The resource actions the HTTP document actually exposes for this entity. Authoritative
    /// over \`EntityDescriptor.actions\`, which comes from the kernel roster and can declare an
    /// action that has no HTTP route.
    public var httpActions: Set<EntityAction> {
        switch self {
${actionCases}
        default: []
        }
    }
}

extension EntityDescriptor {
    /// One page of rows as the dynamic projection \`EntityRow\` reads. Typed on the wire; the
    /// \`JSONValue\` is produced from the decoded value, never from the response bytes.
    func listPage(client: Client, page: Int, pageSize: Int, sort: String?) async throws -> ListPage<JSONValue> {
        switch key {
${listCases}
        default: throw EntityOperationError.unsupported(key, .list)
        }
    }

    /// One row by id, as the dynamic projection \`EntityRow\` reads.
    func getRow(client: Client, id: String) async throws -> JSONValue {
        switch key {
${getCases}
        default: throw EntityOperationError.unsupported(key, .get)
        }
    }

    /// \`resources.<key>.update\` with only \`pendingImageIds\` set, for the entities whose update
    /// body declares it (the same set \`OperationRoute.imageAttachableEntities\` lists).
    func attachImages(_ imageIds: [String], to id: String, client: Client) async throws {
        switch key {
${attachCases}
        default: throw EntityOperationError.unsupported(key, .update)
        }
    }

    /// \`resources.<key>.update\` with only \`imageOrder\` set.
    func setImageOrder(_ imageIds: [String], on id: String, client: Client) async throws {
        switch key {
${orderCases}
        default: throw EntityOperationError.unsupported(key, .update)
        }
    }
}
`,
  "EntityOperations.swift",
);

console.log(`HTTP OpenAPI: ${Object.keys(document.paths).length} operations`);
