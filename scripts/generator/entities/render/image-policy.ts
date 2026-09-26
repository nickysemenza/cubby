import { generatedHeader } from "../../artifacts.ts";
import {
  photoCategories,
  photoCategoryKeys,
} from "../../../../packages/schemas/src/photo-categories.ts";
import { IMAGE_FIELD_KEYS } from "../../../../packages/schemas/src/image-field-keys.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";

/**
 * Single source of truth for the manifest vocabularies shared by the TS union
 * types below and the generated Swift enums (see `swiftEnum`): both are
 * derived from these arrays so the two representations cannot drift.
 */
const ROUTE_KINDS = [
  "self",
  "existingRelated",
  "createRelated",
  "createSelf",
] as const;
const ROUTE_CHOICES = ["primary", "alternate", "prompt"] as const;
const IMAGE_STORAGE_VALUES = ["gallery", "cover", "logo"] as const;
/** `imageIngressBindingMetadataSchema` discriminant, packages/schemas/src/entity-definitions/definition.ts. */
const BINDING_SOURCES = [
  "source-id",
  "source-id-list",
  "source-field",
  "capture-date",
  "constant",
  "relation-items",
] as const;
const DISPLAY_ORDERINGS = ["declared", "newest", "oldest"] as const;

/** Renders a TS union-of-string-literals type from a wire-value array. */
const unionType = (values: readonly string[]): string =>
  values.map((value) => JSON.stringify(value)).join(" | ");

type DeclaredImageIngressChoice =
  CompiledEntity["imagePolicy"]["ingress"][number]["choice"];
type ConditionalImageIngressChoice = Exclude<
  DeclaredImageIngressChoice,
  string
>;

/** `allowInTypeGuards` (`.oxlintrc.json`) permits `typeof` only inside a declared type
 * predicate — this is the one place that decodes the union so nothing downstream re-checks it. */
const isConditionalChoice = (
  choice: DeclaredImageIngressChoice,
): choice is ConditionalImageIngressChoice => typeof choice === "object";

type ImageRoutePredicate = {
  readonly field: string;
  readonly oneOf: readonly string[];
};

type ImageRoute = {
  readonly routeId: string;
  readonly sourceEntity: string;
  readonly targetEntity: string;
  readonly kind: (typeof ROUTE_KINDS)[number];
  readonly storage: false | (typeof IMAGE_STORAGE_VALUES)[number];
  readonly relationPath: readonly string[];
  readonly bindings: readonly ImageIngressBinding[];
  readonly append: boolean;
  readonly requiresReplaceConfirmation: boolean;
  /** The resolved literal — a conditional `choice.primary.when` resolves to its `otherwise`. */
  readonly choice: (typeof ROUTE_CHOICES)[number];
  /** Set only for a conditional-primary route: a satisfied predicate outranks `choice`. */
  readonly primaryWhen: ImageRoutePredicate | null;
  readonly enabled: boolean;
  readonly disabledReason: string | null;
};

type ImageIngressBinding =
  | Readonly<{
      field: string;
      from: "source-id" | "source-id-list" | "capture-date";
    }>
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
        route.kind === "self" || route.kind === "createSelf"
          ? entity.key
          : pathTarget(entities, entity, route.relationPath);
      const targetStorage =
        entities.find((candidate) => candidate.key === targetEntity)
          ?.imagePolicy.storage ?? false;
      // `createSelf.storage` overrides the created record's own declared storage for this
      // route only; every other kind always derives storage from its target entity.
      const storage =
        route.kind === "createSelf" && route.storage !== undefined
          ? route.storage
          : targetStorage;
      const choice = isConditionalChoice(route.choice)
        ? route.choice.otherwise
        : route.choice;
      const primaryWhen: ImageRoutePredicate | null = isConditionalChoice(
        route.choice,
      )
        ? {
            field: route.choice.primary.when.field,
            oneOf: route.choice.primary.when.oneOf,
          }
        : null;
      return {
        routeId: route.routeId,
        sourceEntity: entity.key,
        targetEntity,
        kind: route.kind,
        storage,
        relationPath:
          route.kind === "self" || route.kind === "createSelf"
            ? []
            : route.relationPath,
        bindings:
          route.kind === "createRelated" || route.kind === "createSelf"
            ? route.bindings
            : [],
        append: storage === "gallery",
        requiresReplaceConfirmation: storage === "cover" || storage === "logo",
        choice,
        primaryWhen,
        enabled: route.kind === "createSelf" ? route.enabled : true,
        disabledReason:
          route.kind === "createSelf" ? (route.disabledReason ?? null) : null,
      };
    }),
  );

