import { z } from "zod";

import {
  entityFieldControlKinds as fieldControlKinds,
  entityFieldKinds as fieldKinds,
} from "../../../../packages/schemas/src/entity-definitions/definition.ts";
import { compactLiteral, generatedHeader } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import { renderRecord } from "./record.ts";
import { lowerCamelCase } from "./routes.ts";
import { bulkUpdateFor, resolvedPrimarySearch } from "./shared.ts";

const GENERATED = "packages/schemas/src/generated";

/** `usda-food` → `usdaFood`: the identifier stem of one entity's generated exports. */
export const entityIdentifier = (key: string): string =>
  lowerCamelCase(
    key.replaceAll(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
  );
export const entityModelExport = (key: string) =>
  `${entityIdentifier(key)}EntityModel`;
const entityInspectorExport = (key: string) =>
  `${entityIdentifier(key)}EntityInspector`;
const entityModelModule = (key: string) => `entity-model.${key}.gen`;
const entityInspectorModule = (key: string) => `entity-inspector.${key}.gen`;

const fieldModelType =
  "export type GeneratedEntityFieldModel = {\n" +
  '  fields: readonly { key: string; kind: GeneratedEntityFieldKind; nullable: boolean; requiredOnCreate: boolean; label: string; description: string | null; readKey: string | null; reference: { entity: string; multiple: boolean; scope: readonly { sourceField: string; targetField: string }[]; filters: readonly { field: string; values: readonly string[] }[] } | null; explanation: { ruleId: string; version: number; description: string; readPath?: string; resolver: "field" | "inventoryOwnership" | "productValuation" | "imageRepresentation" | "imageCapture" | "productQuantity" | "recipeTotals" | "locationValuation" | "merchantVendorInference" | "expenseAttribution"; projections?: Readonly<{ list?: string; detail?: string; summary?: string }>; sourceDependencies?: readonly Readonly<{ path: string; label: string }>[]; actions?: readonly ("confirmOwner" | "inheritOwner" | "editSource")[] } | null; resolution: { reset: Readonly<Record<string, GeneratedEntityFieldResolutionValue>>; none: Readonly<Record<string, GeneratedEntityFieldResolutionValue>> | null; redundancy: "eligible" | "intentional" } | null; provenance: GeneratedEntityFieldProvenance | null; control: { kind: GeneratedEntityFieldControlKind; renderer: string | null; options: readonly { value: string; label: string; description?: string; color?: string }[] | null; width: "half" | null; placeholder: string | null; initial: "today" | { value: string | number | boolean | null } | null; required: boolean | null; suggest: { readonly basis: readonly string[]; readonly mode: "fill" | "prune"; readonly reviewRequired: boolean } | null } | null; display: { list: boolean; detail: boolean; columnId: string | null; standard: "name" | "image" | null; detailOrder: number | null; listOrder: number | null; width: "xs" | "sm" | "md" | "lg" | null; readPath: string | null; labelPath: string | null; detailLabelPath?: string | null; itemsPath?: string | null; format: "currency" | "signedCurrency" | "plainDate" | "timestamp" | "external-link" | "amount" | "presence" | "bytes" | "join" | "arrayCount" | "count" | null; renderer: { list: string | null; detail: string | null } | null; mobile: { slot: string; priority: number; interactive?: boolean } | null; listHidden: boolean; referencePreviewLimit: number | null; valueOptions: { value: string; label: string; color?: string }[] | null; preview: boolean } }[];\n' +
  '  storage: readonly { key: string; column: string; kind: GeneratedEntityFieldKind; nullable: boolean; default: "none" | "generated" | "now" | "literal"; defaultValue: unknown; reference: string | null; specialized: string | null }[];\n' +
  "  create: readonly string[];\n" +
  "  update: readonly string[];\n" +
  "  bulk: readonly string[];\n" +
  "  audit: readonly string[];\n" +
  "  output: readonly string[];\n" +
  "  research?: { readonly fillFields: readonly string[] };\n" +
  "};\n\n";

const inspectorTypes =
  "export type EntityInspectorMetadata = CompiledEntityPresentation & {\n" +
  "  singular: string;\n" +
  "  plural: string | null;\n" +
  "  shortcodePrefix: string | null;\n" +
  "  searchable: boolean;\n" +
  "  primarySearch: { key: string; placeholder: string } | null;\n" +
  "  browserRouted: boolean;\n" +
  "  auditable: boolean;\n" +
  "  hasImages: boolean;\n" +
  '  imageStorage: false | "gallery" | "cover" | "logo";\n' +
  "  displayImages: boolean;\n" +
  "  countable: boolean;\n" +
  '  kernelActions: readonly ("get" | "list" | "search" | "create" | "update" | "bulkUpdate" | "delete" | "merge" | "resolve")[];\n' +
  "  filterUrlKeys: readonly string[];\n" +
  "  filterDescriptors: readonly EntityFilterDescriptorMetadata[];\n" +
  '  mcpOperations: readonly ("get" | "list" | "search" | "create" | "update" | "delete" | "bulkUpdate" | "merge")[];\n' +
  '  mcpOwner: "kernel" | "workflow" | null;\n' +
  '  lifecycle: { softDelete: boolean; delete: { mode: "soft" | "hard"; bulk: boolean } | null; merge: boolean; bulkUpdate: { fields: readonly string[] } | null };\n' +
  '  operationOwners: { delete: "kernel" | "workflow" | null; merge: "kernel" | "workflow" | null };\n' +
  "  sourceRefs: { create?: string; update?: string; output: string; list: string; detail: string; mcpOutput: string; mcpList: string; mcpDetail: string } | null;\n" +
  "  ports: EntityPortSourceRoster;\n" +
  "  references: readonly Entity[];\n" +
  "};\n\n" +
  "type EntityPortSourceRef = { module: string; export: string };\n" +
  "type EntityInspectorOptionValue = string | number | boolean | null;\n" +
  "type EntityInspectorOption = Readonly<Record<string, EntityInspectorOptionValue>>;\n" +
  "type EntityFilterDescriptorMetadata = {\n" +
  "  columnId: string; field: string | null; urlKey: string; kind: string; placeholder: string;\n" +
  "  options: readonly EntityInspectorOption[] | null; optionsRef: EntityPortSourceRef | null; optionsKey: string | null;\n" +
  '  label: string | null; schemaDescription: string | null; deriveSchema: boolean; schemaFromRead: boolean; brandRef: { entity: string } | null; expandRef: EntityPortSourceRef | null; schemaRef: EntityPortSourceRef | null; stored: { columns: readonly string[]; array: boolean } | null; range: { kind: "number" | "date"; int: boolean; nonnegative: boolean; finite: boolean; describe: { lower: string; upper: string } | null } | null;\n' +
  "  urlOnly: boolean; nullable: { field: string; label: string } | null;\n" +
  '  wire: { kind: "param"; name: string } | { kind: "range"; from: string; to: string; presence?: string };\n' +
  "};\n" +
  "type EntityPortSourceRoster = {\n" +
  "  repository: EntityPortSourceRef | null;\n" +
  "  references: { label: EntityPortSourceRef | null; resolver: EntityPortSourceRef | null };\n" +
  "  filters: EntityPortSourceRef | null;\n" +
  "  search: { projection: EntityPortSourceRef | null; semanticText: EntityPortSourceRef | null; dependentRefresh: EntityPortSourceRef | null };\n" +
  "  timeline: EntityPortSourceRef | null;\n" +
  "};\n\n";

const summaryFor = (entity: CompiledEntity) => ({
  ...entity.inspector,
  primarySearch: resolvedPrimarySearch(entity),
  bulkUpdate: bulkUpdateFor(entity),
  merge: entity.operationOwners.merge === "kernel",
});

// The compiled descriptor is an opaque declaration object; its relations
// (`serializedDeclarationRelations`) always carry a key and a target.
const descriptorRelationsSchema = z
  .array(
    z.looseObject({ key: z.string(), label: z.string(), target: z.string() }),
  )
  .default([]);

/** One entity's declared relations: key and target entity, in declaration order. */
export const descriptorRelations = (entity: CompiledEntity) =>
  descriptorRelationsSchema.parse(entity.descriptor.relationships);

const descriptorFlag = (entity: CompiledEntity, key: string): boolean =>
  entity.descriptor[key] === true;

/**
 * The always-loaded facts one entity contributes to the slim index: names,
 * icons, wayfinding, the record mark fields, capability traits, the list's
 * opening views and filter, and relationship targets. Eager client code (the
 * navigation shell, link and icon rendering, list loaders) reads only this.
 */
const indexEntryFor = (entity: CompiledEntity) => {
  const { inspector, descriptor } = entity;
  return {
    singular: inspector.singular,
    plural: inspector.plural,
    titleField: inspector.titleField,
    domain: inspector.domain,
    description: inspector.description,
    emptyState: inspector.emptyState,
    recordEmojiField: inspector.recordEmojiField,
    recordIconEntityField: inspector.recordIconEntityField,
    icons: inspector.icons,
    primarySearch: resolvedPrimarySearch(entity),
    merge: entity.operationOwners.merge === "kernel",
    bulkUpdate: bulkUpdateFor(entity) !== null,
    shortcodePrefix: entity.shortcode,
    dbTable: descriptor.dbTable ?? null,
    softDelete: descriptorFlag(entity, "softDelete"),
    browserRoutes: descriptor.browserRoutes !== false,
    auditable: descriptorFlag(entity, "auditable"),
    hasImages: descriptorFlag(entity, "hasImages"),
    imageStorage: descriptor.imageStorage,
    displayImages: descriptorFlag(entity, "displayImages"),
    searchable: descriptorFlag(entity, "searchable"),
    embeddable: descriptorFlag(entity, "embeddable"),
    countable: descriptorFlag(entity, "countable"),
    references: [
      ...new Set(descriptorRelations(entity).map(({ target }) => target)),
    ],
    relations: descriptorRelations(entity).map(({ key, label, target }) => ({
      key,
      label,
      target,
    })),
    list: {
      views: inspector.list.views,
      initialFilter: inspector.list.initialFilter,
      viewAliases: inspector.list.viewAliases,
    },
  };
};

/**
 * The entity model artifacts: one heavy module per entity (field model,
 * summary, manifest descriptor), one inspector module per entity, the slim
 * always-loaded index, and the all-entities aggregates that re-collect the
 * per-entity modules for server, MCP, OpenAPI and Swift codegen consumers.
 *
 * Client code loads one entity's model through its route's generated client
 * module (`apps/web/src/entity/generated/clients/`) or the generated loaders;
 * the `cubby/no-client-entity-aggregate` lint rule keeps the aggregates out of
 * browser code (docs/adr/0009-per-entity-client-manifests.md).
 */
export const renderEntityModelArtifacts = <FieldModel, InspectorMetadata>({
  entities,
  fieldModels,
  inspectorMetadata,
  suggestFieldKeys,
}: {
  entities: readonly CompiledEntity[];
  fieldModels: Readonly<Record<string, FieldModel>>;
  inspectorMetadata: Readonly<Record<string, InspectorMetadata>>;
  suggestFieldKeys: readonly string[];
}): EntityArtifacts[] => {
  const perEntity = entities.flatMap((entity) => {
    const { key } = entity;
    return [
      {
        relativePath: `${GENERATED}/${entityModelModule(key)}.ts`,
        source:
          generatedHeader +
          'import type { EntityDescriptor } from "../entity-manifest";\n' +
          'import type { GeneratedEntityFieldModel } from "./entity-field-model.gen";\n' +
          'import type { EntitySummary } from "./entity-summary.gen";\n\n' +
          `/** One entity's field model, summary and manifest descriptor — the data its client module loads. */\n` +
          "// oxfmt-ignore\n" +
          `export const ${entityModelExport(key)} = ${compactLiteral({
            entity: key,
            fields: fieldModels[key],
            summary: summaryFor(entity),
            manifest: entity.descriptor,
          })} as const satisfies { entity: ${JSON.stringify(key)}; fields: GeneratedEntityFieldModel; summary: EntitySummary; manifest: EntityDescriptor };\n`,
      },
      {
        relativePath: `${GENERATED}/${entityInspectorModule(key)}.ts`,
        source:
          generatedHeader +
          'import type { EntityInspectorMetadata } from "./entity-inspector.gen";\n\n' +
          "// oxfmt-ignore\n" +
          `export const ${entityInspectorExport(key)} = ${compactLiteral(inspectorMetadata[key])} as const satisfies EntityInspectorMetadata;\n`,
      },
    ];
  });
  const importAll = (
    exportName: (key: string) => string,
    module: (key: string) => string,
  ) =>
    entities
      .map(
        ({ key }) =>
          `import { ${exportName(key)} } from ${JSON.stringify(`./${module(key)}`)};\n`,
      )
      .join("");
  const collect = (name: string, member: string, satisfies: string) =>
    "// oxfmt-ignore\n" +
    `export const ${name} = {\n${entities
      .map(
        ({ key }) =>
          `  ${JSON.stringify(key)}: ${entityModelExport(key)}${member},\n`,
      )
      .join("")}} as const satisfies ${satisfies};\n`;
  const aggregateNote =
    "// Server-side aggregate of the per-entity modules. Browser code loads one\n" +
    "// entity's module instead (`cubby/no-client-entity-aggregate`).\n";
  return [
    ...perEntity,
    {
      relativePath: `${GENERATED}/entity-index.gen.ts`,
      source:
        generatedHeader +
        // `entity-core` rather than `entity`: `entity-core`'s `entitySchema`
        // is `z.enum(entityKeys)`, and `entity.ts` reaches the manifest.
        'import type { Entity } from "../entity-core";\n' +
        'import type { EntityIndexEntry } from "../entity-index-types";\n\n' +
        "/**\n" +
        " * Every entity key, in declaration order. The leaf roster: `entity-core`'s\n" +
        " * `entitySchema` is `z.enum(entityKeys)`, so this tuple carries no `Entity`\n" +
        " * constraint of its own.\n" +
        " */\n" +
        renderRecord({
          name: "entityKeys",
          entries: entities.map(({ key }) => key),
        }) +
        "\n" +
        renderRecord({
          name: "entityIndex",
          entries: Object.fromEntries(
            entities.map((entity) => [entity.key, indexEntryFor(entity)]),
          ),
          satisfies: "Record<Entity, EntityIndexEntry>",
          comment:
            "// The slim always-loaded entity index: one small entry per entity.",
        }),
    },
    {
      relativePath: `${GENERATED}/entity-saved-views.gen.ts`,
      source:
        generatedHeader +
        'import type { Entity } from "../entity-core";\n' +
        'import type { CompiledEntityPresentation } from "../entity-definitions/definition";\n\n' +
        renderRecord({
          name: "entitySavedViews",
          entries: Object.fromEntries(
            entities.map((entity) => [
              entity.key,
              entity.inspector.list.savedViews,
            ]),
          ),
          satisfies:
            'Record<Entity, CompiledEntityPresentation["list"]["savedViews"]>',
          comment:
            "// Every entity's declared saved views: the view and problem registries\n" +
            "// span all entities, and only they load this (not the app shell).",
        }),
    },
    {
      relativePath: `${GENERATED}/entity-manifest-data.gen.ts`,
      source:
        generatedHeader +
        'import type { Entity } from "../entity";\n' +
        'import type { EntityDescriptor } from "../entity-manifest";\n' +
        importAll(entityModelExport, entityModelModule) +
        "\n" +
        aggregateNote +
        collect(
          "generatedEntityManifest",
          ".manifest",
          "Record<Entity, EntityDescriptor>",
        ),
    },
    {
      relativePath: `${GENERATED}/entity-summary.gen.ts`,
      source:
        generatedHeader +
        'import type { Entity } from "../entity-core";\n' +
        'import type { CompiledEntityPresentation } from "../entity-definitions/definition";\n' +
        importAll(entityModelExport, entityModelModule) +
        "\n" +
        'export { entityKeys } from "./entity-index.gen";\n' +
        'export { WAYFINDING_DOMAINS, WAYFINDING_DOMAIN_PRESENTATION } from "../entity-definitions/definition";\n' +
        'export type { CompiledEntityPresentation as EntityPresentation, EntityDetailSection, EntityListView, WayfindingDomain } from "../entity-definitions/definition";\n\n' +
        "/**\n" +
        " * Display names for one entity, exactly as its literal declares them.\n" +
        " *\n" +
        " * `singular` is Title Case and names ONE record; `plural` is the\n" +
        " * nav/section name, which is not a pluralization of the singular (see the\n" +
        " * `names` block in `packages/schemas/src/entity-definitions/*.entity.ts`). It is\n" +
        " * `null` for the entities that have no browser route to name a section of.\n" +
        " */\n" +
        "export type EntityNames = { singular: string; plural: string | null };\n\n" +
        "/**\n" +
        " * One entity's names plus its `presentation` block with the hero defaults\n" +
        " * resolved: domain, description, empty-state copy, icon names, title field,\n" +
        " * detail sections, list views, edit rules — plus the resolved list search\n" +
        " * (the compiler's `searchQuery` fallback included) and the bulk-update field\n" +
        " * roster. Browser code reads one entity's summary from its loaded model\n" +
        " * (`entityModel(entity).summary`) and the slim facts from `entityIndex`.\n" +
        " */\n" +
        "export type EntitySummary = EntityNames & CompiledEntityPresentation & {\n" +
        "  primarySearch: { key: string; placeholder: string } | null;\n" +
        "  bulkUpdate: { fields: readonly string[] } | null;\n" +
        "  /** The kernel serves `merge`, so the generic merge verb applies. */\n" +
        "  merge: boolean;\n" +
        "};\n\n" +
        aggregateNote +
        collect("entitySummary", ".summary", "Record<Entity, EntitySummary>") +
        "\n" +
        'type GeneratedDetailSection<E extends Entity> = (typeof entitySummary)[E]["detail"]["sections"][number];\n' +
        'type GeneratedListView<E extends Entity> = (typeof entitySummary)[E]["list"]["views"][number];\n' +
        "/** Literal detail slot ids declared by one entity. */\n" +
        'export type DetailSlotId<E extends Entity> = Extract<GeneratedDetailSection<E>, { kind: "slot" }>["id"];\n' +
        "/** Literal list slot ids declared by one entity. */\n" +
        'export type ListSlotId<E extends Entity> = Extract<GeneratedListView<E>, { kind: "slot" }>["id"];\n',
    },
    {
      relativePath: `${GENERATED}/entity-field-model.gen.ts`,
      source:
        generatedHeader +
        'import type { Entity } from "../entity-core";\n' +
        importAll(entityModelExport, entityModelModule) +
        "\n" +
        `export type GeneratedEntityFieldKind = ${fieldKinds.map((kind) => JSON.stringify(kind)).join(" | ")};\n` +
        `export type GeneratedEntityFieldControlKind = ${fieldControlKinds.map((kind) => JSON.stringify(kind)).join(" | ")};\n\n` +
        "type GeneratedEntityFieldResolutionValue = string | number | boolean | null | readonly GeneratedEntityFieldResolutionValue[] | GeneratedEntityFieldResolutionObject;\ninterface GeneratedEntityFieldResolutionObject { readonly [key: string]: GeneratedEntityFieldResolutionValue }\n\n" +
        'export type GeneratedEntityFieldProvenance = { kind: "reference" | "relation" | "derived"; sources: readonly { entity: Entity | null; label: string | null; relation: string | null }[] };\n\n' +
        fieldModelType +
        aggregateNote +
        collect(
          "generatedEntityFieldModels",
          ".fields",
          "Record<Entity, GeneratedEntityFieldModel>",
        ) +
        "\n" +
        'type GeneratedEntityField<E extends Entity> = (typeof generatedEntityFieldModels)[E]["fields"][number];\n' +
        "type RendererValue<T> = T extends { renderer: infer R } ? Exclude<R, null> : never;\n" +
        'type ControlRendererIdFor<E extends Entity> = RendererValue<NonNullable<GeneratedEntityField<E>["control"]>>;\n' +
        'type DisplayRendererIdFor<E extends Entity, K extends "list" | "detail"> = GeneratedEntityField<E>["display"]["renderer"] extends infer R ? R extends Record<K, infer V> ? Exclude<V, null> : never : never;\n' +
        "\n" +
        "/** Every specialized control renderer declared by an entity field. */\n" +
        "export type ControlRendererId = { [E in Entity]: ControlRendererIdFor<E> }[Entity];\n" +
        "/** Specialized list renderers declared for one entity's fields. */\n" +
        'export type ListRendererId<E extends Entity> = DisplayRendererIdFor<E, "list">;\n' +
        "/** Specialized detail renderers declared for one entity's fields. */\n" +
        'export type DetailRendererId<E extends Entity> = DisplayRendererIdFor<E, "detail">;\n\n' +
        '// Every `"entity.field"` whose control declares `suggest` (the\n' +
        "// decision-tier auto-fill target list), across all entities.\n" +
        `export const suggestFieldKeys = ${compactLiteral(suggestFieldKeys)} as const;\n` +
        "export type GeneratedSuggestFieldKey = (typeof suggestFieldKeys)[number];\n",
    },
    {
      relativePath: `${GENERATED}/entity-inspector.gen.ts`,
      source:
        generatedHeader +
        'import type { Entity } from "../entity";\n' +
        'import type { CompiledEntityPresentation } from "../entity-definitions/definition";\n' +
        importAll(entityInspectorExport, entityInspectorModule) +
        "\n" +
        inspectorTypes +
        aggregateNote +
        "// oxfmt-ignore\n" +
        `export const entityInspectorMetadata = {\n${entities
          .map(
            ({ key }) =>
              `  ${JSON.stringify(key)}: ${entityInspectorExport(key)},\n`,
          )
          .join(
            "",
          )}} as const satisfies Record<Entity, EntityInspectorMetadata>;\n`,
    },
  ];
};

/** Per-entity inspector module paths, for the browser's schema surfaces. */
export const entityInspectorLoaderSource = (key: string) =>
  `() => import(${JSON.stringify(`@cubby/schemas/entity-inspectors/${key}`)}).then((module) => module.${entityInspectorExport(key)})`;
export const entityModelLoaderSource = (key: string) =>
  `() => import(${JSON.stringify(`@cubby/schemas/entity-models/${key}`)}).then((module) => module.${entityModelExport(key)})`;
