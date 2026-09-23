import {
  entityFieldControlKinds as fieldControlKinds,
  entityFieldKinds as fieldKinds,
} from "../../../../packages/schemas/src/entity-definitions/definition.ts";
import { compactLiteral, generatedHeader } from "../../artifacts.ts";
import {
  EntityDeclarationError,
  declarationModules,
  stringValue,
} from "../declarations.ts";
import type {
  CompiledEntity,
  EntityArtifacts,
  EntityField,
  FilterDescriptor,
  SourceRef,
} from "../declarations.ts";
import { renderEntityColumnsArtifact } from "./columns.ts";
import { renderFieldExplanationReference } from "./field-explanations-reference.ts";
import { renderRecord } from "./record.ts";
import { browserRoutes, lowerCamelCase } from "./routes.ts";
import { kernelEntitiesFor } from "./shared.ts";
import { renderSwiftEntityCatalog } from "./swift-catalog.ts";
import { renderDataQualityArtifacts } from "./data-quality.ts";
import { renderImagePolicyArtifacts } from "./image-policy.ts";

type ContractEntity = CompiledEntity & {
  contract: NonNullable<CompiledEntity["contract"]>;
};

type EntityProjectionMaps = Readonly<{
  schema: readonly ContractEntity[];
  detail: readonly ContractEntity[];
  list: readonly ContractEntity[];
  filters: readonly CompiledEntity[];
  routes: readonly CompiledEntity[];
}>;

/**
 * Detail, list, and filter artifacts consume the same compiled schema map.
 * Keep the surface selection here so generated projections cannot quietly
 * drift into independently-maintained entity rosters.
 */
export const entityProjectionMaps = (
  entities: readonly CompiledEntity[],
): EntityProjectionMaps => {
  const schema = entities.filter(
    (entity): entity is ContractEntity => entity.contract !== null,
  );
  const detail = schema.filter(
    ({ contract }) => contract.create !== null && contract.update !== null,
  );
  const list = detail.filter(
    ({ descriptor }) => descriptor.browserRoutes !== false,
  );
  return {
    schema,
    detail,
    list,
    filters: entities,
    routes: entities.filter(
      ({ descriptor }) => descriptor.browserRoutes !== false,
    ),
  };
};

interface DerivedFilterFields {
  imports: string;
  entries: string[];
}

interface DerivedFilterNeeds {
  z: boolean;
  oneOrMany: boolean;
  presence: boolean;
  numeric: boolean;
  date: boolean;
}

const derivedEnumValues = (
  descriptor: FilterDescriptor,
  needs: DerivedFilterNeeds,
  readRef: (descriptor: FilterDescriptor) => string,
  refAlias: (ref: SourceRef) => string,
): string => {
  if (descriptor.schemaFromRead) return readRef(descriptor);
  if (descriptor.schemaRef !== null) return refAlias(descriptor.schemaRef);
  needs.z = true;
  return descriptor.options === null
    ? "z.string()"
    : `z.enum(${JSON.stringify(descriptor.options.map((option) => option.value))})`;
};

const derivedRangeEntry = (
  entity: CompiledEntity,
  descriptor: FilterDescriptor,
  key: string,
  needs: DerivedFilterNeeds,
): string => {
  const range = descriptor.range;
  if (range === null)
    throw new EntityDeclarationError(
      `${entity.key} filter ${descriptor.columnId} range was not resolved.`,
    );
  if (range.kind === "date") {
    needs.date = true;
    const describe =
      range.describe === null
        ? ""
        : `,{describe:{from:${JSON.stringify(range.describe.lower)},to:${JSON.stringify(range.describe.upper)}}}`;
    return `...dateRangeFields(${JSON.stringify(key)}${describe})`;
  }
  needs.numeric = true;
  const options = [
    ...(range.int ? ["int:true"] : []),
    ...(range.nonnegative ? ["nonnegative:true"] : []),
    ...(range.finite ? ["finite:true"] : []),
    ...(range.describe === null
      ? []
      : [
          `describe:{min:${JSON.stringify(range.describe.lower)},max:${JSON.stringify(range.describe.upper)}}`,
        ]),
  ];
  return `...numericRangeFields(${JSON.stringify(key)}${options.length ? `,{${options.join(",")}}` : ""})`;
};

const derivedFilterImports = (
  needs: DerivedFilterNeeds,
  refs: ReadonlyMap<string, string>,
): string => {
  const byModule = new Map<string, string[]>();
  for (const [key, alias] of refs) {
    const [module = "", name = ""] = key.split("#");
    const list = byModule.get(module) ?? [];
    list.push(`${name} as ${alias}`);
    byModule.set(module, list);
  }
  const pagination = [
    ...(needs.oneOrMany ? ["oneOrMany"] : []),
    ...(needs.presence ? ["presenceFilter"] : []),
  ];
  const ranges = [
    ...(needs.date ? ["dateRangeFields"] : []),
    ...(needs.numeric ? ["numericRangeFields"] : []),
  ];
  return [
    ...(needs.z ? ['import { z } from "zod";'] : []),
    ...(pagination.length
      ? [
          `import { ${pagination.join(", ")} } from "@cubby/schemas/pagination";`,
        ]
      : []),
    ...(ranges.length
      ? [`import { ${ranges.join(", ")} } from "@cubby/schemas/base-entity";`]
      : []),
    ...[...byModule.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([module, names]) =>
          `import { ${names.join(", ")} } from ${JSON.stringify(module)};`,
      ),
  ]
    .map((line) => `${line}\n`)
    .join("");
};

/**
 * Filter fields derived from descriptors flagged `deriveSchema`: the Zod for a
 * filter key is spelled once, next to the column it filters. Enum values come
 * from the model field's read schema (`schemaFromRead`), a named export
 * (`schemaRef`), or the descriptor's static options; ranges expand to the
 * shared min/max or from/to builders.
 */
const renderDerivedFilterFields = (
  entity: CompiledEntity,
  fields: readonly EntityField[],
): DerivedFilterFields => {
  const refs = new Map<string, string>();
  const refAlias = (ref: SourceRef) => {
    const key = `${ref.module}#${ref.export}`;
    const existing = refs.get(key);
    if (existing) return existing;
    const alias = `filterSchema${refs.size}`;
    refs.set(key, alias);
    return alias;
  };
  const needs: DerivedFilterNeeds = {
    z: false,
    oneOrMany: false,
    presence: false,
    numeric: false,
    date: false,
  };
  const readRef = (descriptor: FilterDescriptor) => {
    const index = fields.findIndex(
      (field) => field.key === descriptor.columnId,
    );
    if (index < 0)
      throw new EntityDeclarationError(
        `${entity.key} filter ${descriptor.columnId} has no model field for schemaFromRead.`,
      );
    return `definition.model.fields[${index}].validation.read`;
  };
  const entries = entity.filterDescriptors
    .filter((descriptor) => descriptor.deriveSchema)
    .map((descriptor) => {
      const name = descriptor.field ?? descriptor.columnId;
      const key = JSON.stringify(name);
      const describe =
        descriptor.schemaDescription === null
          ? ""
          : `.describe(${JSON.stringify(descriptor.schemaDescription)})`;
      switch (descriptor.kind) {
        case "text": {
          if (!descriptor.schemaFromRead) needs.z = true;
          const base = descriptor.schemaFromRead
            ? readRef(descriptor)
            : "z.string()";
          return `${key}:${base}.optional()${describe}`;
        }
        case "boolean":
          needs.z = true;
          return `${key}:z.boolean().optional()${describe}`;
        case "presence":
          needs.presence = true;
          return `${key}:presenceFilter${describe}`;
        case "select":
        case "multiselect":
          needs.oneOrMany = true;
          return `${key}:oneOrMany(${derivedEnumValues(descriptor, needs, readRef, refAlias)}).optional()${describe}`;
        case "range":
          return derivedRangeEntry(entity, descriptor, name, needs);
        default:
          throw new EntityDeclarationError(
            `${entity.key} filter ${descriptor.columnId} cannot derive a ${descriptor.kind} schema.`,
          );
      }
    });
  return { imports: derivedFilterImports(needs, refs), entries };
};

