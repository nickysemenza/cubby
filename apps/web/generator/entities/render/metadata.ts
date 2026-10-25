import { compactLiteral, generatedHeader } from "../../artifacts.ts";
import { EntityDeclarationError } from "../declarations.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import { renderRecord } from "./record.ts";
import { browserRoutes } from "./routes.ts";
import {
  bulkUpdateFor,
  kernelEntitiesFor,
  resolvedPrimarySearch,
} from "./shared.ts";
import { entityProjectionMaps } from "./capabilities.ts";
import { kernelActionsFor } from "./capabilities.ts";
import { entityReadDependents } from "../read-dependencies.ts";

export const renderEntityMetadataArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const projections = entityProjectionMaps(entities);
  const crudEntitySpecs = projections.crud;
  const browserCrudEntities = crudEntitySpecs.map(({ key }) => key);
  const kernelEntities = kernelEntitiesFor(entities);
  const kernelEntityKeys = kernelEntities.map(({ key }) => key);
  const kernelContractCases = Object.fromEntries(
    kernelEntities.map((entity) => {
      return [
        entity.key,
        {
          actions: kernelActionsFor(entity),
          filterUrlKeys: entity.filterUrlKeys,
        },
      ];
    }),
  );
  const entitiesForAction = (action: string) =>
    Object.entries(kernelContractCases)
      .filter(([, contractCase]) => contractCase.actions.includes(action))
      .map(([key]) => key);
  const mcpKernelContractCases = Object.fromEntries(
    kernelEntities.map((entity) => {
      const declared = entity.mcpActions;
      const executable = kernelActionsFor(entity);
      const unsupported = declared.filter(
        (action) => !executable.includes(action),
      );
      if (unsupported.length > 0) {
        throw new EntityDeclarationError(
          `${entity.key}.capabilities.mcp declares unbound actions: ${unsupported.join(", ")}.`,
        );
      }
      return [entity.key, { actions: declared }];
    }),
  );
  const mcpEntitiesForAction = (action: string) =>
    Object.entries(mcpKernelContractCases)
      .filter(([, contractCase]) => contractCase.actions.includes(action))
      .map(([key]) => key);
  const inspectorMetadata = Object.fromEntries(
    entities.map((entity) => {
      const lifecycle = entity.lifecycle;
      const kernelActions = kernelEntityKeys.includes(entity.key)
        ? kernelActionsFor(entity)
        : [];
      const mcpOperations = Array.isArray(entity.descriptor.mcp)
        ? entity.descriptor.mcp
        : [];
      const mcpOwner =
        mcpOperations.length === 0
          ? null
          : kernelEntityKeys.includes(entity.key)
            ? "kernel"
            : "workflow";
      const sourceRefs =
        entity.contract === null
          ? null
          : Object.fromEntries(
              Object.entries(entity.contract).flatMap(([operation, ref]) =>
                ref === null
                  ? []
                  : [[operation, `${ref.module}#${ref.export}`]],
              ),
            );
      return [
        entity.key,
        {
          ...entity.inspector,
          shortcodePrefix: entity.shortcode,
          searchable: entity.descriptor.searchable === true,
          // Search is a list capability, not a synthetic model field. Keeping
          // this descriptor beside the generated list metadata gives web and
          // native one transport key without teaching either about `name`.
          primarySearch: resolvedPrimarySearch(entity),
          browserRouted: entity.descriptor.browserRoutes !== false,
          auditable: entity.descriptor.auditable === true,
          hasImages: entity.descriptor.hasImages === true,
          imageStorage: entity.descriptor.imageStorage,
          displayImages: entity.descriptor.displayImages === true,
          countable: entity.descriptor.countable === true,
          kernelActions,
          filterUrlKeys: entity.filterUrlKeys,
          // Presets are runtime behavior (`entity-filter-bindings.gen.ts`), not
          // inspector metadata.
          filterDescriptors: entity.filterDescriptors.map((descriptor) => ({
            ...descriptor,
            options:
              descriptor.options?.map(
                ({ expand: _expand, ...option }) => option,
              ) ?? null,
          })),
          mcpOperations,
          mcpOwner,
          lifecycle: {
            softDelete: entity.descriptor.softDelete === true,
            delete: lifecycle.delete,
            merge: lifecycle.merge === true,
            bulkUpdate: bulkUpdateFor(entity),
          },
          operationOwners: {
            delete: entity.operationOwners.delete,
            merge: entity.operationOwners.merge,
          },
          sourceRefs,
          ports: entity.ports,
          references: [
            ...new Set(entity.relations.map(({ target }) => target)),
          ],
        },
      ];
    }),
  );
  // An inherit-only resolution has no client actions.
  const withoutInherit = (
    resolution: CompiledEntity["fieldModel"]["fields"][number]["resolution"],
  ) => {
    if (resolution?.reset === undefined) return null;
    const { inherit: _inherit, ...rest } = resolution;
    return rest;
  };
  const fieldModels = Object.fromEntries(
    entities.map(({ key, fieldModel }) => {
      // `derived`/`rows`/`hierarchy`/`grouping` are emitted compiled, in
      // entity-list-fields.gen.ts.
      const {
        sort: _sort,
        intents: _intents,
        derived: _derived,
        rows: _rows,
        hierarchy: _hierarchy,
        grouping: _grouping,
        groupingOmit: _groupingOmit,
        ...rest
      } = fieldModel;
      return [
        key,
        {
          ...rest,
          storage: fieldModel.storage.map(
            ({
              referenceOptions: _referenceOptions,
              defaultSql: _defaultSql,
              ...storage
            }) => storage,
          ),
          fields: fieldModel.fields.map(({ validation, ...field }) => ({
            ...field,
            // `resolution.inherit` is emitted compiled, as list fields' `inherit`.
            resolution: withoutInherit(field.resolution),
            // A field is required on create when it declares a create schema
            // that rejects `undefined` — a field with no create schema at all
            // is never required (it is not part of the create roster).
            requiredOnCreate:
              validation.create !== null &&
              !validation.create.safeParse(undefined).success,
          })),
        },
      ];
    }),
  );
  // Every `"entity.field"` whose control declares `suggest`, across all
  // entities, in declaration order — the decision-tier field-suggest
  // registry keys off this list (`GeneratedSuggestFieldKey`).
  const suggestFieldKeys = entities.flatMap(({ key, fieldModel }) =>
    fieldModel.fields
      .filter((field) => field.control?.suggest != null)
      .map((field) => `${key}.${field.key}`),
  );
  const entitySortEntries = entities.flatMap(({ key, fieldModel }) =>
    fieldModel.sort === null
      ? []
      : [
          [
            key,
            {
              fields: fieldModel.sort.fields,
              default: fieldModel.sort.default,
              direction: fieldModel.sort.direction,
            },
          ] as const,
        ],
  );
  const entitySort = Object.fromEntries(entitySortEntries);
  const entityEditIntents = Object.fromEntries(
    entities.flatMap(({ key, fieldModel }) =>
      fieldModel.intents === null
        ? []
        : [
            [
              key,
              {
                fields: fieldModel.intents.fields,
                create: fieldModel.intents.create,
                update: fieldModel.intents.update,
                required: fieldModel.intents.required,
              },
            ] as const,
          ],
    ),
  );
  return [
    {
      relativePath:
        "packages/schemas/src/generated/entity-manifest-data.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "../entity";\n' +
        'import type { EntityDescriptor } from "../entity-manifest";\n\n' +
        renderRecord({
          name: "generatedEntityManifest",
          entries: Object.fromEntries(
            entities.map(({ key, descriptor }) => [key, descriptor]),
          ),
          satisfies: "Record<Entity, EntityDescriptor>",
          comment: "// Generated data stays one entity per line.",
        }),
    },
    {
      relativePath: "packages/schemas/src/generated/entity-summary.gen.ts",
      source:
        generatedHeader +
        // `entity-core` rather than `entity`: this artifact is imported by
        // `identifiers.ts`, and `entity.ts` reaches back into the (much
        // larger) manifest module.
        'import type { Entity } from "../entity-core";\n' +
        'import type { CompiledEntityPresentation } from "../entity-definitions/definition";\n' +
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
        " * roster. Data only — for eagerly-loaded client code (the entity registry,\n" +
        " * navigation, list hooks, bulk edit, `identifiers.ts`) that must not pull\n" +
        " * the inspector.\n" +
        " */\n" +
        "export type EntitySummary = EntityNames & CompiledEntityPresentation & {\n" +
        "  primarySearch: { key: string; placeholder: string } | null;\n" +
        "  bulkUpdate: { fields: readonly string[] } | null;\n" +
        "  /** The kernel serves `merge`, so the generic merge verb applies. */\n" +
        "  merge: boolean;\n" +
        "};\n\n" +
        "/**\n" +
        " * Every entity key, in declaration order. The leaf roster: `entity-core`'s\n" +
        " * `entitySchema` is `z.enum(entityKeys)`, so this tuple carries no `Entity`\n" +
        " * constraint of its own (the `satisfies` on `entitySummary` below is fine —\n" +
        " * it only reads `Entity` after `entityKeys` is fixed).\n" +
        " */\n" +
        renderRecord({
          name: "entityKeys",
          entries: entities.map(({ key }) => key),
        }) +
        "\n" +
        renderRecord({
          name: "entitySummary",
          entries: Object.fromEntries(
            entities.map((entity) => [
              entity.key,
              {
                ...entity.inspector,
                primarySearch: resolvedPrimarySearch(entity),
                bulkUpdate: bulkUpdateFor(entity),
                merge: entity.operationOwners.merge === "kernel",
              },
            ]),
          ),
          satisfies: "Record<Entity, EntitySummary>",
          comment: "// Generated summary stays one entity per line.",
        }) +
        "\n" +
        'type GeneratedDetailSection<E extends Entity> = (typeof entitySummary)[E]["detail"]["sections"][number];\n' +
        'type GeneratedListView<E extends Entity> = (typeof entitySummary)[E]["list"]["views"][number];\n' +
        "/** Literal detail slot ids declared by one entity. */\n" +
        'export type DetailSlotId<E extends Entity> = Extract<GeneratedDetailSection<E>, { kind: "slot" }>["id"];\n' +
        "/** Literal list slot ids declared by one entity. */\n" +
        'export type ListSlotId<E extends Entity> = Extract<GeneratedListView<E>, { kind: "slot" }>["id"];\n' +
        renderRecord({
          name: "entityReadDependents",
          entries: entityReadDependents(entities),
          satisfies: "Record<Entity, readonly Entity[]>",
          comment:
            "// Read consumers of explicitly declared references and projection paths.",
        }),
    },
    {
      relativePath: "packages/schemas/src/generated/entity-field-model.gen.ts",
      source:
        generatedHeader +
        'import type { GeneratedEntityFieldModel } from "../entity-projection-types";\nexport type { GeneratedEntityFieldKind, GeneratedEntityFieldControlKind, GeneratedEntityFieldModel, GeneratedEntityFieldProvenance } from "../entity-projection-types";\n' +
        'import type { Entity } from "../entity-core";\n\n' +
        renderRecord({
          name: "generatedEntityFieldModels",
          entries: fieldModels,
          satisfies: "Record<Entity, GeneratedEntityFieldModel>",
          comment: "// One authoritative field model per compiled entity.",
        }) +
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
      relativePath: "packages/schemas/src/generated/entity-edit-intents.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "../entity-core";\n\n' +
        renderRecord({
          name: "generatedEntityEditIntents",
          entries: entityEditIntents,
          satisfies:
            "Partial<Record<Entity, { fields: Record<string, readonly string[]>; create: readonly string[]; update: readonly [string, ...string[]]; required: Record<string, readonly string[]> }>>",
          comment:
            "// Editing intents per entity: named field fragments and the ordered\n// intent names each operation accepts (first is the default).",
        }),
    },
    {
      relativePath:
        "packages/schemas/src/generated/entity-field-schema-maps.gen.ts",
      source:
        generatedHeader +
        entities
          .filter(
            ({ fieldModel }) =>
              fieldModel.create.length +
                fieldModel.update.length +
                fieldModel.output.length >
              0,
          )
          .map(
            ({ key, inspector }) =>
              `import { generated${inspector.singular.replaceAll(" ", "")}FieldSchemas } from "./entity-field-schemas.${key}.gen";\n`,
          )
          .join("") +
        "\n// Every entity's generated field schema maps, by entity key.\n" +
        "export const entityFieldSchemaMaps = {\n" +
        entities
          .filter(
            ({ fieldModel }) =>
              fieldModel.create.length +
                fieldModel.update.length +
                fieldModel.output.length >
              0,
          )
          .map(
            ({ key, inspector }) =>
              `  ${JSON.stringify(key)}: generated${inspector.singular.replaceAll(" ", "")}FieldSchemas,\n`,
          )
          .join("") +
        "} as const;\n",
    },
    {
      relativePath:
        "packages/schemas/src/generated/entity-stored-derived.gen.ts",
      source:
        generatedHeader +
        "/**\n" +
        " * Every stored derived value (ADR 0021): `model.derived.<key>.stored`\n" +
        " * with its entity, table and value type, for the server drain,\n" +
        " * generated triggers and list reads.\n" +
        " */\n" +
        `export const generatedStoredDerived = ${JSON.stringify(
          entities.flatMap((entity) => [
            ...Object.entries(entity.fieldModel.derived).flatMap(
              ([key, entry]) =>
                "stored" in entry && entry.stored
                  ? [
                      {
                        entity: entity.key,
                        key,
                        table: entity.descriptor.dbTable ?? null,
                        type: "type" in entry ? entry.type : "number",
                        stored: entry.stored,
                      },
                    ]
                  : [],
            ),
            // Stored quality (ADR 0021): the record's own row, its waivers and
            // its attachments, plus the declared reads of its evaluator.
            ...(entity.dataQuality && entity.descriptor.dbTable
              ? [
                  {
                    entity: entity.key,
                    key: "dataQuality",
                    table: entity.descriptor.dbTable,
                    type: "number",
                    stored: {
                      compute: `quality.${entity.key}`,
                      inputs: [
                        {
                          table: entity.descriptor.dbTable,
                          match: { id: "id" },
                        },
                        {
                          table: "DataException",
                          match: { entityId: "id" },
                          where: { entityKind: entity.key },
                        },
                        {
                          table: "EntityAttachment",
                          match: { entityId: "id" },
                          where: { entityKind: entity.key },
                        },
                        // An attached image's integrity changes the
                        // displayable-image checks of every record it is on.
                        {
                          table: "Image",
                          match: { id: "id" },
                          columns: [
                            "renderStatus",
                            "storageStatus",
                            "detectedContentType",
                            "deletedAt",
                          ],
                          path: [
                            {
                              table: "EntityAttachment",
                              from: "imageId",
                              to: "entityId",
                              where: { entityKind: entity.key },
                            },
                          ],
                        },
                        ...entity.dataQuality.inputs,
                      ],
                    },
                  },
                ]
              : []),
          ]),
          null,
          2,
        )} as const;\n`,
    },
    {
      relativePath: "packages/schemas/src/generated/entity-list-fields.gen.ts",
      source:
        generatedHeader +
        'import type { GeneratedListField, GeneratedRowSet, GeneratedInherit, GeneratedGroupChoice, GeneratedListScope } from "../entity-projection-types";\nexport type { GeneratedListField, GeneratedRowSet, GeneratedInherit, GeneratedGroupChoice, GeneratedListScope } from "../entity-projection-types";\n' +
        'import type { Entity } from "../entity-core";\n' +
        "/**\n" +
        " * The compiled list fields of every entity, from `model.derived` and\n" +
        " * `model.hierarchy`: each derived field's shape (a related `via` path, a\n" +
        " * repository `value`, or a filter-only `predicate`) with the reason sort\n" +
        " * or group is rejected (null when supported); the hierarchy's parent\n" +
        " * column and depth cap; `subtree` maps a filter key to its generated\n" +
        ' * "Include sub-…" toggle; `grouping` is `model.grouping` in menu order,\n' +
        " * each choice with what its section key reads, its no-value label, the\n" +
        " * filter its section header applies, the reason it cannot group\n" +
        " * (null when it can), and the hierarchy levels it can group at\n" +
        " * (0 exactly when `levelReason` says why).\n" +
        " */\n" +
        "/** A compiled `model.rows` row set: an FK path (narrowed by `where`), a JSON array of records, or a repository relation. */\n" +
        "/** Every `listTermExpanders` key a text filter declares. */\n" +
        `export type GeneratedListTermKey = ${
          [
            ...new Set(
              entities.flatMap(({ listFields }) =>
                Object.values(listFields.terms),
              ),
            ),
          ]
            .sort()
            .map((key) => JSON.stringify(key))
            .join(" | ") || "never"
        };\n\n` +
        "/** A field's compiled `resolution.inherit`, rendered by `effectiveFieldSql`. */\n" +
        "/** One Group by choice: `value` is null exactly when `reason` is set. */\n" +
        "/** A related list scope (`presentation.list.scopes`): the entity whose list filter record its key holds, and the path to that entity's records. */\n" +
        renderRecord({
          name: "generatedEntityListFields",
          entries: Object.fromEntries(
            entities.map(({ key, listFields }) => [key, listFields]),
          ),
          satisfies:
            "Record<Entity, { derived: Record<string, GeneratedListField>; rows: Record<string, GeneratedRowSet>; terms: Record<string, GeneratedListTermKey>; inherit: Record<string, GeneratedInherit>; hierarchy: { parentField: string; column: string; maxDepth: number } | null; subtree: Record<string, string>; grouping: readonly GeneratedGroupChoice[]; metrics: readonly { readonly key: string; readonly label: string; readonly format: string | null }[]; scope: readonly string[]; scopes: Record<string, GeneratedListScope> }>",
          comment: "// Generated list fields stay one entity per line.",
        }) +
        "\n" +
        'type DerivedOf<E extends Entity> = (typeof generatedEntityListFields)[E]["derived"];\n' +
        "/** Derived keys whose SQL value the repository passes to `listScaffold`; declared rollups compile their own. */\n" +
        "export type GeneratedDerivedValueKey<E extends Entity> = {\n" +
        '  [K in keyof DerivedOf<E>]: DerivedOf<E>[K] extends { shape: "value"; rollup: object } ? never : DerivedOf<E>[K] extends { shape: "value" } ? K : never;\n' +
        "}[keyof DerivedOf<E>] & string;\n" +
        "/** Row sets whose relation the repository passes to `listScaffold`. */\n" +
        "export type GeneratedRepositoryRowSetKey<E extends Entity> = {\n" +
        '  [K in keyof (typeof generatedEntityListFields)[E]["rows"]]: (typeof generatedEntityListFields)[E]["rows"][K] extends { storage: { kind: "repository" } } ? K : never;\n' +
        '}[keyof (typeof generatedEntityListFields)[E]["rows"]] & string;\n' +
        "/** Related scope keys whose target list scaffold the repository passes to `listScaffold`. */\n" +
        'export type GeneratedListScopeKey<E extends Entity> = keyof (typeof generatedEntityListFields)[E]["scopes"] & string;\n' +
        "/** The entity whose list filter record a related scope key holds. */\n" +
        'export type GeneratedListScopeTarget<E extends Entity, K extends GeneratedListScopeKey<E>> = (typeof generatedEntityListFields)[E]["scopes"][K] extends { readonly filters: infer T extends Entity } ? T : never;\n' +
        "/** Derived keys whose filter predicate the repository passes to `listScaffold`. */\n" +
        "export type GeneratedDerivedPredicateKey<E extends Entity> = {\n" +
        '  [K in keyof DerivedOf<E>]: DerivedOf<E>[K] extends { shape: "predicate" } ? K : never;\n' +
        "}[keyof DerivedOf<E>] & string;\n",
    },
    {
      relativePath: "packages/schemas/src/generated/entity-sort.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "../entity-core";\n\n' +
        "/**\n" +
        " * The declared list-sort roster for entities that expose one, keyed from\n" +
        " * `model.sort` in `packages/schemas/src/entity-definitions/*.entity.ts`.\n" +
        " * Entries name model fields, `model.derived` keys (`entity-list-fields.gen.ts`)\n" +
        " * or `related:<view>` columns. `direction` is the list's opening sort\n" +
        ' * direction, defaulting to "desc". Group by choices are\n' +
        " * `generatedEntityListFields[entity].grouping`.\n" +
        " */\n" +
        renderRecord({
          name: "generatedEntitySort",
          entries: entitySort,
          satisfies:
            'Partial<Record<Entity, { fields: readonly [string, ...string[]]; default: string; direction: "asc" | "desc" }>>',
          comment: "// Generated sort rosters stay one entity per line.",
        }) +
        "\n" +
        "export type GeneratedEntitySortField<E extends keyof typeof generatedEntitySort> =\n" +
        '  (typeof generatedEntitySort)[E]["fields"][number];\n',
    },
    {
      relativePath: "packages/schemas/src/generated/entity-inspector.gen.ts",
      source:
        generatedHeader +
        'import type { EntityInspectorMetadata } from "../entity-projection-types";\nexport type { EntityInspectorMetadata } from "../entity-projection-types";\n' +
        'import type { Entity } from "../entity";\n\n' +
        renderRecord({
          name: "entityInspectorMetadata",
          entries: inspectorMetadata,
          satisfies: "Record<Entity, EntityInspectorMetadata>",
          comment: "// Generated inspector metadata stays one entity per line.",
        }),
    },
    {
      relativePath: "apps/web/src/entity/generated/entity-routes.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n\n' +
        renderRecord({
          name: "generatedBrowserRoutes",
          entries: Object.fromEntries(
            projections.routes.map((entity) => {
              const { basePath, routes } = browserRoutes(entity);
              return [entity.key, { basePath, routes }];
            }),
          ),
          satisfies:
            'Partial<Record<Entity, { basePath: string; routes: { detail: string; list: string; create?: "dialog" | "page"; new?: string } }>>',
          comment: "// Generated routes stay one entity per line.",
        }) +
        "\n" +
        renderRecord({
          name: "generatedBrowserCrudEntities",
          entries: browserCrudEntities,
          comment: "// Generated entity roster stays one line.",
        }) +
        "export type GeneratedBrowserCrudEntity = (typeof generatedBrowserCrudEntities)[number];\n",
    },
    {
      relativePath:
        "apps/web/src/server/generated/entity-kernel-entities.gen.ts",
      source:
        generatedHeader +
        renderRecord({
          name: "generatedEntityKernelEntities",
          entries: kernelEntityKeys,
          comment: "// Generated entity roster stays one line.",
        }) +
        "\n" +
        renderRecord({
          name: "generatedEntityKernelContractCases",
          entries: kernelContractCases,
          comment: "// Generated capabilities stay compact and reviewable.",
        }) +
        "\n" +
        renderRecord({
          name: "generatedMcpEntityKernelContractCases",
          entries: mcpKernelContractCases,
          comment:
            "// Generated MCP exposure is a strict subset of executable kernel actions.",
        }) +
        "\n" +
        renderRecord({
          name: "generatedMcpEntityActionEntities",
          entries: Object.fromEntries(
            [
              "get",
              "list",
              "search",
              "create",
              "update",
              "delete",
              "bulkUpdate",
              "merge",
            ].map((action) => [action, mcpEntitiesForAction(action)]),
          ),
          comment: "// One generated entity roster per MCP action.",
        }) +
        "\n" +
        renderRecord({
          name: "generatedSearchEntityKernelEntities",
          entries: entitiesForAction("search"),
          comment: "// Generated action rosters stay one line each.",
        }) +
        `export const generatedResolveEntityKernelEntities = ${compactLiteral(entitiesForAction("resolve"))} as const;\n` +
        "\n" +
        renderRecord({
          name: "generatedEntityResolveCapabilities",
          entries: Object.fromEntries(
            kernelEntities.flatMap((entity) =>
              entity.resolve === null ? [] : [[entity.key, entity.resolve]],
            ),
          ),
          comment: "// Declared `capabilities.resolve`, one entity per line.",
        }) +
        `export const generatedMergeEntityKernelEntities = ${compactLiteral(entitiesForAction("merge"))} as const;\n`,
    },
  ];
};
