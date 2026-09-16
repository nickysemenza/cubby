import { z } from "zod";
import { entityKeys } from "../../../packages/schemas/src/generated/entity-summary.gen.ts";
import { generatedHeader, yamlGeneratedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import type { HttpResources } from "../entities/render/index.ts";
import { type EntityOutputs, renderApiTypes } from "./api-types.ts";
import { isObjectSchema, type JsonSchema } from "./document-passes.ts";
import type { OpenApiDocument } from "./openapi.ts";

const swiftMethods = new Map([
  ["get", ".get"],
  ["post", ".post"],
  ["patch", ".patch"],
  ["delete", ".delete"],
]);
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
      z.looseObject({
        name: z.string().optional(),
        in: z.string().optional(),
      }),
    )
    .optional(),
  requestBody: z.unknown().optional(),
});

type SwiftRoute = Readonly<{
  id: string;
  method: string;
  route: string;
  pathParameters: string[];
  queryParameters: string[];
  hasBody: boolean;
}>;

/** Every (operationId, method, path) triple in the document, sorted by id. */
const collectSwiftRoutes = (document: OpenApiDocument): SwiftRoute[] => {
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
  return swiftRoutes;
};

const componentRef = z.object({ $ref: z.string() });
const requestBodyRef = (document: OpenApiDocument, route: string) =>
  componentRef
    .safeParse(
      document.paths[route]?.patch?.requestBody?.content?.["application/json"]
        ?.schema,
    )
    .data?.$ref.replace("#/components/schemas/", "");