// One render pass preserves deterministic cross-artifact ordering and hashes.
export type HttpResourceVerb =
  | "list"
  | "timeline"
  | "get"
  | "create"
  | "update"
  | "delete";
export type HttpResources = Readonly<
  Record<
    string,
    Readonly<{ basePath: string; verbs: readonly HttpResourceVerb[] }>
  >
>;

/**
 * HTTP resource verbs per entity, as data: the ts-rest router (stage 2)
 * builds its resource routes from these at generation time so the contract
 * keeps static types, and `http-resources.gen.ts` publishes the same table
 * to the web inspector.
 */
export const httpResourcesFor = (
  entities: readonly CompiledEntity[],
): HttpResources => {
  const projections = entityProjectionMaps(entities);
  return Object.fromEntries(
    kernelEntitiesFor(entities).flatMap((entity) => {
      if (!entity.route || !entity.contract) return [];
      const verbs: HttpResourceVerb[] = [];
      const listed = projections.list.some(
        (candidate) => candidate.key === entity.key,
      );
      if (listed) verbs.push("list");
      // `/<basePath>/timeline` is registered before `/<basePath>/:id`: the
      // contract keeps key order and itty-router takes the first match.
      if (entity.timeline !== null) {
        if (!listed)
          throw new EntityDeclarationError(
            `${entity.key}.capabilities.timeline needs a generated list (the timeline reads the list filters).`,
          );
        verbs.push("timeline");
      }
      if (projections.detail.some((candidate) => candidate.key === entity.key))
        verbs.push("get");
      if (entity.contract.create) verbs.push("create");
      if (entity.contract.update) verbs.push("update");
      if (entity.operationOwners.delete === "kernel") verbs.push("delete");
      return [[entity.key, { basePath: entity.route.basePath, verbs }]];
    }),
  );
};

/** Entity key -> output schema export name, for the OpenAPI stage's Swift aliases. */
export const entityOutputsFor = (
  entities: readonly CompiledEntity[],
): ReadonlyMap<string, string | null> =>
  new Map(
    entities.map(({ key, contract }) => [key, contract?.output.export ?? null]),
  );

