import { generatedHeader } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";

type ImageRoute = {
  readonly routeId: string;
  readonly sourceEntity: string;
  readonly targetEntity: string;
  readonly kind: "self" | "existingRelated" | "createRelated";
  readonly storage: false | "gallery" | "cover" | "logo";
  readonly relationPath: readonly string[];
  readonly bindings: readonly ImageIngressBinding[];
  readonly append: boolean;
  readonly requiresReplaceConfirmation: boolean;
  readonly choice: "primary" | "alternate" | "prompt";
};

type ImageIngressBinding =
  | Readonly<{ field: string; from: "source-id" | "capture-date" }>
  | Readonly<{ field: string; from: "source-field"; sourceField: string }>
  | Readonly<{
      field: string;
      from: "constant";
      value: string | number | boolean | null;
    }>
  | Readonly<{
      field: string;
      from: "relation-items";
      item: Readonly<{
        field: string;
        from: "source-id" | "source-field" | "constant";
        sourceField?: string;
        value?: string | number | boolean | null;
      }>;
    }>;

const pathTarget = (
  entities: readonly CompiledEntity[],
  source: CompiledEntity,
  path: readonly string[],
): string => {
  let current = source;
  for (const key of path) {
    const relation = current.relations.find(
      (candidate) => candidate.key === key,
    );
    if (relation === undefined)
      throw new Error(`Unknown image relation ${current.key}.${key}`);
    const target = entities.find(
      (candidate) => candidate.key === relation.target,
    );
    if (target === undefined)
      throw new Error(`Unknown image target ${relation.target}`);
    current = target;
  }
  return current.key;
};

const imageRoutes = (entities: readonly CompiledEntity[]): ImageRoute[] =>
  entities.flatMap((entity) =>
    entity.imagePolicy.ingress.map((route) => {
      const targetEntity =
        route.kind === "self"
          ? entity.key
          : pathTarget(entities, entity, route.relationPath);
      const storage =
        entities.find((candidate) => candidate.key === targetEntity)
          ?.imagePolicy.storage ?? false;
      return {
        routeId: route.routeId,
        sourceEntity: entity.key,
        targetEntity,
        kind: route.kind,
        storage,
        relationPath: route.kind === "self" ? [] : route.relationPath,
        bindings: route.kind === "createRelated" ? route.bindings : [],
        append: storage === "gallery",
        requiresReplaceConfirmation: storage === "cover" || storage === "logo",
        choice: route.choice,
      };
    }),
  );