/** Entity keys whose `resources.<key>.update` body declares `property`. */
const updateBodyHas = (
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

const swiftList = (values: readonly string[]) =>
  `[${values.map(swiftString).join(", ")}]`;

// The native client's route table is derived from the same document so the
// Swift side never hand-maintains (method, path) pairs. It is committed next
// to the swift-openapi-generator output and gated by the same --check.
const renderOperationRoutes = (
  swiftRoutes: readonly SwiftRoute[],
  imageAttachable: readonly string[],
): EntityArtifacts => ({
  relativePath:
    "apps/apple/CubbyKit/Sources/CubbyKit/Generated/OperationRoutes.swift",
  source: `${generatedHeader}extension OperationRoute {
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
`,
});

// The native client generates resources.<entity>.list/get for every entity
// automatically (the generic Browse screens need them all), and
// resources.<entity>.update for every entity whose update body accepts
// `pendingImageIds` (EntityOperations' image attach/reorder switch needs
// them all — a gallery entity must never be attachable in the manifest yet
// unattachable from iOS). Other create/update/delete are opt-in through the
// entity declaration's `native` block, and RPC ids through `native:` on the
// contract member; the generator config is written from those flags so the
// declarations and the config cannot drift.
const isAutomaticResourceOperation = (
  imageAttachable: readonly string[],
  id: string,
) =>
  /^resources\.[^.]+\.(?:list|get)$/u.test(id) ||
  imageAttachable.some((entity) => id === `resources.${entity}.update`);
/**
 * The operation ids the swift-openapi-generator client carries: every
 * automatic one plus the flagged ones (sorted, deduplicated by the caller).
 */
const nativeOperationIds = (
  swiftRoutes: readonly SwiftRoute[],
  imageAttachable: readonly string[],
  nativeOperations: readonly string[],
): string[] => {
  const operationIds = new Set(swiftRoutes.map((entry) => entry.id));
  for (const id of nativeOperations) {
    if (!operationIds.has(id))
      throw new Error(
        `${id} is flagged native but has no HTTP route (an \`http: false\` member cannot be native)`,
      );
    if (isAutomaticResourceOperation(imageAttachable, id))
      throw new Error(
        `${id} is flagged native, but list/get and image-attachable update operations are automatic; drop the flag`,
      );
  }
  const generatedOperations = [
    ...new Set([
      ...swiftRoutes
        .map((entry) => entry.id)
        .filter((id) => isAutomaticResourceOperation(imageAttachable, id)),
      ...nativeOperations,
    ]),
  ].sort();
  return generatedOperations;
};

/**
 * Generated schema types replaced by hand-written Swift types
 * (`typeOverrides.schemas` in swift-openapi-generator's config): component
 * name -> Swift type. Empty until the native lane moves its branded codes and
 * plain-date types into a support target.
 */
const TYPE_OVERRIDES: Readonly<Record<string, string>> = {};
/** Modules the generated client imports for the overrides above. */
const ADDITIONAL_IMPORTS: readonly string[] = [];

const renderGeneratorConfig = (
  generatedOperations: readonly string[],
): EntityArtifacts => {
  const overrides = Object.entries(TYPE_OVERRIDES).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const optional = [
    ...(ADDITIONAL_IMPORTS.length > 0
      ? [
          "additionalImports:",
          ...ADDITIONAL_IMPORTS.map((module) => `  - ${module}`),
        ]
      : []),
    ...(overrides.length > 0
      ? [
          "typeOverrides:",
          "  schemas:",
          ...overrides.map(([name, type]) => `    ${name}: ${type}`),
        ]
      : []),
  ]
    .map((line) => `${line}\n`)
    .join("");
  return {
    relativePath: "apps/apple/openapi/openapi-generator-config.yaml",
    source: `${yamlGeneratedHeader}# Every automatic resources.*.list/get operation, every gallery entity's
# resources.*.update, plus the RPC ids flagged \`native:\` in apps/web/src/contracts
# and the resources.*.create/update/delete verbs declared \`native\` on an entity.
generate:
  - types
  - client
# These land in the CubbyAPI target; \`public\` lets CubbyKit and the App name them
# through the generated aliases in CubbyKit/Generated/APITypes.swift.
accessModifier: public
namingStrategy: idiomatic
${optional}filter:
  operations:
${generatedOperations.map((id) => `    - ${id}`).join("\n")}
`,
  };
};

// The generic Browse screens run over every catalog entity through one typed
// bridge: a switch per action over the generated per-entity operations,
// re-encoding each typed row into the JSONValue projection EntityRow reads.
const resourceEntitiesFor = (
  swiftRoutes: readonly SwiftRoute[],
): Map<string, Set<string>> => {
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
  return resourceEntities;
};
const swiftCase = (entity: string) =>
  entity.replace(/-([a-z])/gu, (_match, letter: string) =>
    letter.toUpperCase(),
  );
const swiftMethod = (entity: string, action: string) =>
  `resources_${entity.replace(/-/gu, "_")}_${action}`;
const renderEntityOperations = (
  document: OpenApiDocument,
  components: Record<string, JsonSchema>,
  swiftRoutes: readonly SwiftRoute[],
  resourceEntities: ReadonlyMap<string, ReadonlySet<string>>,
  generatedOperationIds: ReadonlySet<string>,
): EntityArtifacts => {
  const bodyHas = (entity: string, property: string) =>
    updateBodyHas(document, components, swiftRoutes, entity, property);
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
    .filter(
      ([entity, actions]) =>
        actions.has("list") &&
        generatedOperationIds.has(`resources.${entity}.list`),
    )
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
    .filter(
      ([entity, actions]) =>
        actions.has("get") &&
        generatedOperationIds.has(`resources.${entity}.get`),
    )
    .map(
      ([entity]) => `        case .${swiftCase(entity)}:
            return try JSONValue(encoding: try await client.${swiftMethod(entity, "get")}(path: .init(id: id)).ok.body.json)`,
    )
    .join("\n");
  const attachCases = entities
    .filter(
      ([entity, actions]) =>
        actions.has("update") &&
        generatedOperationIds.has(`resources.${entity}.update`) &&
        bodyHas(entity, "pendingImageIds"),
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
        actions.has("update") &&
        generatedOperationIds.has(`resources.${entity}.update`) &&
        bodyHas(entity, "imageOrder"),
    )
    .map(
      ([entity]) => `        case .${swiftCase(entity)}:
            _ = try await client.${swiftMethod(entity, "update")}(
                path: .init(id: id), body: .json(.init(imageOrder: imageIds))
            ).ok`,
    )
    .join("\n");
  return {
    relativePath:
      "apps/apple/CubbyKit/Sources/CubbyKit/Generated/EntityOperations.swift",
    source: `${generatedHeader}import CubbyAPI

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
  };
};

// What the native app can do per entity, as one TS artifact for the web's
// `/entities` inspector. Everything here is already decided above — the
// resource actions the filtered Swift client carries, the image attach/reorder
// bodies `EntityOperations.swift` switches on, and the RPC ids flagged
// `native:` — so the page reads the same facts the Swift emit does instead of
// a second hand-kept list. RPC ids attach to an entity by
// their first segment (`product.lookupUpc` → product); a workflow domain that
// is not an entity key (`garden.*`, `upc.lookup`) belongs to no entity here.
const renderNativeCoverage = (
  document: OpenApiDocument,
  components: Record<string, JsonSchema>,
  swiftRoutes: readonly SwiftRoute[],
  resources: HttpResources,
  resourceEntities: ReadonlyMap<string, ReadonlySet<string>>,
  generatedOperationIds: ReadonlySet<string>,
  nativeOperations: readonly string[],
): EntityArtifacts => {
  const bodyHas = (entity: string, property: string) =>
    updateBodyHas(document, components, swiftRoutes, entity, property);
  const nativeCoverage = Object.fromEntries(
    entityKeys.map((entity) => {
      const actions = [...(resourceEntities.get(entity) ?? [])]
        .filter((action) =>
          generatedOperationIds.has(`resources.${entity}.${action}`),
        )
        .sort();
      const canUpdate = actions.includes("update");
      return [
        entity,
        {
          httpActions: actions,
          imageAttach: canUpdate && bodyHas(entity, "pendingImageIds"),
          imageOrder: canUpdate && bodyHas(entity, "imageOrder"),
          rpcIds: nativeOperations.filter(
            (id) => !id.startsWith("resources.") && id.split(".")[0] === entity,
          ),
        },
      ];
    }),
  );
  // The native client is a filtered view of the web API: it can never carry a
  // resource verb the HTTP document does not expose, and image attach/reorder
  // only exist through an update route. Stage 1's resource table and this
  // stage's coverage table must agree before either is written.
  for (const entity of entityKeys) {
    const coverage = nativeCoverage[entity];
    if (coverage === undefined) continue;
    const exposed = new Set<string>(resources[entity]?.verbs ?? []);
    const unexposed = coverage.httpActions.filter(
      (action) => !exposed.has(action),
    );
    if (unexposed.length > 0)
      throw new Error(
        `Native coverage for ${entity} lists ${unexposed.join(", ")}, which the HTTP resource table does not expose`,
      );
    if (
      (coverage.imageAttach || coverage.imageOrder) &&
      !coverage.httpActions.includes("update")
    )
      throw new Error(
        `Native coverage for ${entity} attaches images without an update route`,
      );
  }
  return {
    relativePath: "apps/web/src/lib/generated/entity-native-coverage.gen.ts",
    source: `${generatedHeader}import type { Entity } from "@cubby/schemas/entity";

type NativeHttpAction = "list" | "get" | "create" | "update" | "delete";

/**
 * What the native app (CubbyKit's generated client + \`EntityOperations.swift\`)
 * can do with an entity: the resource actions its filtered OpenAPI client
 * carries, whether its update body accepts image attach / reorder, and the
 * RPC operation ids it calls whose domain is this entity.
 */
export interface NativeCoverage {
  httpActions: readonly NativeHttpAction[];
  imageAttach: boolean;
  imageOrder: boolean;
  rpcIds: readonly string[];
}

// Generated coverage stays one entity per line.
// oxfmt-ignore
export const ENTITY_NATIVE_COVERAGE = {
${entityKeys.map((entity) => `  ${JSON.stringify(entity)}: ${JSON.stringify(nativeCoverage[entity])},`).join("\n")}
} as const satisfies Record<Entity, NativeCoverage>;
`,
  };
};

/**
 * Everything the native app derives from the OpenAPI document: the route
 * table, the swift-openapi-generator config, the per-entity operation bridge,
 * and the web's native-coverage table.
 */
export const renderNativeArtifacts = (
  document: OpenApiDocument,
  components: Record<string, JsonSchema>,
  resources: HttpResources,
  nativeOperations: readonly string[],
  entityOutputs: EntityOutputs,
): EntityArtifacts[] => {
  const swiftRoutes = collectSwiftRoutes(document);
  const imageAttachable = swiftRoutes
    .flatMap((entry) => {
      const match = /^resources\.([^.]+)\.update$/u.exec(entry.id);
      const ref = match && requestBodyRef(document, entry.route);
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
  const generatedOperations = nativeOperationIds(
    swiftRoutes,
    imageAttachable,
    nativeOperations,
  );
  const generatedOperationIds = new Set(generatedOperations);
  const resourceEntities = resourceEntitiesFor(swiftRoutes);
  return [
    renderOperationRoutes(swiftRoutes, imageAttachable),
    renderGeneratorConfig(generatedOperations),
    renderEntityOperations(
      document,
      components,
      swiftRoutes,
      resourceEntities,
      generatedOperationIds,
    ),
    renderNativeCoverage(
      document,
      components,
      swiftRoutes,
      resources,
      resourceEntities,
      generatedOperationIds,
      nativeOperations,
    ),
    renderApiTypes(document, components, generatedOperationIds, entityOutputs),
  ];
};