export const renderEntityArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const projections = entityProjectionMaps(entities);
  const imports = new Map<string, Set<string>>();
  for (const { contract, filterSchema } of entities) {
    if (contract === null) continue;
    for (const ref of [
      contract.create,
      contract.update,
      contract.output,
      contract.list,
      contract.detail,
      contract.mcpOutput,
      contract.mcpList,
      contract.mcpDetail,
      filterSchema,
    ]) {
      if (ref === null) continue;
      const exports = imports.get(ref.module) ?? new Set<string>();
      exports.add(ref.export);
      imports.set(ref.module, exports);
    }
  }
  const schemaImportEntries = [...imports.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const identifierImportIndex = schemaImportEntries.findIndex(
    ([module]) => module.localeCompare("@cubby/schemas/identifiers") > 0,
  );
  schemaImportEntries.splice(
    identifierImportIndex === -1
      ? schemaImportEntries.length
      : identifierImportIndex,
    0,
    ["@cubby/schemas/identifiers", new Set(["shortcodeSchema"])],
  );
  const schemaImports = schemaImportEntries
    .map(
      ([module, exports]) =>
        `import { ${[...exports].sort().join(", ")} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const schemaEntitySpecs = projections.schema;
  const schemaBindings = schemaEntitySpecs
    .map((entity) => {
      const { contract, filterSchema } = entity;
      if (entity.bulkUpdateFields !== null && contract.update === null) {
        throw new EntityDeclarationError(
          `${entity.key}.bulkUpdate requires an update contract.`,
        );
      }
      const bulkUpdateInput =
        entity.bulkUpdateFields === null
          ? "null"
          : `${contract.update?.export}.pick({${entity.bulkUpdateFields
              .map((field) => `${JSON.stringify(field)}:true`)
              .join(",")}}).strict()`;
      const filters =
        filterSchema === null
          ? "z.object({})"
          : entity.descriptor.searchable === true
            ? `z.object(${filterSchema.export}).extend({searchQuery:z.string().trim().min(1).max(100).optional()})`
            : `z.object(${filterSchema.export})`;
      return `  ${JSON.stringify(entity.key)}: entitySchema(${JSON.stringify(entity.key)},{filters:${filters},createInput:${contract.create?.export ?? "null"},updateInput:${contract.update?.export ?? "null"},bulkUpdateInput:${bulkUpdateInput},output:${contract.output.export},detail:${contract.detail.export},list:${contract.list.export},mcpOutput:${contract.mcpOutput.export},mcpDetail:${contract.mcpDetail.export},mcpList:${contract.mcpList.export}}),`;
    })
    .join("\n");
  const bindings = entities
    .filter((entity) => entity.shortcode !== null)
    .map((entity) => {
      if (
        entity.contract === null ||
        entity.contract.create === null ||
        entity.contract.update === null
      )
        return `  ${JSON.stringify(entity.key)}: { crud: null },`;
      return `  ${JSON.stringify(entity.key)}: {crud:ENTITY_SCHEMA_BINDINGS[${JSON.stringify(entity.key)}]},`;
    })
    .join("\n");
  const detailEntities = projections.detail;
  const detailSchemas = detailEntities
    .map(
      ({ key, contract }) =>
        `  ${JSON.stringify(key)}: withEntityDetailMedia(${contract.detail.export}),`,
    )
    .join("\n");
  const detailTypeImports = new Map<string, Set<string>>();
  for (const { contract } of detailEntities) {
    const exports =
      detailTypeImports.get(contract.detail.module) ?? new Set<string>();
    exports.add(contract.detail.export);
    detailTypeImports.set(contract.detail.module, exports);
  }
  const detailRuntimeImportSource = [
    ...[...detailTypeImports.entries()].map(([module, exports]) => ({
      module,
      source: `import { ${[...exports].sort().join(", ")} } from ${JSON.stringify(module)};`,
    })),
    {
      module: "@cubby/schemas/entity-read-media",
      source:
        'import { withEntityDetailMedia } from "@cubby/schemas/entity-read-media";',
    },
    {
      module: "@cubby/schemas/identifiers",
      source: 'import { shortcodeSchema } from "@cubby/schemas/identifiers";',
    },
    { module: "zod", source: 'import { z } from "zod";' },
  ]
    .sort((left, right) => left.module.localeCompare(right.module))
    .map(({ source }) => source)
    .join("\n");
  const detailInputVariants = detailEntities
    .map(
      ({ key }) =>
        `z.object({entity:z.literal(${JSON.stringify(key)}),shortcode:shortcodeSchema(${JSON.stringify(key)})})`,
    )
    .join(",\n  ");

  const browserCrudEntitySpecs = projections.list;
  const browserCrudEntities = browserCrudEntitySpecs.map(({ key }) => key);
  const listRuntimeOutputImports = browserCrudEntitySpecs
    .map(
      ({ key, contract }) =>
        `import { ${contract.list.export} as ${key}ListOutputSchema } from ${JSON.stringify(contract.list.module)};`,
    )
    .join("\n");
  const listFilterFieldImports = browserCrudEntitySpecs
    .flatMap(({ key, filterSchema }) =>
      filterSchema === null
        ? []
        : [
            `import { ${filterSchema.export} as ${key}ListFilterFields } from ${JSON.stringify(filterSchema.module)};`,
          ],
    )
    .join("\n");
  const listInputVariants = browserCrudEntitySpecs
    .map(
      ({ key, filterSchema }) =>
        `z.object({entity:z.literal(${JSON.stringify(key)}),filters:${filterSchema === null ? "z.record(z.string(),z.unknown())" : `${key}ListFiltersSchema`},sort:entityListSortsSchema.optional(),pagination:entityListPaginationSchema.optional(),groupBy:z.string().min(1).optional()})`,
    )
    .join(",\n  ");
  const listFilterSchemas = browserCrudEntitySpecs
    .map(({ key, filterSchema, descriptor }) =>
      filterSchema === null
        ? `const ${key}ListFiltersSchema = z.record(z.string(), z.unknown());`
        : `const ${key}ListFiltersSchema = ${
            descriptor.searchable === true
              ? `z.object(${key}ListFilterFields).extend({searchQuery:z.string().trim().min(1).max(100).optional()})`
              : `z.object(${key}ListFilterFields)`
          };`,
    )
    .join("\n");
  const listFilterSchemaBindings = browserCrudEntitySpecs
    .map(({ key }) => `  ${JSON.stringify(key)}: ${key}ListFiltersSchema,`)
    .join("\n");
  // One named export per list row so the OpenAPI stage names the component
  // `<Entity>ListItem` (the export walk in `http-api/schema-names.ts` names
  // exported instances only); an inline `withEntityListMedia(...)` call would
  // surface in Swift as a positional `ItemsPayloadPayload`.
  const listItemSchemas = browserCrudEntitySpecs
    .map(
      ({ key }) =>
        `export const ${key}ListItem = withEntityListMedia(${key}ListOutputSchema);`,
    )
    .join("\n");
  const listOutputSchemas = browserCrudEntitySpecs
    .map(
      ({ key }) =>
        `  ${JSON.stringify(key)}: z.object({items:z.array(${key}ListItem),meta:entityListMetaSchema}),`,
    )
    .join("\n");
  const mutationOutputImportEntries = new Map<string, Set<string>>();
  for (const { contract } of browserCrudEntitySpecs) {
    if (!contract)
      throw new EntityDeclarationError(
        "Browser CRUD entity is missing its contract.",
      );
    const exports =
      mutationOutputImportEntries.get(contract.output.module) ??
      new Set<string>();
    exports.add(contract.output.export);
    mutationOutputImportEntries.set(contract.output.module, exports);
  }
  const mutationOutputImports = [...mutationOutputImportEntries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([module, exports]) =>
        `import { ${[...exports].sort().join(", ")} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const mutationOutputTypes = browserCrudEntitySpecs
    .map(({ key, contract }) => {
      if (!contract)
        throw new EntityDeclarationError(
          "Browser CRUD entity is missing its contract.",
        );
      return `  ${JSON.stringify(key)}: z.output<typeof ${contract.output.export}>;`;
    })
    .join("\n");
  const mutationOutputSchemas = browserCrudEntitySpecs
    .map(({ key, contract }) => {
      if (!contract)
        throw new EntityDeclarationError(
          "Browser CRUD entity is missing its contract.",
        );
      return `  ${JSON.stringify(key)}: ${contract.output.export},`;
    })
    .join("\n");
  const commandVariants = (
    action: "create" | "update",
    schema: "create" | "update",
    audience: "mcp" | null = null,
  ) =>
    entities
      .filter(
        (entity) =>
          entity.contract !== null &&
          entity.contract[schema] !== null &&
          (audience === null ||
            (Array.isArray(entity.descriptor.mcp) &&
              entity.descriptor.mcp.includes(action))),
      )
      .map((entity) => {
        const schemaRef = entity.contract?.[schema];
        if (!schemaRef)
          throw new EntityDeclarationError(
            `${entity.key}.${schema} is missing.`,
          );
        const id =
          action === "update"
            ? ",id:shortcodeSchema(" + JSON.stringify(entity.key) + ")"
            : "";
        return `z.object({action:z.literal(${JSON.stringify(action)}),entity:z.literal(${JSON.stringify(entity.key)})${id},data:${schemaRef.export}})`;
      })
      .join(",\n  ");
  const mutationResultVariants = (action: "create" | "update") =>
    entities
      .filter(
        (entity) =>
          entity.contract !== null && entity.contract[action] !== null,
      )
      .map((entity) => {
        const output = entity.contract?.output;
        if (!output)
          throw new EntityDeclarationError(`${entity.key}.output is missing.`);
        return `z.object({action:z.literal(${JSON.stringify(action)}),entity:z.literal(${JSON.stringify(entity.key)}),item:${output.export},sideEffects:mutationSideEffectsSchema})`;
      })
      .join(",\n  ");
  const mcpMutationResultVariants = (action: "create" | "update") =>
    entities
      .filter(
        (entity) =>
          entity.contract !== null &&
          entity.contract[action] !== null &&
          Array.isArray(entity.descriptor.mcp) &&
          entity.descriptor.mcp.includes(action),
      )
      .map((entity) => {
        const output = entity.contract?.mcpOutput;
        if (!output)
          throw new EntityDeclarationError(
            `${entity.key}.mcpOutput is missing.`,
          );
        return `z.object({action:z.literal(${JSON.stringify(action)}),entity:z.literal(${JSON.stringify(entity.key)}),item:${output.export},sideEffects:mutationSideEffectsSchema})`;
      })
      .join(",\n  ");
  const queryGetResultVariants = schemaEntitySpecs
    .map(
      ({ key, contract }) =>
        `z.object({action:z.literal("get"),entity:z.literal(${JSON.stringify(key)}),item:withEntityDetailMedia(${contract.detail.export}).nullable()})`,
    )
    .join(",\n  ");
  const queryListResultVariants = schemaEntitySpecs
    .map(
      ({ key, contract }) =>
        `z.object({action:z.literal("list"),entity:z.literal(${JSON.stringify(key)}),items:z.array(withEntityListMedia(${contract.list.export})),meta:generatedEntityListMetaSchema})`,
    )
    .join(",\n  ");
  const mcpQueryGetResultVariants = schemaEntitySpecs
    .filter(
      (entity) =>
        Array.isArray(entity.descriptor.mcp) &&
        entity.descriptor.mcp.includes("get"),
    )
    .map(
      ({ key, contract }) =>
        `z.object({action:z.literal("get"),entity:z.literal(${JSON.stringify(key)}),item:withEntityDetailMedia(${contract.mcpDetail.export}).nullable()})`,
    )
    .join(",\n  ");
  const mcpQueryListResultVariants = schemaEntitySpecs
    .filter(
      (entity) =>
        Array.isArray(entity.descriptor.mcp) &&
        entity.descriptor.mcp.includes("list"),
    )
    .map(
      ({ key, contract }) =>
        `z.object({action:z.literal("list"),entity:z.literal(${JSON.stringify(key)}),items:z.array(withEntityListMedia(${contract.mcpList.export})),meta:generatedEntityListMetaSchema})`,
    )
    .join(",\n  ");
  // A declared field list is compiled into `.pick({...}).strict()` on the
  // entity's own update schema: an undeclared field is REFUSED rather than
  // silently stripped, and a field the update schema does not have fails
  // `pnpm typecheck` on the generated file.
  const bulkUpdateEntities = entities.filter(
    (entity) =>
      entity.bulkUpdateFields !== null && entity.contract?.update !== null,
  );
  const bulkUpdateCommandVariantsFor = (
    entitySpecs: readonly CompiledEntity[],
  ) =>
    entitySpecs
      .map((entity) => {
        const schemaRef = entity.contract?.update;
        if (!schemaRef)
          throw new EntityDeclarationError(`${entity.key}.update is missing.`);
        const mask = (entity.bulkUpdateFields ?? [])
          .map((field) => `${JSON.stringify(field)}:true`)
          .join(",");
        return `z.object({action:z.literal("bulkUpdate"),entity:z.literal(${JSON.stringify(entity.key)}),ids,data:${schemaRef.export}.pick({${mask}}).strict()})`;
      })
      .join(",\n  ");
  // No declaration anywhere means the command exists but matches nothing,
  // rather than an empty `z.union([])` that fails far from its cause.
  const bulkUpdateCommandFactoryFor = (
    entitySpecs: readonly CompiledEntity[],
  ) =>
    entitySpecs.length === 0
      ? "(_ids: z.ZodType<string[]>) => z.never()"
      : `(ids: z.ZodType<string[]>) => z.union([\n  ${bulkUpdateCommandVariantsFor(entitySpecs)}\n])`;
  const bulkUpdateCommandFactory =
    bulkUpdateCommandFactoryFor(bulkUpdateEntities);
  const mcpBulkUpdateEntities = bulkUpdateEntities.filter(
    (entity) =>
      Array.isArray(entity.descriptor.mcp) &&
      entity.descriptor.mcp.includes("bulkUpdate"),
  );
  const mcpBulkUpdateCommandFactory = bulkUpdateCommandFactoryFor(
    mcpBulkUpdateEntities,
  );
  const kernelEntities = kernelEntitiesFor(entities);
  const kernelEntityKeys = kernelEntities.map(({ key }) => key);
  const filterFieldImports = new Map<string, Set<string>>();
  for (const { filterSchema } of entities) {
    if (filterSchema === null) continue;
    const exports =
      filterFieldImports.get(filterSchema.module) ?? new Set<string>();
    exports.add(filterSchema.export);
    filterFieldImports.set(filterSchema.module, exports);
  }
  const filterFieldImportSource = [...filterFieldImports.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([module, exports]) =>
        `import { ${[...exports].sort().join(", ")} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const filterFieldBindings = entities
    .flatMap(({ key, filterSchema }) =>
      filterSchema === null
        ? []
        : [`  ${JSON.stringify(key)}: ${filterSchema.export},`],
    )
    .join("\n");
  const httpResources = Object.entries(httpResourcesFor(entities))
    .map(
      ([key, { basePath, verbs }]) =>
        `  ${JSON.stringify(key)}: { basePath: ${JSON.stringify(basePath)}, verbs: ${JSON.stringify(verbs)} },`,
    )
    .join("\n");
  const lifecycleFor = (entity: CompiledEntity) => entity.lifecycle;
  const kernelActionsFor = (entity: CompiledEntity) => {
    const lifecycle = lifecycleFor(entity);
    return [
      "get",
      "list",
      ...(entity.descriptor.searchable === true ? ["search"] : []),
      ...(entity.contract?.create ? ["create"] : []),
      ...(entity.contract?.update ? ["update"] : []),
      ...(entity.bulkUpdateFields === null ? [] : ["bulkUpdate"]),
      ...(lifecycle.delete === null ? [] : ["delete"]),
      ...(lifecycle.merge === true ? ["merge"] : []),
    ];
  };
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
  const mcpActionsFor = (entity: CompiledEntity): string[] => [
    ...entity.mcpActions,
  ];
  const mcpKernelContractCases = Object.fromEntries(
    kernelEntities.map((entity) => {
      const declared = mcpActionsFor(entity);
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
  const mergeResultVariants = kernelEntities
    .filter((entity) => kernelActionsFor(entity).includes("merge"))
    .map((entity) => {
      if (entity.contract === null) {
        throw new EntityDeclarationError(
          `${entity.key}.merge output is missing.`,
        );
      }
      return `z.object({action:z.literal("merge"),entity:z.literal(${JSON.stringify(entity.key)}),item:${entity.contract.output.export},mergeSummary:z.json(),sideEffects:mutationSideEffectsSchema})`;
    })
    .join(",\n  ");
  const mcpMergeResultVariants = kernelEntities
    .filter((entity) => mcpActionsFor(entity).includes("merge"))
    .map((entity) => {
      if (entity.contract === null) {
        throw new EntityDeclarationError(
          `${entity.key}.merge output is missing.`,
        );
      }
      return `z.object({action:z.literal("merge"),entity:z.literal(${JSON.stringify(entity.key)}),item:${entity.contract.mcpOutput.export},mergeSummary:z.json(),sideEffects:mutationSideEffectsSchema})`;
    })
    .join(",\n  ");
  const shortcodePrefixes = Object.fromEntries(
    entities.flatMap(({ key, shortcode }) =>
      shortcode === null ? [] : [[key, shortcode]],
    ),
  );
  const inspectorMetadata = Object.fromEntries(
    entities.map((entity) => {
      const lifecycle = lifecycleFor(entity);
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
          primarySearch:
            entity.inspector.list.primarySearch ??
            (entity.contract !== null && entity.descriptor.searchable === true
              ? {
                  key: "searchQuery",
                  placeholder: `Search ${(entity.inspector.plural ?? entity.inspector.singular).toLowerCase()} or shortcode`,
                }
              : null),
          browserRouted: entity.descriptor.browserRoutes !== false,
          auditable: entity.descriptor.auditable === true,
          hasImages: entity.descriptor.hasImages === true,
          imageStorage: entity.descriptor.imageStorage,
          displayImages: entity.descriptor.displayImages === true,
          countable: entity.descriptor.countable === true,
          kernelActions,
          filterUrlKeys: entity.filterUrlKeys,
          filterDescriptors: entity.filterDescriptors,
          mcpOperations,
          mcpOwner,
          lifecycle: {
            softDelete: entity.descriptor.softDelete === true,
            delete: lifecycle.delete,
            merge: lifecycle.merge === true,
            bulkUpdate:
              entity.bulkUpdateFields === null
                ? null
                : { fields: entity.bulkUpdateFields },
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
  const fieldModels = Object.fromEntries(
    entities.map(({ key, fieldModel }) => {
      const { sort: _sort, intents: _intents, ...rest } = fieldModel;
      return [
        key,
        {
          ...rest,
          fields: fieldModel.fields.map(({ validation, ...field }) => ({
            ...field,
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
  // entities, in declaration order — the decision-tier (Jev) field-suggest
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
              computed: fieldModel.sort.computed,
              groupable: fieldModel.sort.groupable,
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
              },
            ] as const,
          ],
    ),
  );
  const fieldByKey = (entity: CompiledEntity, key: string) => {
    const field = entity.fieldModel.fields.find(
      (candidate) => candidate.key === key,
    );
    if (field === undefined)
      throw new EntityDeclarationError(
        `${entity.key}.model is missing field ${key}.`,
      );
    return field;
  };
  const validationComplete = (
    entity: CompiledEntity,
    mode: "create" | "update" | "read",
    keys: readonly string[],
  ) => keys.every((key) => fieldByKey(entity, key).validation[mode] !== null);
  const fieldSchemaArtifacts = entities.flatMap((entity) => {
    const { fieldModel } = entity;
    if (
      fieldModel.create.length +
        fieldModel.update.length +
        fieldModel.output.length ===
      0
    )
      return [];
    for (const [mode, keys] of [
      ["create", fieldModel.create],
      ["update", fieldModel.update],
      ["read", fieldModel.output],
    ] as const)
      if (!validationComplete(entity, mode, keys))
        throw new EntityDeclarationError(
          `${entity.key}.${mode} roster has missing schemas.`,
        );
    const declaration = declarationModules.get(entity.key);
    if (!declaration)
      throw new EntityDeclarationError(
        `${entity.key} has no declaration module.`,
      );
    const prefix = `generated${entity.inspector.singular.replaceAll(" ", "")}`;
    const filterFields = renderDerivedFilterFields(entity, fieldModel.fields);
    return [
      {
        relativePath: `packages/schemas/src/generated/entity-field-schemas.${entity.key}.gen.ts`,
        source:
          generatedHeader +
          `import definition from ${JSON.stringify(declaration.path)};\n` +
          'import { fieldSchemasOf } from "../entity-definitions/definition";\n' +
          (entity.dataQuality === null
            ? ""
            : 'import { dataQuality } from "../data-quality-shape";\n') +
          filterFields.imports +
          (declaration.enumExports.length
            ? `export {${declaration.enumExports.join(",")}} from ${JSON.stringify(declaration.path)};\n`
            : "") +
          // Keyed by roster, not field index: `fieldSchemasOf` reads each
          // schema by key at load time, so inserting a field mid-declaration
          // cannot shift another field's schema. The rosters were validated
          // complete above; the runtime lookup throws on a missing schema.
          (entity.dataQuality === null
            ? `export const ${prefix}FieldSchemas = fieldSchemasOf(definition);\n`
            : // The compiler synthesizes `dataQuality` without a read schema
              // (it cannot import the registry it generates), so the real one
              // is spliced in here.
              "const declaredFieldSchemas = fieldSchemasOf(definition);\n" +
              `export const ${prefix}FieldSchemas = { ...declaredFieldSchemas, read: { ...declaredFieldSchemas.read, dataQuality } } as const;\n`) +
          (filterFields.entries.length
            ? `export const ${prefix}FilterFields = {${filterFields.entries.join(",")}} as const;\n`
            : ""),
      },
    ];
  });
  // Every table with a public shortcode, keyed the same way as SHORTCODE_PREFIX.
  // The Drizzle export name is always lowerCamelCase(dbTable) from the single
  // `~/server/db/schema` module — verified for all current shortcode entities.
  const shortcodeTableEntities = entities
    .flatMap((entity) => {
      const { dbTable } = entity.descriptor;
      return entity.shortcode === null ||
        dbTable === null ||
        dbTable === undefined
        ? []
        : [
            {
              key: entity.key,
              dbTable: stringValue(dbTable, `${entity.key}.descriptor.dbTable`),
            },
          ];
    })
    .sort((left, right) => left.key.localeCompare(right.key));
  const shortcodeTableImportNames = [
    ...new Set(
      shortcodeTableEntities.map(({ dbTable }) => lowerCamelCase(dbTable)),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const shortcodeTableBindings = shortcodeTableEntities
    .map(
      ({ key, dbTable }) =>
        `  ${JSON.stringify(key)}: ${lowerCamelCase(dbTable)},`,
    )
    .join("\n");
  return [
    ...renderDataQualityArtifacts(entities),
    ...renderImagePolicyArtifacts(entities),
    ...renderFieldExplanationReference(entities),
    {
      relativePath: "packages/shared/src/generated/shortcode-registry.gen.ts",
      source:
        generatedHeader +
        renderRecord({
          name: "SHORTCODE_PREFIX",
          entries: shortcodePrefixes,
          comment: "// Generated shortcode registry stays one entity per line.",
        }) +
        "export type ShortcodeType = keyof typeof SHORTCODE_PREFIX;\n",
    },
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
        'import type { CompiledEntityPresentation } from "../entity-definitions/definition";\n\n' +
        'export { WAYFINDING_DOMAINS } from "../entity-definitions/definition";\n' +
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
        " * detail sections, list views, edit rules. Data only — for eagerly-loaded\n" +
        " * client code (the entity registry, navigation, empty states,\n" +
        " * `identifiers.ts`) that must not pull the inspector.\n" +
        " */\n" +
        "export type EntitySummary = EntityNames & CompiledEntityPresentation;\n\n" +
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
            entities.map(({ key, inspector }) => [key, inspector]),
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
        'export type ListSlotId<E extends Entity> = Extract<GeneratedListView<E>, { kind: "slot" }>["id"];\n',
    },
    {
      relativePath: "packages/schemas/src/generated/entity-field-model.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "../entity-core";\n\n' +
        `export type GeneratedEntityFieldKind = ${fieldKinds.map((kind) => JSON.stringify(kind)).join(" | ")};\n` +
        `export type GeneratedEntityFieldControlKind = ${fieldControlKinds.map((kind) => JSON.stringify(kind)).join(" | ")};\n\n` +
        "type GeneratedEntityFieldResolutionValue = string | number | boolean | null | readonly GeneratedEntityFieldResolutionValue[] | GeneratedEntityFieldResolutionObject;\ninterface GeneratedEntityFieldResolutionObject { readonly [key: string]: GeneratedEntityFieldResolutionValue }\n\n" +
        'export type GeneratedEntityFieldProvenance = { kind: "reference" | "relation" | "derived"; sources: readonly { entity: Entity | null; label: string | null; relation: string | null }[] };\n\n' +
        "export type GeneratedEntityFieldModel = {\n" +
        '  fields: readonly { key: string; kind: GeneratedEntityFieldKind; nullable: boolean; requiredOnCreate: boolean; label: string; description: string | null; readKey: string | null; reference: { entity: string; multiple: boolean; scope: readonly { sourceField: string; targetField: string }[]; filters: readonly { field: string; values: readonly string[] }[] } | null; explanation: { ruleId: string; version: number; description: string; readPath?: string; resolver: "field" | "inventoryOwnership" | "productValuation" | "imageRepresentation" | "imageCapture" | "productQuantity" | "recipeTotals" | "locationValuation" | "merchantVendorInference" | "expenseAttribution"; projections?: Readonly<{ list?: string; detail?: string; summary?: string }>; sourceDependencies?: readonly Readonly<{ path: string; label: string }>[]; actions?: readonly ("confirmOwner" | "inheritOwner" | "editSource")[] } | null; resolution: { reset: Readonly<Record<string, GeneratedEntityFieldResolutionValue>>; none: Readonly<Record<string, GeneratedEntityFieldResolutionValue>> | null; redundancy: "eligible" | "intentional" } | null; provenance: GeneratedEntityFieldProvenance | null; control: { kind: GeneratedEntityFieldControlKind; renderer: string | null; options: readonly { value: string; label: string; description?: string }[] | null; section: string; width: "half" | null; placeholder: string | null; initial: "today" | null; suggest: { readonly basis: readonly string[]; readonly mode: "fill" | "prune" } | null } | null; display: { list: boolean; detail: boolean; columnId: string | null; standard: "name" | "image" | null; detailOrder: number | null; listOrder: number | null; width: "xs" | "sm" | "md" | "lg" | null; format: "currency" | "signedCurrency" | "plainDate" | "timestamp" | "external-link" | "amount" | null; renderer: { list: string | null; detail: string | null } | null; mobile: { slot: string; priority: number; interactive?: boolean } | null; listHidden: boolean } }[];\n' +
        '  storage: readonly { key: string; column: string; kind: GeneratedEntityFieldKind; nullable: boolean; default: "none" | "generated" | "now" | "literal"; defaultValue: unknown; reference: string | null; specialized: string | null }[];\n' +
        "  create: readonly string[];\n" +
        "  update: readonly string[];\n" +
        "  bulk: readonly string[];\n" +
        "  audit: readonly string[];\n" +
        "  output: readonly string[];\n" +
        "};\n\n" +
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
            "Partial<Record<Entity, { fields: Record<string, readonly string[]>; create: readonly [string, ...string[]]; update: readonly [string, ...string[]] }>>",
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
      relativePath: "packages/schemas/src/generated/entity-sort.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "../entity-core";\n\n' +
        "/**\n" +
        " * The declared list-sort roster for entities that expose one, keyed from\n" +
        " * `model.sort` in `packages/schemas/src/entity-definitions/*.entity.ts`.\n" +
        " * `computed` names roster entries with no `model.fields` read projection\n" +
        " * (correlated subqueries and rollups); `groupable` is the `groupBy` allowlist,\n" +
        " * defaulting to every sortable field when empty. `direction` is the list's\n" +
        ' * opening sort direction, defaulting to "desc".\n' +
        " */\n" +
        renderRecord({
          name: "generatedEntitySort",
          entries: entitySort,
          satisfies:
            'Partial<Record<Entity, { fields: readonly [string, ...string[]]; default: string; computed: readonly string[]; groupable: readonly string[]; direction: "asc" | "desc" }>>',
          comment: "// Generated sort rosters stay one entity per line.",
        }) +
        "\n" +
        "export type GeneratedEntitySortField<E extends keyof typeof generatedEntitySort> =\n" +
        '  (typeof generatedEntitySort)[E]["fields"][number];\n',
    },
    {
      relativePath: "apps/web/src/server/db/generated/entity-columns.gen.ts",
      source: renderEntityColumnsArtifact(entities),
    },
    ...fieldSchemaArtifacts,
    {
      relativePath: "packages/schemas/src/generated/entity-inspector.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "../entity";\n\n' +
        'import type { CompiledEntityPresentation } from "../entity-definitions/definition";\n\n' +
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
        '  kernelActions: readonly ("get" | "list" | "search" | "create" | "update" | "bulkUpdate" | "delete" | "merge")[];\n' +
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
        "};\n\n" +
        renderRecord({
          name: "entityInspectorMetadata",
          entries: inspectorMetadata,
          satisfies: "Record<Entity, EntityInspectorMetadata>",
          comment: "// Generated inspector metadata stays one entity per line.",
        }),
    },
    {
      relativePath: "apps/web/src/entities/generated/entity-details.gen.ts",
      source:
        generatedHeader +
        `${detailRuntimeImportSource}\n\n` +
        `export const detailEntities = ${compactLiteral(detailEntities.map(({ key }) => key))} as const;\n` +
        "export type DetailEntity = (typeof detailEntities)[number];\n\n" +
        "// One generated detail schema per entity.\n// oxfmt-ignore\n" +
        `const ENTITY_DETAIL_OUTPUT_SCHEMAS = {\n${detailSchemas}\n} as const;\n\n` +
        "// One generated detail input variant per entity.\n// oxfmt-ignore\n" +
        `export const entityDetailInputSchema = z.discriminatedUnion("entity", [\n  ${detailInputVariants}\n]);\n\n` +
        "type EntityDetailInput = z.input<typeof entityDetailInputSchema>;\n" +
        "type ParsedEntityDetailInput = z.output<typeof entityDetailInputSchema>;\n" +
        "export type EntityDetailByEntity = { [E in DetailEntity]: z.output<(typeof ENTITY_DETAIL_OUTPUT_SCHEMAS)[E]> };\n" +
        "export type EntityDetailInputByEntity = { [E in DetailEntity]: Extract<EntityDetailInput, { entity: E }> };\n" +
        "export type ParsedEntityDetailInputByEntity = { [E in DetailEntity]: Extract<ParsedEntityDetailInput, { entity: E }> };\n\n" +
        'export function entityDetailInputFor<E extends DetailEntity>(entity: E, shortcode: EntityDetailInputByEntity[E]["shortcode"]): EntityDetailInputByEntity[E];\n' +
        'export function entityDetailInputFor(entity: DetailEntity, shortcode: EntityDetailInputByEntity[DetailEntity]["shortcode"]) {\n' +
        "  return { entity, shortcode };\n" +
        "}\n\n" +
        "export function parseEntityDetailInput<E extends DetailEntity>(entity: E, value: EntityDetailInputByEntity[E]): ParsedEntityDetailInputByEntity[E];\n" +
        "export function parseEntityDetailInput(entity: DetailEntity, value: EntityDetailInputByEntity[DetailEntity]) {\n" +
        "  const parsed = entityDetailInputSchema.parse(value);\n" +
        '  if (parsed.entity !== entity) throw new Error("Entity detail input discriminator mismatch");\n' +
        "  return parsed;\n" +
        "}\n\n" +
        "export function getEntityDetailOutputSchema<E extends DetailEntity>(entity: E): z.ZodType<EntityDetailByEntity[E]>;\n" +
        "export function getEntityDetailOutputSchema(entity: DetailEntity): z.ZodType {\n" +
        "  return ENTITY_DETAIL_OUTPUT_SCHEMAS[entity];\n" +
        "}\n",
    },
    {
      relativePath: "apps/web/src/entities/generated/entity-lists.gen.ts",
      source:
        generatedHeader +
        "// Generated schema aliases retain deterministic import order.\n" +
        `${listRuntimeOutputImports}\n${listFilterFieldImports}\n` +
        'import { withEntityListMedia } from "@cubby/schemas/entity-read-media";\n' +
        'import { MAX_PAGE_SIZE, MAX_SORTS, paginatedMetaSchema } from "@cubby/schemas/pagination";\n' +
        'import type { FilterPatch } from "../filters";\n' +
        'import { z } from "zod";\n\n' +
        `export const listEntities = ${compactLiteral(browserCrudEntities)} as const;\n` +
        "export type ListEntity = (typeof listEntities)[number];\n\n" +
        'const entityListSortSchema = z.object({ orderBy: z.string().min(1), direction: z.enum(["asc", "desc"]) });\n' +
        "const entityListSortsSchema = z.union([entityListSortSchema, z.array(entityListSortSchema).min(1).max(MAX_SORTS)]);\n" +
        "const entityListPaginationSchema = z.object({ pageIndex: z.number().int().min(0), pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE) });\n" +
        "// The one page-metadata schema every list shares (one OpenAPI component).\nconst entityListMetaSchema = paginatedMetaSchema;\n\n" +
        `${listFilterSchemas}\n\n` +
        "// One generated filter schema per list entity.\n// oxfmt-ignore\n" +
        `const ENTITY_LIST_FILTER_SCHEMAS = {\n${listFilterSchemaBindings}\n} as const;\n\n` +
        `export const entityListInputSchema = z.discriminatedUnion("entity", [\n  ${listInputVariants}\n]);\n\n` +
        `${listItemSchemas}\n\n` +
        "const ENTITY_LIST_OUTPUT_SCHEMAS = {\n" +
        `${listOutputSchemas}\n` +
        "} as const;\n\n" +
        "type EntityListInputFiltersByEntity = { [E in ListEntity]: z.input<(typeof ENTITY_LIST_FILTER_SCHEMAS)[E]> };\n" +
        "type EntityListParsedFiltersByEntity = { [E in ListEntity]: z.output<(typeof ENTITY_LIST_FILTER_SCHEMAS)[E]> };\n" +
        "type EntityListSort = z.input<typeof entityListSortSchema>;\n" +
        "export type EntityListInputByEntity = {\n" +
        "  [E in ListEntity]: { entity: E; filters: EntityListInputFiltersByEntity[E]; sort?: EntityListSort | EntityListSort[]; pagination?: { pageIndex: number; pageSize: number }; groupBy?: string };\n" +
        "};\n" +
        "export type ParsedEntityListInputByEntity = {\n" +
        '  [E in ListEntity]: Omit<EntityListInputByEntity[E], "filters"> & { filters: EntityListParsedFiltersByEntity[E] };\n' +
        "};\n\n" +
        'export type EntityListParamsByEntity = { [E in ListEntity]: Omit<EntityListInputByEntity[E], "entity"> };\n' +
        "export function entityListInputFor<E extends ListEntity>(entity: E, input: EntityListParamsByEntity[E]): EntityListInputByEntity[E];\n" +
        "export function entityListInputFor(entity: ListEntity, input: EntityListParamsByEntity[ListEntity]) {\n" +
        "  return { entity, ...input };\n" +
        "}\n\n" +
        "export function entityListParamsFromParsed<E extends ListEntity>(entity: E, input: ParsedEntityListInputByEntity[E]): EntityListParamsByEntity[E];\n" +
        "export function entityListParamsFromParsed(entity: ListEntity, input: ParsedEntityListInputByEntity[ListEntity]) {\n" +
        '  if (input.entity !== entity) throw new Error("Entity list input discriminator mismatch");\n' +
        "  const { entity: _entity, ...params } = input;\n" +
        "  return params;\n" +
        "}\n\n" +
        "export type EntityListParseInput = EntityListInputByEntity[ListEntity] | { entity: ListEntity; filters: FilterPatch; sort?: EntityListSort | EntityListSort[]; pagination?: { pageIndex: number; pageSize: number }; groupBy?: string };\n\n" +
        "export type EntityListResultByEntity = {\n" +
        "  [E in ListEntity]: z.output<(typeof ENTITY_LIST_OUTPUT_SCHEMAS)[E]>;\n" +
        "};\n\n" +
        "export function parseEntityListInput<E extends ListEntity>(entity: E, value: EntityListInputByEntity[E] | EntityListParseInput): ParsedEntityListInputByEntity[E];\n" +
        "export function parseEntityListInput(entity: ListEntity, value: EntityListParseInput) {\n" +
        "  const parsed = entityListInputSchema.parse(value);\n" +
        '  if (parsed.entity !== entity) throw new Error("Entity list input discriminator mismatch");\n' +
        "  return parsed;\n" +
        "}\n\n" +
        "export function getEntityListOutputSchema<E extends ListEntity>(entity: E): z.ZodType<EntityListResultByEntity[E]>;\n" +
        "export function getEntityListOutputSchema(entity: ListEntity): z.ZodType {\n" +
        "  return ENTITY_LIST_OUTPUT_SCHEMAS[entity];\n" +
        "}\n",
    },
    {
      relativePath:
        "apps/web/src/entities/generated/entity-mutation-results.gen.ts",
      source:
        generatedHeader +
        `${mutationOutputImports}\n` +
        'import type { z } from "zod";\n\n' +
        `export const entityMutationOutputEntities = ${compactLiteral(browserCrudEntities)} as const;\n` +
        "export type EntityMutationOutputEntity = (typeof entityMutationOutputEntities)[number];\n\n" +
        "export type EntityMutationOutputByEntity = {\n" +
        `${mutationOutputTypes}\n` +
        "};\n\n" +
        "// One generated mutation output schema per entity.\n// oxfmt-ignore\n" +
        `const ENTITY_MUTATION_OUTPUT_SCHEMAS = {\n${mutationOutputSchemas}\n} as const;\n\n` +
        'type UnparsedMutationOutput = Parameters<z.ZodType["parse"]>[0];\n' +
        "type EntityMutationOutput = EntityMutationOutputByEntity[EntityMutationOutputEntity];\n\n" +
        "export function parseEntityMutationOutput<E extends EntityMutationOutputEntity>(entity: E, value: UnparsedMutationOutput): EntityMutationOutputByEntity[E];\n" +
        "export function parseEntityMutationOutput(entity: EntityMutationOutputEntity, value: UnparsedMutationOutput): EntityMutationOutput {\n" +
        "  return ENTITY_MUTATION_OUTPUT_SCHEMAS[entity].parse(value);\n" +
        "}\n",
    },
    {
      relativePath:
        "apps/web/src/entities/generated/entity-filter-fields.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n' +
        'import type { z } from "zod";\n' +
        `${filterFieldImportSource}\n\n` +
        "// Generated filter field assembly stays one entity per line.\n// oxfmt-ignore\n" +
        `export const entityFilterFieldMaps = {\n${filterFieldBindings}\n} satisfies Partial<Record<Entity, Record<string, z.ZodType>>>;\n`,
    },
    {
      relativePath: "apps/web/src/lib/generated/http-resources.gen.ts",
      source:
        generatedHeader +
        "/** HTTP resource verbs per entity; consumed by the start-operation registry generator. */\n" +
        "// oxfmt-ignore\n" +
        `export const HTTP_RESOURCES = {\n${httpResources}\n} as const satisfies Record<string, { basePath: string; verbs: readonly ("list" | "timeline" | "get" | "create" | "update" | "delete")[] }>;\n`,
    },
    ...renderSwiftEntityCatalog(entities, kernelContractCases),
    {
      relativePath: "apps/web/src/server/generated/entity-bindings.gen.ts",
      source:
        generatedHeader +
        'import { mutationSideEffectsSchema } from "@cubby/schemas/background-jobs";\n' +
        'import { withEntityDetailMedia, withEntityListMedia } from "@cubby/schemas/entity-read-media";\n' +
        'import { MAX_PAGE_SIZE } from "@cubby/schemas/pagination";\n' +
        'import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";\n' +
        `${schemaImports}\n` +
        'import { z } from "zod";\n\n' +
        "const entitySchema = <\n" +
        "  const E extends ShortcodeEntity,\n" +
        "  SFilters extends z.ZodType,\n" +
        "  SCreate extends z.ZodType | null,\n" +
        "  SUpdate extends z.ZodType | null,\n" +
        "  SBulkUpdate extends z.ZodType | null,\n" +
        "  SOutput extends z.ZodType,\n" +
        "  SDetail extends z.ZodType,\n" +
        "  SList extends z.ZodType,\n" +
        "  SMcpOutput extends z.ZodType,\n" +
        "  SMcpDetail extends z.ZodType,\n" +
        "  SMcpList extends z.ZodType,\n" +
        ">(\n" +
        "  entity: E,\n" +
        "  schemas: {\n" +
        "    filters: SFilters;\n" +
        "    createInput: SCreate;\n" +
        "    updateInput: SUpdate;\n" +
        "    bulkUpdateInput: SBulkUpdate;\n" +
        "    output: SOutput;\n" +
        "    detail: SDetail;\n" +
        "    list: SList;\n" +
        "    mcpOutput: SMcpOutput;\n" +
        "    mcpDetail: SMcpDetail;\n" +
        "    mcpList: SMcpList;\n" +
        "  },\n" +
        ") => ({\n" +
        "  entity,\n" +
        "  id: shortcodeSchema(entity),\n" +
        "  ...schemas,\n" +
        "  repositoryDetail: schemas.detail,\n" +
        "  repositoryList: schemas.list,\n" +
        "  detail: withEntityDetailMedia(schemas.detail),\n" +
        "  list: withEntityListMedia(schemas.list),\n" +
        "  mcpDetail: withEntityDetailMedia(schemas.mcpDetail),\n" +
        "  mcpList: withEntityListMedia(schemas.mcpList),\n" +
        "});\n\n" +
        "// Generated schema correlations stay one entity per line.\n// oxfmt-ignore\n" +
        `export const ENTITY_SCHEMA_BINDINGS = {\n${schemaBindings}\n} as const;\n` +
        "export type EntitySchemaBindingMap = typeof ENTITY_SCHEMA_BINDINGS;\n" +
        "export type EntitySchemaBindingEntity = keyof EntitySchemaBindingMap;\n" +
        "type EntitySchemaBinding = EntitySchemaBindingMap[EntitySchemaBindingEntity];\n" +
        "type EntityBinding = { crud: EntitySchemaBinding | null };\n\n" +
        "// Generated bindings stay one entity per line.\n// oxfmt-ignore\n" +
        `export const ENTITY_BINDINGS = {\n${bindings}\n} satisfies Record<ShortcodeEntity, EntityBinding>;\n\n` +
        "// One generated variant per entity.\n// oxfmt-ignore\n" +
        `export const generatedEntityCreateCommandSchema = z.union([\n  ${commandVariants("create", "create")}\n]);\n\n` +
        "// One generated variant per entity.\n// oxfmt-ignore\n" +
        `export const generatedEntityUpdateCommandSchema = z.union([\n  ${commandVariants("update", "update")}\n]);\n\n` +
        "// MCP command variants are filtered by each literal's declared exposure.\n" +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityCreateCommandSchema = z.union([\n  ${commandVariants("create", "create", "mcp")}\n]);\n\n` +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityUpdateCommandSchema = z.union([\n  ${commandVariants("update", "update", "mcp")}\n]);\n\n` +
        "/** The kernel owns the shared 1-500 unique-id bound, so it injects `ids`. */\n" +
        "// One generated variant per bulk-updatable entity.\n// oxfmt-ignore\n" +
        `export const generatedEntityBulkUpdateCommandSchema = ${bulkUpdateCommandFactory};\n` +
        `export const generatedMcpEntityBulkUpdateCommandSchema = ${mcpBulkUpdateCommandFactory};\n` +
        "\n" +
        `export const generatedEntityMutationCreateResultSchema = z.discriminatedUnion("entity", [\n  ${mutationResultVariants("create")}\n]);\n\n` +
        `export const generatedEntityMutationUpdateResultSchema = z.discriminatedUnion("entity", [\n  ${mutationResultVariants("update")}\n]);\n` +
        "\nconst generatedEntityListMetaSchema = z.object({\n" +
        "  pageIndex: z.number().int().nonnegative(),\n" +
        "  pageSize: z.number().int().positive().max(MAX_PAGE_SIZE),\n" +
        "  totalCount: z.number().int().nonnegative(),\n" +
        "  sums: z.record(z.string(), z.number()).optional(),\n" +
        "});\n\n" +
        "// One generated query result per correlated entity output.\n// oxfmt-ignore\n" +
        `export const generatedEntityGetResultSchema = z.discriminatedUnion("entity", [\n  ${queryGetResultVariants}\n]);\n\n` +
        "// One generated query result per correlated entity output.\n// oxfmt-ignore\n" +
        `export const generatedEntityListResultSchema = z.discriminatedUnion("entity", [\n  ${queryListResultVariants}\n]);\n` +
        "\n// Merge summaries are workflow-specific JSON; the surviving item remains entity-correlated.\n// oxfmt-ignore\n" +
        `export const generatedEntityMergeResultSchema = z.discriminatedUnion("entity", [\n  ${mergeResultVariants}\n]);\n` +
        "\n// MCP variants preserve entity correlation while projecting storage-only child ids.\n// oxfmt-ignore\n" +
        `export const generatedMcpEntityGetResultSchema = z.discriminatedUnion("entity", [\n  ${mcpQueryGetResultVariants}\n]);\n\n` +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityListResultSchema = z.discriminatedUnion("entity", [\n  ${mcpQueryListResultVariants}\n]);\n\n` +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityMutationCreateResultSchema = z.discriminatedUnion("entity", [\n  ${mcpMutationResultVariants("create")}\n]);\n\n` +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityMutationUpdateResultSchema = z.discriminatedUnion("entity", [\n  ${mcpMutationResultVariants("update")}\n]);\n\n` +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityMergeResultSchema = z.discriminatedUnion("entity", [\n  ${mcpMergeResultVariants}\n]);\n`,
    },
    {
      relativePath: "apps/web/src/entities/generated/entity-routes.gen.ts",
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
        `export const generatedMergeEntityKernelEntities = ${compactLiteral(entitiesForAction("merge"))} as const;\n`,
    },
    {
      relativePath:
        "apps/web/src/server/repo/generated/shortcode-tables.gen.ts",
      source:
        generatedHeader +
        "// Generated table imports stay one entity per line.\n// oxfmt-ignore\n" +
        `import {\n${shortcodeTableImportNames.map((name) => `  ${name},`).join("\n")}\n} from "~/server/db/schema";\n\n` +
        "// Generated table bindings stay one entity per line.\n// oxfmt-ignore\n" +
        `export const SHORTCODE_TABLE = {\n${shortcodeTableBindings}\n} as const;\n`,
    },
  ];
};
