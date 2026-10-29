import { z } from "zod";
import { compileRelatedViews } from "./related-views.ts";

import { entitySchema } from "@cubby/schemas/entity-core";
import { createConnectionCatalog } from "@cubby/schemas/connected-view-definitions";
import { entityRelationshipSchema } from "@cubby/schemas/entity-integrity";

import { tsModule, tsReference } from "../../artifacts.ts";
import { declarationModules, EntityDeclarationError } from "../declarations.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import { browserRoutes } from "./routes.ts";
import {
  bulkUpdateFor,
  kernelEntitiesFor,
  resolvedPrimarySearch,
} from "./shared.ts";
import { entityProjectionMaps } from "./capabilities.ts";
import { kernelActionsFor } from "./capabilities.ts";
import { entityReadDependents } from "../read-dependencies.ts";
import { structuredSchemasForEntity } from "./structured-value-schemas.ts";
import { governedFields } from "./field-envelopes.ts";
import { scoredEntitiesFor } from "./data-quality.ts";

const filterExpandRules = {
  resolveDateRange: "dateRange",
  resolveExpenseCount: "expenseCount",
  resolveVendorPurchases: "vendorPurchases",
  resolveLatestPurchaseDate: "latestPurchaseDate",
  resolveVerifiedDate: "verifiedDate",
  resolveProductPurchaseDateFilter: "productPurchaseDate",
  resolveProductTaskFilter: "productTask",
  resolveTaskDueFilter: "taskDue",
  resolvePostedDate: "postedDate",
  resolveCreatedDate: "createdDate",
  resolveUpdatedDate: "updatedDate",
} as const;

const filterExpandRule = (name: string) => {
  const entry = Object.entries(filterExpandRules).find(([key]) => key === name);
  if (!entry)
    throw new EntityDeclarationError(
      `Unknown browser filter expansion ${name}`,
    );
  return entry[1];
};

const browserFilterDescriptors = (entity: CompiledEntity) =>
  entity.filterDescriptors.map(
    ({ optionsRef, expandRef, brandRef, ...descriptor }) => {
      const optionField =
        optionsRef?.export === "tradeOptions"
          ? "trade"
          : optionsRef?.export === "locationTypeOptionsWithTheme"
            ? "type"
            : null;
      if (optionsRef && optionField === null)
        throw new EntityDeclarationError(
          `Unknown browser filter options ${optionsRef.export}`,
        );
      const options =
        optionField === null
          ? descriptor.options
          : entity.fieldModel.fields.find(({ key }) => key === optionField)
              ?.control?.options;
      if (optionField !== null && !options)
        throw new EntityDeclarationError(
          `${entity.key}.${optionField} has no browser filter options`,
        );
      return {
        ...descriptor,
        options: options ?? null,
        expandRule: expandRef ? filterExpandRule(expandRef.export) : null,
        brand: brandRef,
      };
    },
  );