/** Typescript and Swift consume the same compiled, entity-name-free photo policy. */
export const renderImagePolicyArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const routes = imageRoutes(entities);
  const displayBindings = Object.fromEntries(
    entities.map((entity) => [
      entity.key,
      entity.imagePolicy.displaySources.map((source) => ({
        ...source,
        targetEntity: pathTarget(entities, entity, source.relationPath),
      })),
    ]),
  );
  const visualEvidenceBindings = Object.fromEntries(
    entities.map((entity) => [
      entity.key,
      (entity.imagePolicy.routing?.visualEvidence ?? []).map((evidence) => ({
        ...evidence,
        targetEntity: pathTarget(entities, entity, evidence.relationPath),
      })),
    ]),
  );
  const routingPolicies = Object.fromEntries(
    entities.map((entity) => {
      const routing = entity.imagePolicy.routing;
      if (routing === null) return [entity.key, null];
      return [
        entity.key,
        {
          ...routing,
          visualEvidence: visualEvidenceBindings[entity.key] ?? [],
        },
      ];
    }),
  );
  // Effective labels = each category's declared base vocabulary UNION every member entity's
  // own `signals.classifierLabels` — computed once, here, and emitted as data to both TS and
  // Swift so neither side recomputes (or can drift on) the union at runtime.
  const categoryList = photoCategoryKeys.map((key) => {
    const base = photoCategories[key];
    const members = entities.filter(
      (entity) => entity.imagePolicy.routing?.category === key,
    );
    const classifierLabels = [
      ...new Set([
        ...base.classifierLabels,
        ...members.flatMap(
          (entity) =>
            entity.imagePolicy.routing?.signals.classifierLabels ?? [],
        ),
      ]),
    ];
    return {
      key,
      label: base.label,
      emoji: base.emoji,
      classifierLabels,
      entities: members.map((entity) => entity.key),
    };
  });
  const categoryCatalog = Object.fromEntries(
    categoryList.map((category) => [category.key, category]),
  );
  const policyCatalog = Object.fromEntries(
    entities.map((entity) => [
      entity.key,
      {
        storage: entity.imagePolicy.storage,
        displaySources: displayBindings[entity.key] ?? [],
        ingress: routes.filter((route) => route.sourceEntity === entity.key),
        routing: routingPolicies[entity.key] ?? null,
      },
    ]),
  );
  const ts =
    generatedHeader +
    'import type { Entity } from "../entity";\n' +
    'import type { PhotoCategoryKey } from "../photo-categories";\n\n' +
    `export type ImageStorage = false | ${unionType(IMAGE_STORAGE_VALUES)};\n` +
    'export type ImageIngressBinding = { readonly field: string; readonly from: "source-id" | "source-id-list" | "capture-date" } | { readonly field: string; readonly from: "source-field"; readonly sourceField: string } | { readonly field: string; readonly from: "constant"; readonly value: string | number | boolean | null } | { readonly field: string; readonly from: "relation-items"; readonly item: { readonly field: string; readonly from: "source-id" | "source-field" | "constant"; readonly sourceField?: string; readonly value?: string | number | boolean | null } };\n' +
    "type ImageRoutePredicate = { readonly field: string; readonly oneOf: readonly string[] };\n" +
    `export type ImageIngressRoute = { readonly routeId: string; readonly sourceEntity: Entity; readonly targetEntity: Entity; readonly kind: ${unionType(ROUTE_KINDS)}; readonly storage: ImageStorage; readonly relationPath: readonly string[]; readonly bindings: readonly ImageIngressBinding[]; readonly append: boolean; readonly requiresReplaceConfirmation: boolean; readonly choice: ${unionType(ROUTE_CHOICES)}; readonly primaryWhen: ImageRoutePredicate | null; readonly enabled: boolean; readonly disabledReason: string | null };\n` +
    `export type ImageDisplayBinding = { readonly relationPath: readonly string[]; readonly targetEntity: Entity; readonly priority: number; readonly ordering: ${unionType(DISPLAY_ORDERINGS)}; readonly identityEvidence: false };\n\n` +
    `type ImageVisualEvidenceBinding = { readonly relationPath: readonly string[]; readonly targetEntity: Entity; readonly priority: number; readonly ordering: ${unionType(DISPLAY_ORDERINGS)} };\n\n` +
    "export type ImageRoutingPolicy = { readonly candidateFields: readonly string[]; readonly temporalFields: readonly string[]; readonly lifecycleFilters: readonly ({ readonly field: string; readonly equals: string | boolean } | { readonly field: string; readonly oneOf: readonly (string | boolean)[] })[]; readonly signals: { readonly ocrFields: readonly string[]; readonly classifierLabels: readonly string[] }; readonly visualEvidence: readonly ImageVisualEvidenceBinding[]; readonly abstention: { readonly minimumScore: number; readonly minimumMargin: number }; readonly category: PhotoCategoryKey };\n" +
    "export type ImagePolicy = { readonly storage: ImageStorage; readonly displaySources: readonly ImageDisplayBinding[]; readonly ingress: readonly ImageIngressRoute[]; readonly routing: ImageRoutingPolicy | null };\n\n" +
    `export const imagePolicyCatalog = ${JSON.stringify(policyCatalog)} as const satisfies Record<Entity, ImagePolicy>;\n\n` +
    "export type PhotoCategory = { readonly key: PhotoCategoryKey; readonly label: string; readonly emoji: string; readonly classifierLabels: readonly string[]; readonly entities: readonly Entity[] };\n" +
    `export const photoCategories = ${JSON.stringify(categoryCatalog)} as const satisfies Record<PhotoCategoryKey, PhotoCategory>;\n`;
  /** Wire string ("source-field") -> Swift enum case identifier (sourceField). `self` is a Swift
   * keyword, so that one case is backticked; the same identifier is valid at both the
   * declaration site and every `.<case>` reference. */
  const swiftCaseIdentifier = (wire: string): string => {
    const camel = wire.replace(/-([a-z0-9])/g, (_match, char: string) =>
      char.toUpperCase(),
    );
    return camel === "self" ? "`self`" : camel;
  };
  /** Emits a `String`-backed enum whose cases are derived from a wire-value array (see the
   * `ROUTE_KINDS`-style consts above), so the Swift and TS vocabularies cannot drift. */
  const swiftEnum = (name: string, wireValues: readonly string[]): string =>
    `public enum ${name}: String, Sendable, Hashable, CaseIterable {\n` +
    wireValues
      .map(
        (wire) =>
          `  case ${swiftCaseIdentifier(wire)} = ${JSON.stringify(wire)}`,
      )
      .join("\n") +
    "\n}\n\n";
  const swiftBinding = (binding: ImageIngressBinding): string => {
    const item = binding.from === "relation-items" ? binding.item : undefined;
    const sourceField =
      binding.from === "source-field" ? binding.sourceField : item?.sourceField;
    const constant = binding.from === "constant" ? binding.value : item?.value;
    return `PhotoCreateBinding(field: ${JSON.stringify(binding.field)}, source: .${swiftCaseIdentifier(binding.from)}, sourceField: ${sourceField === undefined ? "nil" : JSON.stringify(sourceField)}, constantJSON: ${constant === undefined ? "nil" : JSON.stringify(JSON.stringify(constant))}, itemField: ${item === undefined ? "nil" : JSON.stringify(item.field)}, itemSource: ${item === undefined ? "nil" : `.${swiftCaseIdentifier(item.from)}`})`;
  };
  const swiftPredicate = (predicate: ImageRoutePredicate | null): string =>
    predicate === null
      ? "nil"
      : `PhotoSourceFieldPredicate(field: ${JSON.stringify(predicate.field)}, values: ${JSON.stringify(predicate.oneOf)})`;
  const swiftRoutes = routes
    .map(
      (route) =>
        `    PhotoIngressRoute(id: ${JSON.stringify(route.routeId)}, source: .${route.sourceEntity}, target: .${route.targetEntity}, kind: .${swiftCaseIdentifier(route.kind)}, storage: ${route.storage === false ? "nil" : `.${swiftCaseIdentifier(route.storage)}`}, relationPath: ${JSON.stringify(route.relationPath)}, bindings: [${route.bindings.map(swiftBinding).join(", ")}], append: ${route.append}, requiresReplaceConfirmation: ${route.requiresReplaceConfirmation}, choice: .${swiftCaseIdentifier(route.choice)}, primaryWhen: ${swiftPredicate(route.primaryWhen)}, enabled: ${route.enabled}, disabledReason: ${route.disabledReason === null ? "nil" : JSON.stringify(route.disabledReason)})`,
    )
    .join(",\n");
  const swiftDisplaySources = Object.entries(displayBindings)
    .flatMap(([source, bindings]) =>
      bindings.map(
        (binding) =>
          `    PhotoDisplaySource(source: .${source}, target: .${binding.targetEntity}, relationPath: ${JSON.stringify(binding.relationPath)}, priority: ${binding.priority}, ordering: .${swiftCaseIdentifier(binding.ordering)})`,
      ),
    )
    .join(",\n");
  const swiftVisualEvidence = Object.entries(visualEvidenceBindings)
    .flatMap(([source, bindings]) =>
      bindings.map(
        (binding) =>
          `    PhotoVisualEvidence(source: .${source}, target: .${binding.targetEntity}, relationPath: ${JSON.stringify(binding.relationPath)}, priority: ${binding.priority}, ordering: .${swiftCaseIdentifier(binding.ordering)})`,
      ),
    )
    .join(",\n");
  const swiftRoutingPolicies = entities
    .flatMap((entity) => {
      const routing = entity.imagePolicy.routing;
      if (routing === null) return [];
      return [
        `    .${entity.key}: PhotoRoutingPolicy(candidateFields: ${JSON.stringify(routing.candidateFields)}, temporalFields: ${JSON.stringify(routing.temporalFields)}, lifecycleFilters: [${routing.lifecycleFilters.map((filter) => `PhotoLifecycleFilter(field: ${JSON.stringify(filter.field)}, equals: ${"equals" in filter ? JSON.stringify(String(filter.equals)) : "nil"}, oneOf: ${"oneOf" in filter ? JSON.stringify(filter.oneOf.map(String)) : "[]"})`).join(", ")}], ocrFields: ${JSON.stringify(routing.signals.ocrFields)}, classifierLabels: ${JSON.stringify(routing.signals.classifierLabels)}, minimumScore: ${routing.abstention.minimumScore}, minimumMargin: ${routing.abstention.minimumMargin}, category: ${JSON.stringify(routing.category)})`,
      ];
    })
    .join(",\n");
  // One static array element per category, not a giant literal: each category is its own
  // `PhotoCategory(...)` call, mirroring the one-static-per-route convention above.
  const swiftCategories = categoryList
    .map(
      (category) =>
        `    PhotoCategory(key: ${JSON.stringify(category.key)}, label: ${JSON.stringify(category.label)}, emoji: ${JSON.stringify(category.emoji)}, classifierLabels: ${JSON.stringify(category.classifierLabels)}, entities: [${category.entities.map((entity) => `.${entity}`).join(", ")}])`,
    )
    .join(",\n");
  const swift =
    generatedHeader +
    "// swift-format-ignore-file\n\n" +
    swiftEnum("PhotoIngressRouteKind", ROUTE_KINDS) +
    swiftEnum("PhotoRouteChoice", ROUTE_CHOICES) +
    swiftEnum("PhotoImageStorage", IMAGE_STORAGE_VALUES) +
    swiftEnum("PhotoBindingSource", BINDING_SOURCES) +
    swiftEnum("PhotoDisplayOrdering", DISPLAY_ORDERINGS) +
    "public struct PhotoCreateBinding: Sendable, Hashable {\n  public let field: String\n  public let source: PhotoBindingSource\n  public let sourceField: String?\n  public let constantJSON: String?\n  public let itemField: String?\n  public let itemSource: PhotoBindingSource?\n}\n\n" +
    "public struct PhotoSourceFieldPredicate: Sendable, Hashable {\n  public let field: String\n  public let values: [String]\n}\n\n" +
    "public struct PhotoIngressRoute: Sendable, Hashable {\n" +
    "  public let id: String\n  public let source: EntityKey\n  public let target: EntityKey\n  public let kind: PhotoIngressRouteKind\n  public let storage: PhotoImageStorage?\n  public let relationPath: [String]\n  public let bindings: [PhotoCreateBinding]\n  public let append: Bool\n  public let requiresReplaceConfirmation: Bool\n  public let choice: PhotoRouteChoice\n  /** Set only for a conditional-primary route: a satisfied predicate outranks `choice`. */\n  public let primaryWhen: PhotoSourceFieldPredicate?\n  public let enabled: Bool\n  public let disabledReason: String?\n}\n\n" +
    "public struct PhotoDisplaySource: Sendable, Hashable {\n  public let source: EntityKey\n  public let target: EntityKey\n  public let relationPath: [String]\n  public let priority: Int\n  public let ordering: PhotoDisplayOrdering\n}\n\n" +
    "public struct PhotoVisualEvidence: Sendable, Hashable {\n  public let source: EntityKey\n  public let target: EntityKey\n  public let relationPath: [String]\n  public let priority: Int\n  public let ordering: PhotoDisplayOrdering\n}\n\n" +
    "public struct PhotoLifecycleFilter: Sendable, Hashable {\n  public let field: String\n  public let equals: String?\n  public let oneOf: [String]\n}\n\n" +
    "public struct PhotoRoutingPolicy: Sendable, Hashable {\n  public let candidateFields: [String]\n  public let temporalFields: [String]\n  public let lifecycleFilters: [PhotoLifecycleFilter]\n  public let ocrFields: [String]\n  public let classifierLabels: [String]\n  public let minimumScore: Double\n  public let minimumMargin: Double\n  public let category: String\n}\n\n" +
    "public struct PhotoCategory: Sendable, Hashable {\n  public let key: String\n  public let label: String\n  public let emoji: String\n  /** Base labels UNION every member entity's own classifier labels — computed by the\n   * generator (scripts/generator/entities/render/image-policy.ts); never recompute here. */\n  public let classifierLabels: [String]\n  public let entities: [EntityKey]\n}\n\n" +
    "public enum PhotoImportCatalog {\n" +
    `  /** Entity-create-body keys that stage an image action rather than a real field —\n   * derived from \`updateInputImages\` (packages/schemas/src/image.ts) so it cannot drift\n   * from the wire schema's own list. */\n  public static let imageFieldKeys: Set<String> = [${IMAGE_FIELD_KEYS.map((key) => JSON.stringify(key)).join(", ")}]\n` +
    "  public static let categories: [PhotoCategory] = [\n" +
    swiftCategories +
    "\n  ]\n  public static let ingressRoutes: [PhotoIngressRoute] = [\n" +
    swiftRoutes +
    "\n  ]\n  public static let displaySources: [PhotoDisplaySource] = [\n" +
    swiftDisplaySources +
    "\n  ]\n  public static let visualEvidence: [PhotoVisualEvidence] = [\n" +
    swiftVisualEvidence +
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
