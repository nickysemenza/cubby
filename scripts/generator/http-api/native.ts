import { entityKeys } from "../../../packages/schemas/src/generated/entity-summary.gen.ts";
import { generatedHeader, yamlGeneratedHeader } from "../artifacts.ts";
import type { EntityArtifacts } from "../entities/declarations.ts";
import type { HttpResources } from "../entities/render/index.ts";
import { type EntityOutputs, renderApiTypes } from "./api-types.ts";
import { isObjectSchema, type JsonSchema } from "./document-passes.ts";
import type { OpenApiDocument } from "./openapi.ts";
import {
  renderEntityOperations,
  resourceEntitiesFor,
} from "./swift-operations.ts";
import {
  collectSwiftRoutes,
  requestBodyRef,
  type SwiftRoute,
  swiftList,
  swiftString,
  updateBodyHas,
} from "./swift-routes.ts";
import { ADDITIONAL_IMPORTS, TYPE_OVERRIDES } from "./type-overrides.ts";

/** Native wire protocols that have no HTTP route but still need generated Codable models. */
export const NATIVE_COMPONENT_ROOTS = [
  "BrowserBridgeCapabilities",
  "BrowserBridgeClientMessage",
  "BrowserBridgeCommandOutcome",
  "BrowserBridgeFailureCode",
  "BrowserBridgeOperation",
  "BrowserBridgeRequest",
  "BrowserBridgeResult",
  "BrowserBridgeRunCompletion",
  "BrowserBridgeServerMessage",
  "BrowserCapturedImage",
  "BrowserCapturedLink",
  "BrowserEvidenceReference",
  "BrowserEvidenceKind",
  "BrowserPageCapture",
  "BrowserPaymentEvidence",
  "BrowserChoice",
] as const;

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

// The native client carries every resources.<entity>.{list,get,create,update,
// timeline} operation the HTTP document exposes: the generic list, detail and
// editor screens run over every resource entity, so the op set is the
// document's, not an opt-in list (delete stays off the generated client —
// the app deletes through the kernel command). RPC ids are opt-in through
// `native:` on the contract member; the generator config is written from
// the document and those flags so they cannot drift.
const isAutomaticResourceOperation = (id: string) =>
  /^resources\.[^.]+\.(?:list|get|create|update|timeline)$/u.test(id);
/**
 * The operation ids the swift-openapi-generator client carries: every
 * automatic one plus the flagged ones (sorted, deduplicated by the caller).
 */
const nativeOperationIds = (
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
    source: `${yamlGeneratedHeader}# Every resources.*.{list,get,create,update,timeline} operation in the HTTP
# document, plus the RPC ids flagged \`native:\` in apps/web/src/contracts.
generate:
  - types
  - client
# These land in the CubbyAPI target; \`public\` lets CubbyKit and the App name them
# through the generated aliases in CubbyKit/Generated/APITypes.swift.
accessModifier: public
namingStrategy: idiomatic
${optional}filter:
  schemas:
${NATIVE_COMPONENT_ROOTS.map((name) => `    - ${name}`).join("\n")}
  operations:
${generatedOperations.map((id) => `    - ${id}`).join("\n")}
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

type NativeHttpAction = "list" | "timeline" | "get" | "create" | "update" | "delete";

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
  const generatedOperations = nativeOperationIds(swiftRoutes, nativeOperations);
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
    renderApiTypes(
      document,
      components,
      generatedOperationIds,
      entityOutputs,
      NATIVE_COMPONENT_ROOTS,
    ),
  ];
};