export const renderEntityMetadataArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const relationshipCatalog = entities.map((entity) => ({
    key: entitySchema.parse(entity.key),
    plural: entity.inspector.plural ?? entity.key,
    relationships: z
      .array(entityRelationshipSchema)
      .parse(entity.descriptor.relationships),
  }));
  const connectionCatalog = createConnectionCatalog(relationshipCatalog);
  const relatedViews = compileRelatedViews(entities);
  const projections = entityProjectionMaps(entities);
  const browserIcons = [
    ...new Set(
      projections.routes.map((entity) => entity.inspector.icons.phosphor),
    ),
  ].sort();
  const resultEntities = entities.filter((entity) =>
    Object.values(entity.fieldModel.stored).some(
      (stored) => stored.resultSchema,
    ),
  );
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
                ref === null || !("module" in ref)
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
      // entity-list-fields.gen.ts; `stored` in entity-stored-derived.gen.ts.
      const {
        sort: _sort,
        intents: _intents,
        derived: _derived,
        stored: _stored,
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
              type: _type,
              enumValues: _enumValues,
              ...storage
            }) => storage,
          ),
          fields: fieldModel.fields.map(({ validation, ...field }) => ({
            ...field,
            storedKey: field.storedKey ?? null,
            storedPath: field.storedPath ?? null,
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
  const artifact = (
    relativePath: string,
    module: Parameters<typeof tsModule>[0],
  ): EntityArtifacts => ({ relativePath, source: tsModule(module) });
  const typeImport = (names: string[]) => ({
    from: "../entity-metadata-types",
    names,
    typeOnly: true,
  });
  const projection = (name: string, property: string) => ({
    imports: entities.map(({ key }, index) => ({
      from: `./entity-metadata.${key}.gen`,
      names: [`metadata as metadata${index}`],
    })),
    consts: [
      {
        name,
        value: Object.fromEntries(
          entities.map(({ key }, index) => [
            key,
            tsReference(`metadata${index}`, property),
          ]),
        ),
      },
    ],
  });
  return [
    ...entities.map((entity) =>
      artifact(
        `packages/schemas/src/generated/entity-metadata.${entity.key}.gen.ts`,
        {
          imports: [typeImport(["EntityMetadataSlice"])],
          consts: [
            {
              name: "metadata",
              value: {
                entity: entity.key,
                dependencies: entities
                  .filter(
                    ({ key }) =>
                      key !== entity.key &&
                      (entity.relations.some(({ target }) => target === key) ||
                        entity.fieldModel.fields.some(
                          ({ reference }) => reference?.entity === key,
                        )),
                  )
                  .map(({ key }) => key),
                descriptor: entity.descriptor,
                summary: {
                  ...entity.inspector,
                  primarySearch: resolvedPrimarySearch(entity),
                  bulkUpdate: bulkUpdateFor(entity),
                  merge: entity.operationOwners.merge === "kernel",
                },
                fields: fieldModels[entity.key],
                envelopeFields: governedFields(entity).map(
                  ({ readKey, key }) => readKey ?? key,
                ),
                relatedViews: relatedViews.filter(
                  (view) => view.source === entity.key,
                ),
                connections: {
                  views: connectionCatalog.views(entity.key),
                  context: connectionCatalog.views(entity.key, "context"),
                },
                filterDescriptors: browserFilterDescriptors(entity),
                createDefaults: Object.fromEntries(
                  entity.fieldModel.fields.flatMap((field) =>
                    field.validation.create instanceof z.ZodDefault
                      ? [
                          [
                            field.key,
                            z
                              .json()
                              .parse(field.validation.create.def.defaultValue),
                          ],
                        ]
                      : [],
                  ),
                ),
                structuredSchemas: structuredSchemasForEntity(entity, entities),
                listFields: {
                  grouping: entity.listFields.grouping,
                  hierarchy: entity.listFields.hierarchy,
                  subtree: entity.listFields.subtree,
                  metrics: entity.listFields.metrics,
                },
                sort: entity.fieldModel.sort,
                editIntents: entity.fieldModel.intents,
              },
              satisfies: "EntityMetadataSlice",
            },
          ],
        },
      ),
    ),
    artifact("packages/schemas/src/generated/entity-roster.gen.ts", {
      imports: [typeImport(["EntityRosterData"])],
      consts: [
        {
          name: "entityRoster",
          value: Object.fromEntries(
            entities.map((entity) => [
              entity.key,
              {
                singular: entity.inspector.singular,
                plural: entity.inspector.plural,
                icons: entity.inspector.icons,
                domain: entity.inspector.domain,
                titleField: entity.inspector.titleField,
                recordIconEntityField: entity.inspector.recordIconEntityField,
                recordEmojiField: entity.inspector.recordEmojiField,
                merge: entity.operationOwners.merge === "kernel",
                graph:
                  entity.descriptor.dbTable !== null &&
                  "shortcodePrefix" in entity.descriptor,
                shortcodePrefix: entity.shortcode,
                browserRoutes: entity.descriptor.browserRoutes !== false,
                hasImages: entity.descriptor.hasImages,
                imageStorage: entity.descriptor.imageStorage,
                searchable: entity.descriptor.searchable,
                embeddable: entity.descriptor.embeddable,
                auditable: entity.descriptor.auditable,
                countable: entity.descriptor.countable,
                displayImages: entity.descriptor.displayImages,
              },
            ]),
          ),
          satisfies: "EntityRosterData",
        },
        {
          name: "entityReadDependents",
          value: entityReadDependents(entities),
        },
        { name: "allEntities", value: entities.map(({ key }) => key) },
        {
          name: "suggestionEntities",
          value: entities
            .filter(({ fieldModel }) =>
              fieldModel.fields.some(({ control }) => control?.suggest != null),
            )
            .map(({ key }) => key),
        },
        {
          name: "scoredEntities",
          value: scoredEntitiesFor(entities).map(({ key }) => key),
        },
        {
          name: "shortcodeEntities",
          value: entities
            .filter(({ shortcode }) => shortcode !== null)
            .map(({ key }) => key),
        },
        {
          name: "browserRoutedEntities",
          value: entities
            .filter(({ descriptor }) => descriptor.browserRoutes !== false)
            .map(({ key }) => key),
        },
        {
          name: "homePinnedViews",
          value: entities.flatMap((entity) =>
            entity.inspector.list.savedViews.flatMap((view) =>
              view.pin?.surface === "home"
                ? [{ entity: entity.key, view }]
                : [],
            ),
          ),
        },
        ...(
          [
            "auditable",
            "hasImages",
            "displayImages",
            "searchable",
            "embeddable",
            "countable",
          ] as const
        ).map((trait) => ({
          name: `${trait === "hasImages" ? "image" : trait === "displayImages" ? "displayImage" : trait}Entities`,
          value: entities
            .filter(({ descriptor }) => descriptor[trait] === true)
            .map(({ key }) => key),
        })),
        ...["gallery", "cover", "logo"].map((storage) => ({
          name: `${storage}Entities`,
          value: entities
            .filter(({ descriptor }) => descriptor.imageStorage === storage)
            .map(({ key }) => key),
        })),
      ],
      exports: [
        {
          from: "@cubby/shared/entity-keys",
          names: ["ENTITY_KEYS as entityKeys"],
        },
        {
          from: "../entity-roster-runtime",
          names: ["isAuditableEntity", "isGalleryEntity"],
        },
      ],
    }),
    artifact("apps/web/src/entity/generated/entity-metadata-types.gen.ts", {
      imports: [
        {
          from: "@cubby/schemas/entity-metadata-types",
          names: ["TypeMap"],
          typeOnly: true,
        },
        ...entities.map(({ key }, index) => ({
          from: `@cubby/schemas/compiler/generated/entity-metadata/${key}`,
          names: [`metadata as metadata${index}`],
          typeOnly: true,
        })),
      ],
      types: [
        {
          name: "EntityMetadataByEntity",
          target: `TypeMap<{${entities.map(({ key }, index) => `${JSON.stringify(key)}:typeof metadata${index}`).join(";")}}>`,
        },
      ],
      exports: [
        {
          from: "../model/metadata-types",
          names: ["EntityMetadataSlice"],
          typeOnly: true,
        },
      ],
    }),
    artifact("apps/web/src/server/generated/entity-metadata-loaders.gen.ts", {
      exports: [
        {
          from: "../entity-metadata/loaders",
          names: ["entityMetadataLoaders"],
        },
      ],
    }),
    artifact("packages/schemas/src/generated/entity-manifest-data.gen.ts", {
      ...projection("generatedEntityManifest", "descriptor"),
    }),
    artifact("packages/schemas/src/generated/entity-summary.gen.ts", {
      imports: projection("entitySummary", "summary").imports,
      consts: [
        ...projection("entitySummary", "summary").consts,
        {
          name: "entityReadDependents",
          value: entityReadDependents(entities),
        },
      ],
      exports: [
        {
          from: "../entity-summary-types",
          typeOnly: true,
          names: ["EntityNames", "EntitySummary", "DetailSlotId", "ListSlotId"],
        },
        {
          from: "../entity-definitions/definition",
          names: ["WAYFINDING_DOMAINS", "WAYFINDING_DOMAIN_PRESENTATION"],
        },
        {
          from: "../entity-definitions/definition",
          typeOnly: true,
          names: [
            "CompiledEntityPresentation as EntityPresentation",
            "EntityDetailSection",
            "EntityListView",
            "WayfindingDomain",
          ],
        },
        {
          from: "@cubby/shared/entity-keys",
          names: ["ENTITY_KEYS as entityKeys"],
        },
      ],
    }),
    artifact("packages/schemas/src/generated/entity-field-model.gen.ts", {
      ...projection("generatedEntityFieldModels", "fields"),
      consts: [
        ...projection("generatedEntityFieldModels", "fields").consts,
        { name: "suggestFieldKeys", value: suggestFieldKeys },
      ],
      exports: [
        {
          from: "../entity-field-model-types",
          typeOnly: true,
          names: [
            "ControlRendererId",
            "ListRendererId",
            "DetailRendererId",
            "GeneratedSuggestFieldKey",
          ],
        },
        {
          from: "../entity-projection-types",
          typeOnly: true,
          names: [
            "GeneratedEntityFieldKind",
            "GeneratedEntityFieldControlKind",
            "GeneratedEntityFieldModel",
            "GeneratedEntityFieldProvenance",
          ],
        },
      ],
    }),
    artifact("packages/schemas/src/generated/entity-edit-intents.gen.ts", {
      consts: [
        {
          name: "generatedEntityEditIntents",
          value: entityEditIntents,
        },
      ],
    }),
    artifact("packages/schemas/src/generated/entity-field-schema-maps.gen.ts", {
      imports: entities
        .filter(
          ({ fieldModel }) =>
            fieldModel.create.length +
              fieldModel.update.length +
              fieldModel.output.length >
            0,
        )
        .map(({ key, inspector }) => ({
          from: `./entity-field-schemas.${key}.gen`,
          names: [
            `generated${inspector.singular.replaceAll(" ", "")}FieldSchemas as fields_${key.replaceAll("-", "_")}`,
          ],
        })),
      consts: [
        {
          name: "entityFieldSchemaMaps",
          value: Object.fromEntries(
            entities
              .filter(
                ({ fieldModel }) =>
                  fieldModel.create.length +
                    fieldModel.update.length +
                    fieldModel.output.length >
                  0,
              )
              .map(({ key }) => [
                key,
                tsReference(`fields_${key.replaceAll("-", "_")}`),
              ]),
          ),
        },
      ],
    }),
    artifact("packages/schemas/src/generated/entity-stored-derived.gen.ts", {
      consts: [
        {
          name: "generatedStoredDerived",
          value: entities.flatMap((entity) => [
            ...Object.entries(entity.fieldModel.derived).flatMap(
              ([key, entry]) =>
                "stored" in entry && entry.stored
                  ? [
                      {
                        entity: entity.key,
                        key,
                        table: entity.descriptor.dbTable ?? null,
                        type: "type" in entry ? entry.type : "number",
                        publishes: "derivedValue",
                        stored: entry.stored,
                      },
                    ]
                  : [],
            ),
            ...Object.entries(entity.fieldModel.stored).map(
              ([key, { resultSchema: _resultSchema, ...stored }]) => ({
                entity: entity.key,
                key,
                table: entity.descriptor.dbTable ?? null,
                type: "text",
                // Non-list values may publish to the cache without a list column.
                publishes: stored.publishes,
                stored,
              }),
            ),
            // Search documents (ADR 0021): the record's own row, its
            // attachments and attached images, plus declared related rows.
            ...(entity.descriptor.searchable === true &&
            typeof entity.descriptor.dbTable === "string"
              ? [
                  {
                    entity: entity.key,
                    key: "searchDocument",
                    table: entity.descriptor.dbTable,
                    type: "text",
                    publishes: "ownTable",
                    stored: {
                      compute: `search.${entity.key}`,
                      inputs: [
                        {
                          table: entity.descriptor.dbTable,
                          match: { id: "id" },
                          // Publication bookkeeping cannot change searchable content.
                          except: Object.values(
                            entity.fieldModel.stored,
                          ).flatMap((stored) =>
                            stored.recordSource
                              ? [
                                  stored.recordSource.computedAt,
                                  ...(stored.recordSource.freshAt
                                    ? [stored.recordSource.freshAt]
                                    : []),
                                ]
                              : [],
                          ),
                        },
                        {
                          table: "EntityAttachment",
                          match: { entityId: "id" },
                          where: { entityKind: entity.key },
                        },
                        {
                          table: "Image",
                          match: { id: "id" },
                          columns: ["deletedAt", "shortcode"],
                          path: [
                            {
                              table: "EntityAttachment",
                              from: "imageId",
                              to: "entityId",
                              where: { entityKind: entity.key },
                            },
                          ],
                        },
                        ...entity.searchInputs,
                      ],
                    },
                  },
                ]
              : []),
            // Stored quality (ADR 0021): the record's own row, its waivers and
            // its attachments, plus the declared reads of its evaluator.
            ...(entity.dataQuality && entity.descriptor.dbTable
              ? [
                  {
                    entity: entity.key,
                    key: "dataQuality",
                    table: entity.descriptor.dbTable,
                    type: "number",
                    publishes: "derivedValue",
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
        },
      ],
    }),
    artifact(
      "packages/schemas/src/generated/entity-stored-result-schemas.gen.ts",
      {
        imports: [
          typeImport(["StoredResultSchemas"]),
          ...resultEntities.map((entity, index) => {
            const declaration = declarationModules.get(entity.key);
            if (!declaration)
              throw new EntityDeclarationError(
                `${entity.key} has no result schema declaration module.`,
              );
            return {
              from: declaration.path,
              names: [`default as resultDefinition${index}`],
            };
          }),
        ],
        consts: [
          {
            name: "generatedStoredResultSchemas",
            value: Object.fromEntries(
              resultEntities.flatMap((entity, index) =>
                Object.entries(entity.fieldModel.stored).flatMap(
                  ([key, stored]) =>
                    stored.resultSchema
                      ? [
                          [
                            `${entity.key}.${key}`,
                            tsReference(
                              `resultDefinition${index}`,
                              "model",
                              "stored",
                              key,
                              "resultSchema",
                            ),
                          ],
                        ]
                      : [],
                ),
              ),
            ),
            satisfies: "StoredResultSchemas",
          },
        ],
      },
    ),
    artifact("packages/schemas/src/generated/entity-list-fields.gen.ts", {
      imports: [typeImport(["TupleMember"])],
      consts: [
        {
          name: "generatedEntityListFields",
          value: Object.fromEntries(
            entities.map(({ key, listFields }) => [key, listFields]),
          ),
        },
        {
          name: "listTermKeys",
          value: [
            ...new Set(
              entities.flatMap(({ listFields }) =>
                Object.values(listFields.terms),
              ),
            ),
          ].sort(),
        },
      ],
      types: [
        {
          name: "GeneratedListTermKey",
          target: "TupleMember<typeof listTermKeys>",
        },
      ],
      exports: [
        {
          from: "../entity-list-fields-types",
          typeOnly: true,
          names: [
            "GeneratedDerivedValueKey",
            "GeneratedRepositoryRowSetKey",
            "GeneratedListScopeKey",
            "GeneratedListScopeTarget",
            "GeneratedDerivedPredicateKey",
          ],
        },
        {
          from: "../entity-projection-types",
          typeOnly: true,
          names: [
            "GeneratedListField",
            "GeneratedRowSet",
            "GeneratedInherit",
            "GeneratedGroupChoice",
            "GeneratedListScope",
          ],
        },
      ],
    }),
    artifact("packages/schemas/src/generated/entity-sort.gen.ts", {
      consts: [
        {
          name: "generatedEntitySort",
          value: entitySort,
        },
      ],
      exports: [
        {
          from: "../entity-sort-types",
          typeOnly: true,
          names: ["GeneratedEntitySortField"],
        },
      ],
    }),
    artifact("packages/schemas/src/generated/entity-inspector.gen.ts", {
      imports: [typeImport(["MetadataEntityInspectorMetadata"])],
      consts: [
        {
          name: "entityInspectorMetadata",
          value: inspectorMetadata,
          satisfies: "MetadataEntityInspectorMetadata",
        },
      ],
      exports: [
        {
          from: "../entity-projection-types",
          typeOnly: true,
          names: ["EntityInspectorMetadata"],
        },
      ],
    }),
    artifact("apps/web/src/entity/generated/entity-icon-data.gen.ts", {
      imports: browserIcons.map((name) => ({
        from: `@phosphor-icons/react/dist/csr/${name}`,
        names: [`${name}Icon`],
      })),
      consts: [
        {
          name: "PHOSPHOR_ICONS",
          value: Object.fromEntries(
            browserIcons.map((name) => [name, tsReference(`${name}Icon`)]),
          ),
        },
      ],
    }),
    artifact("apps/web/src/entity/generated/entity-icons.gen.ts", {
      exports: [
        {
          from: "../model/browser-definitions",
          names: ["generatedBrowserDefinitions"],
        },
      ],
    }),
    artifact("apps/web/src/entity/generated/entity-routes.gen.ts", {
      consts: [
        {
          name: "generatedBrowserRoutes",
          value: Object.fromEntries(
            projections.routes.map((entity) => {
              const { basePath, routes } = browserRoutes(entity);
              return [entity.key, { basePath, routes }];
            }),
          ),
        },
        { name: "generatedBrowserCrudEntities", value: browserCrudEntities },
      ],
      exports: [
        {
          from: "../model/browser-definitions",
          typeOnly: true,
          names: ["GeneratedBrowserCrudEntity"],
        },
      ],
    }),
    artifact("apps/web/src/server/generated/entity-kernel-entities.gen.ts", {
      consts: [
        { name: "generatedEntityKernelEntities", value: kernelEntityKeys },
        {
          name: "generatedEntityKernelContractCases",
          value: kernelContractCases,
        },
        {
          name: "generatedMcpEntityKernelContractCases",
          value: mcpKernelContractCases,
        },
        {
          name: "generatedMcpEntityActionEntities",
          value: Object.fromEntries(
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
        },
        {
          name: "generatedSearchEntityKernelEntities",
          value: entitiesForAction("search"),
        },
        {
          name: "generatedEntityResolveCapabilities",
          value: Object.fromEntries(
            kernelEntities.flatMap((entity) =>
              entity.resolve === null ? [] : [[entity.key, entity.resolve]],
            ),
          ),
        },
        {
          name: "generatedResolveEntityKernelEntities",
          value: entitiesForAction("resolve"),
        },
        {
          name: "generatedMergeEntityKernelEntities",
          value: entitiesForAction("merge"),
        },
      ],
    }),
  ];
};