/** Typescript and Swift consume the same compiled, entity-name-free photo policy. */
export const renderImagePolicyArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const owners = entities
    .filter((entity) => entity.imagePolicy.storage !== false)
    .map((entity) => ({
      entity: entity.key,
      storage: entity.imagePolicy.storage,
      append: entity.imagePolicy.storage === "gallery",
      requiresReplaceConfirmation:
        entity.imagePolicy.storage === "cover" ||
        entity.imagePolicy.storage === "logo",
    }));
  const routes = imageRoutes(entities);
  const routesById = Object.fromEntries(
    routes.map((route) => [route.routeId, route]),
  );
  const displayBindings = Object.fromEntries(
    entities.map((entity) => [
      entity.key,
      entity.imagePolicy.displaySources.map((source) => ({
        ...source,
        targetEntity: pathTarget(entities, entity, source.relationPath),
      })),
    ]),
  );
  const policyCatalog = Object.fromEntries(
    entities.map((entity) => [
      entity.key,
      {
        storage: entity.imagePolicy.storage,
        displaySources: displayBindings[entity.key] ?? [],
        ingress: routes.filter((route) => route.sourceEntity === entity.key),
        routing: entity.imagePolicy.routing,
      },
    ]),
  );
  const ts =
    generatedHeader +
    'import type { Entity } from "../entity";\n\n' +
    'export type ImageStorage = false | "gallery" | "cover" | "logo";\n' +
    'export type ImageIngressBinding = { readonly field: string; readonly from: "source-id" | "capture-date" } | { readonly field: string; readonly from: "source-field"; readonly sourceField: string } | { readonly field: string; readonly from: "constant"; readonly value: string | number | boolean | null } | { readonly field: string; readonly from: "relation-items"; readonly item: { readonly field: string; readonly from: "source-id" | "source-field" | "constant"; readonly sourceField?: string; readonly value?: string | number | boolean | null } };\n' +
    'export type ImageIngressRoute = { readonly routeId: string; readonly sourceEntity: Entity; readonly targetEntity: Entity; readonly kind: "self" | "existingRelated" | "createRelated"; readonly storage: ImageStorage; readonly relationPath: readonly string[]; readonly bindings: readonly ImageIngressBinding[]; readonly append: boolean; readonly requiresReplaceConfirmation: boolean; readonly choice: "primary" | "alternate" | "prompt" };\n' +
    'export type ImageDisplayBinding = { readonly relationPath: readonly string[]; readonly targetEntity: Entity; readonly priority: number; readonly ordering: "declared" | "newest" | "oldest"; readonly identityEvidence: false };\n\n' +
    "export type ImageRoutingPolicy = { readonly candidateFields: readonly string[]; readonly temporalFields: readonly string[]; readonly lifecycleFilters: readonly ({ readonly field: string; readonly equals: string | boolean } | { readonly field: string; readonly oneOf: readonly (string | boolean)[] })[]; readonly signals: { readonly ocrFields: readonly string[]; readonly classifierLabels: readonly string[] }; readonly abstention: { readonly minimumScore: number; readonly minimumMargin: number } };\n" +
    "export type ImagePolicy = { readonly storage: ImageStorage; readonly displaySources: readonly ImageDisplayBinding[]; readonly ingress: readonly ImageIngressRoute[]; readonly routing: ImageRoutingPolicy | null };\n\n" +
    `export const imagePolicyCatalog = ${JSON.stringify(policyCatalog)} as const satisfies Record<Entity, ImagePolicy>;\n\n` +
    `export const imageOwners = ${JSON.stringify(owners)} as const;\n` +
    "export type ImageOwner = (typeof imageOwners)[number];\n\n" +
    `export const imageIngressRoutes = ${JSON.stringify(routes)} as const satisfies readonly ImageIngressRoute[];\n` +
    'export type ImageIngressRouteId = (typeof imageIngressRoutes)[number]["routeId"];\n' +
    `export const imageIngressRouteById = ${JSON.stringify(routesById)} as const satisfies Record<ImageIngressRouteId, ImageIngressRoute>;\n\n` +
    `export const imageDisplayBindings = ${JSON.stringify(displayBindings)} as const satisfies Record<Entity, readonly ImageDisplayBinding[]>;\n`;
  const swiftBinding = (binding: ImageIngressBinding): string => {
    const item = binding.from === "relation-items" ? binding.item : undefined;
    const sourceField =
      binding.from === "source-field" ? binding.sourceField : item?.sourceField;
    const constant = binding.from === "constant" ? binding.value : item?.value;
    return `PhotoCreateBinding(field: ${JSON.stringify(binding.field)}, source: ${JSON.stringify(binding.from)}, sourceField: ${sourceField === undefined ? "nil" : JSON.stringify(sourceField)}, constantJSON: ${constant === undefined ? "nil" : JSON.stringify(JSON.stringify(constant))}, itemField: ${item === undefined ? "nil" : JSON.stringify(item.field)}, itemSource: ${item === undefined ? "nil" : JSON.stringify(item.from)})`;
  };
  const swiftRoutes = routes
    .map(
      (route) =>
        `    PhotoIngressRoute(id: ${JSON.stringify(route.routeId)}, source: .${route.sourceEntity}, target: .${route.targetEntity}, kind: ${JSON.stringify(route.kind)}, storage: ${route.storage === false ? "nil" : JSON.stringify(route.storage)}, relationPath: ${JSON.stringify(route.relationPath)}, bindings: [${route.bindings.map(swiftBinding).join(", ")}], append: ${route.append}, requiresReplaceConfirmation: ${route.requiresReplaceConfirmation}, choice: ${JSON.stringify(route.choice)})`,
    )
    .join(",\n");
  const swiftDisplaySources = Object.entries(displayBindings)
    .flatMap(([source, bindings]) =>
      bindings.map(
        (binding) =>
          `    PhotoDisplaySource(source: .${source}, target: .${binding.targetEntity}, relationPath: ${JSON.stringify(binding.relationPath)}, priority: ${binding.priority}, ordering: ${JSON.stringify(binding.ordering)})`,
      ),
    )
    .join(",\n");
  const swiftRoutingPolicies = entities
    .flatMap((entity) => {
      const routing = entity.imagePolicy.routing;
      if (routing === null) return [];
      return [
        `    .${entity.key}: PhotoRoutingPolicy(candidateFields: ${JSON.stringify(routing.candidateFields)}, temporalFields: ${JSON.stringify(routing.temporalFields)}, lifecycleFilters: [${routing.lifecycleFilters.map((filter) => `PhotoLifecycleFilter(field: ${JSON.stringify(filter.field)}, equals: ${"equals" in filter ? JSON.stringify(String(filter.equals)) : "nil"}, oneOf: ${"oneOf" in filter ? JSON.stringify(filter.oneOf.map(String)) : "[]"})`).join(", ")}], ocrFields: ${JSON.stringify(routing.signals.ocrFields)}, classifierLabels: ${JSON.stringify(routing.signals.classifierLabels)}, minimumScore: ${routing.abstention.minimumScore}, minimumMargin: ${routing.abstention.minimumMargin})`,
      ];
    })
    .join(",\n");
  const swift =
    generatedHeader +
    "// swift-format-ignore-file\n\n" +
    "public struct PhotoCreateBinding: Sendable, Hashable {\n  public let field: String\n  public let source: String\n  public let sourceField: String?\n  public let constantJSON: String?\n  public let itemField: String?\n  public let itemSource: String?\n}\n\n" +
    "public struct PhotoIngressRoute: Sendable, Hashable {\n" +
    "  public let id: String\n  public let source: EntityKey\n  public let target: EntityKey\n  public let kind: String\n  public let storage: String?\n  public let relationPath: [String]\n  public let bindings: [PhotoCreateBinding]\n  public let append: Bool\n  public let requiresReplaceConfirmation: Bool\n  public let choice: String\n}\n\n" +
    "public struct PhotoDisplaySource: Sendable, Hashable {\n  public let source: EntityKey\n  public let target: EntityKey\n  public let relationPath: [String]\n  public let priority: Int\n  public let ordering: String\n}\n\n" +
    "public struct PhotoLifecycleFilter: Sendable, Hashable {\n  public let field: String\n  public let equals: String?\n  public let oneOf: [String]\n}\n\n" +
    "public struct PhotoRoutingPolicy: Sendable, Hashable {\n  public let candidateFields: [String]\n  public let temporalFields: [String]\n  public let lifecycleFilters: [PhotoLifecycleFilter]\n  public let ocrFields: [String]\n  public let classifierLabels: [String]\n  public let minimumScore: Double\n  public let minimumMargin: Double\n}\n\n" +
    "public enum PhotoImportCatalog {\n  public static let ingressRoutes: [PhotoIngressRoute] = [\n" +
    swiftRoutes +
    "\n  ]\n  public static let displaySources: [PhotoDisplaySource] = [\n" +
    swiftDisplaySources +
    "\n  ]\n  public static let routingPolicies: [EntityKey: PhotoRoutingPolicy] = [\n" +
    swiftRoutingPolicies +
    "\n  ]\n}\n";
  return [
    {
      relativePath: "packages/schemas/src/generated/image-policy.gen.ts",
      source: ts,
    },
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyKit/Generated/PhotoImportCatalog.swift",
      source: swift,
    },
  ];
};
