import {
  entityFieldControlKinds as fieldControlKinds,
  entityFieldKinds as fieldKinds,
} from "../../../packages/schemas/src/entity-definitions/definition.ts";
import { compactLiteral, generatedHeader } from "../artifacts.ts";
import {
  EntityDeclarationError,
  declarationModules,
  stringValue,
} from "../declarations.ts";
import type {
  CompiledEntity,
  EntityArtifacts,
  RelationMutation,
  SourceRef,
} from "../declarations.ts";
import { renderEntityColumnsArtifact } from "./columns.ts";
import { browserRoutes, lowerCamelCase } from "./routes.ts";

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

// One render pass preserves deterministic cross-artifact ordering and hashes.
// oxlint-disable-next-line eslint/complexity
export const renderEntityArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const projections = entityProjectionMaps(entities);
  const relationMutations = entities.flatMap(
    (entity) => entity.relationMutations,
  );
  const relationMutationKeys = relationMutations.map(
    ({ entity, relation }) => `${entity}:${relation}`,
  );
  if (new Set(relationMutationKeys).size !== relationMutationKeys.length) {
    throw new EntityDeclarationError("Relation mutation keys must be unique.");
  }
  const relationSchemaImports = [
    ...new Map(
      relationMutations.map(({ itemSchema }) => [
        `${itemSchema.module}#${itemSchema.export}`,
        itemSchema,
      ]),
    ).values(),
  ]
    .sort((left, right) =>
      `${left.module}#${left.export}`.localeCompare(
        `${right.module}#${right.export}`,
      ),
    )
    .map(
      ({ module, export: exportName }) =>
        `import { ${exportName} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const relationCommandVariant = ({
    entity,
    relation,
    target,
    itemSchema,
  }: RelationMutation) =>
    `z.object({action:z.enum(["attach","detach"]),entity:z.literal(${JSON.stringify(entity)}),relation:z.literal(${JSON.stringify(relation)}),id:shortcodeSchema(${JSON.stringify(entity)}),items:z.array(${itemSchema.export}.extend({id:shortcodeSchema(${JSON.stringify(target)})})).min(1).max(500)}).strict()`;
  const relationCommandSchema = (
    audience: "browser" | "mcp" | null,
  ): string => {
    const mutations =
      audience === null
        ? relationMutations
        : relationMutations.filter(({ audiences }) =>
            audiences.includes(audience),
          );
    return mutations.length === 0
      ? "z.never()"
      : `z.union([\n  ${mutations.map(relationCommandVariant).join(",\n  ")}\n])`;
  };
  const relationResultSchema =
    relationMutations.length === 0
      ? "z.never()"
      : `z.union([\n  ${relationMutations
          .map(
            ({ entity, relation }) =>
              `z.object({action:z.enum(["attach","detach"]),entity:z.literal(${JSON.stringify(entity)}),relation:z.literal(${JSON.stringify(relation)}),result:relationMutationOut})`,
          )
          .join(",\n  ")}\n])`;
  const mcpRelationMutations = relationMutations.filter(({ audiences }) =>
    audiences.includes("mcp"),
  );
  const mcpParentIdSchemas = [
    ...new Set(
      mcpRelationMutations.map(
        ({ entity }) => `shortcodeSchema(${JSON.stringify(entity)})`,
      ),
    ),
  ];
  const mcpItemSchemas = [
    ...new Set(
      mcpRelationMutations.map(
        ({ itemSchema, target }) =>
          `${itemSchema.export}.extend({id:shortcodeSchema(${JSON.stringify(target)})})`,
      ),
    ),
  ];
  const schemaUnion = (schemas: readonly string[]) =>
    schemas.length === 1 ? schemas[0] : `z.union([${schemas.join(",")}])`;
  const mcpPreviewInputSchema =
    mcpRelationMutations.length === 0
      ? "z.never()"
      : `z.object({action:z.enum(["attach","detach"]),entity:z.enum(${compactLiteral([...new Set(mcpRelationMutations.map(({ entity }) => entity))])}),relation:z.enum(${compactLiteral([...new Set(mcpRelationMutations.map(({ relation }) => relation))])}),id:${schemaUnion(mcpParentIdSchemas)},items:z.array(${schemaUnion(mcpItemSchemas)}).min(1).max(500)}).strict().superRefine((input,ctx)=>{const result=generatedMcpEntityRelationCommandSchema.safeParse(input);if(!result.success){for(const issue of result.error.issues)ctx.addIssue({code:"custom",path:issue.path,message:issue.message});}})`;
  const relationAdapterImports = [
    ...new Map(
      relationMutations.map(({ adapter }) => [
        `${adapter.module}#${adapter.export}`,
        adapter,
      ]),
    ).values(),
  ]
    .sort((left, right) =>
      `${left.module}#${left.export}`.localeCompare(
        `${right.module}#${right.export}`,
      ),
    )
    .map(
      ({ module, export: exportName }) =>
        `import { ${exportName} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const relationRuntimeCases = relationMutations
    .map(
      ({ entity, relation, adapter }) =>
        `    case ${JSON.stringify(`${entity}:${relation}`)}: {\n      const result = await ${adapter.export}.execute(ctx,command.action,command.id,command.items);\n      return {action:command.action,entity:${JSON.stringify(entity)},relation:${JSON.stringify(relation)},result};\n    }`,
    )
    .join("\n");
  const relationTargetCases = relationMutations
    .map(
      ({ entity, relation, target }) =>
        `    case ${JSON.stringify(`${entity}:${relation}`)}: return ${JSON.stringify(target)};`,
    )
    .join("\n");
  const relationPreviewCases = relationMutations
    .map(
      ({ entity, relation, adapter }) =>
        `    case ${JSON.stringify(`${entity}:${relation}`)}: return ${adapter.export}.preview(db,command.action,ownerId,targetIds);`,
    )
    .join("\n");
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
        `  ${JSON.stringify(key)}: ${contract.detail.export},`,
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
    .map(({ key, filterSchema }) =>
      filterSchema === null
        ? `const ${key}ListFiltersSchema = z.record(z.string(), z.unknown());`
        : `const ${key}ListFiltersSchema = z.object(${key}ListFilterFields);`,
    )
    .join("\n");
  const listFilterSchemaBindings = browserCrudEntitySpecs
    .map(({ key }) => `  ${JSON.stringify(key)}: ${key}ListFiltersSchema,`)
    .join("\n");
  const listOutputSchemas = browserCrudEntitySpecs
    .map(
      ({ key }) =>
        `  ${JSON.stringify(key)}: z.object({items:z.array(${key}ListOutputSchema),meta:entityListMetaSchema}),`,
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
        `z.object({action:z.literal("get"),entity:z.literal(${JSON.stringify(key)}),item:${contract.detail.export}.nullable()})`,
    )
    .join(",\n  ");
  const queryListResultVariants = schemaEntitySpecs
    .map(
      ({ key, contract }) =>
        `z.object({action:z.literal("list"),entity:z.literal(${JSON.stringify(key)}),items:z.array(${contract.list.export}),meta:generatedEntityListMetaSchema})`,
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
        `z.object({action:z.literal("get"),entity:z.literal(${JSON.stringify(key)}),item:${contract.mcpDetail.export}.nullable()})`,
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
        `z.object({action:z.literal("list"),entity:z.literal(${JSON.stringify(key)}),items:z.array(${contract.mcpList.export}),meta:generatedEntityListMetaSchema})`,
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
  const kernelEntities = entities.filter(
    ({ contract, key, ports }) =>
      (contract !== null && ports.repository !== null) || key === "image",
  );
  const kernelEntityKeys = kernelEntities.map(({ key }) => key);
  const runtimeAdapterImports = new Map<string, Set<string>>();
  for (const entity of kernelEntities) {
    const adapter = entity.ports.repository;
    if (adapter === null) {
      throw new EntityDeclarationError(
        `${entity.key}.ports.repository is required for a kernel entity.`,
      );
    }
    const exports =
      runtimeAdapterImports.get(adapter.module) ?? new Set<string>();
    exports.add(adapter.export);
    runtimeAdapterImports.set(adapter.module, exports);
  }
  const runtimeAdapterImportSource = [...runtimeAdapterImports.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([module, exports]) =>
        `import { ${[...exports].sort().join(", ")} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const runtimeBindings = kernelEntities
    .map(
      ({ key, ports }) =>
        `  ${JSON.stringify(key)}: ${ports.repository?.export},`,
    )
    .join("\n");
  const runtimeOperations = kernelEntities
    .map(
      ({ key, ports }) =>
        `  ${JSON.stringify(key)}: defineEntityOperations(${ports.repository?.export}),`,
    )
    .join("\n");
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
  const httpResources = kernelEntities
    .flatMap((entity) => {
      if (!entity.route || !entity.contract) return [];
      const key = JSON.stringify(entity.key);
      const path = `/api/v1/${entity.route.basePath}`;
      const binding = `ENTITY_SCHEMA_BINDINGS[${key}]`;
      const metadata = (mode: string, operation = "entity.mutate") =>
        JSON.stringify({ entity: entity.key, operation, mode });
      const routes: string[] = [];
      const listIndex = browserCrudEntitySpecs.findIndex(
        (candidate) => candidate.key === entity.key,
      );
      if (listIndex >= 0)
        routes.push(
          `list: httpGet(${JSON.stringify(path)}, resourceListQuerySchema(entityListInputSchema.options[${listIndex}].shape.filters), getEntityListOutputSchema(${key}), ${metadata("list", "entity.list")})`,
        );
      if (detailEntities.some((candidate) => candidate.key === entity.key))
        routes.push(
          `get: httpItem(httpGet(${JSON.stringify(path + "/:id")}, z.strictObject({}), getEntityDetailOutputSchema(${key}), ${metadata("detail", "entity.detail")}), ${binding}.id)`,
        );
      if (entity.contract.create)
        routes.push(
          `create: httpCreate( ${JSON.stringify(path)}, ${binding}.createInput, generatedEntityMutationCreateResultSchema.options[${entities.filter((candidate) => candidate.contract?.create).findIndex((candidate) => candidate.key === entity.key)}], ${metadata("create")})`,
        );
      if (entity.contract.update)
        routes.push(
          `update: httpItem(httpWrite("PATCH", ${JSON.stringify(path + "/:id")}, ${binding}.updateInput, generatedEntityMutationUpdateResultSchema.options[${entities.filter((candidate) => candidate.contract?.update).findIndex((candidate) => candidate.key === entity.key)} ], ${metadata("update")}), ${binding}.id)`,
        );
      if (entity.operationOwners.delete === "kernel")
        routes.push(
          `delete: httpItem(httpDelete(${JSON.stringify(path + "/:id")}, entityDeleteResultSchema, ${metadata("delete")}), ${binding}.id)`,
        );
      return [`${key}: {${routes.join(",\n")}}`];
    })
    .join(",\n");
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
  const legacyShortcodePrefixes = Object.fromEntries(
    entities.flatMap(({ key, legacyShortcode }) =>
      legacyShortcode === null ? [] : [[legacyShortcode, key]],
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
          singular: entity.inspector.singular,
          plural: entity.inspector.plural,
          titleField: entity.inspector.titleField,
          shortcodePrefix: entity.shortcode,
          legacyShortcodePrefix: entity.legacyShortcode,
          searchable: entity.descriptor.searchable === true,
          browserRouted: entity.descriptor.browserRoutes !== false,
          auditable: entity.descriptor.auditable === true,
          hasImages: entity.descriptor.hasImages === true,
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
    entities.map(({ key, fieldModel }) => [
      key,
      {
        ...fieldModel,
        fields: fieldModel.fields.map(
          ({ validation: _validation, ...field }) => field,
        ),
      },
    ]),
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
    const schemaMap = (
      mode: "create" | "update" | "read",
      keys: readonly string[],
    ) =>
      `{${keys
        .map((key) => {
          const index = fieldModel.fields.findIndex(
            (field) => field.key === key,
          );
          const field = fieldByKey(entity, key);
          return `${JSON.stringify(mode === "read" ? (field.readKey ?? key) : key)}:definition.model.fields[${index}].validation.${mode}`;
        })
        .join(",")}}`;
    const prefix = `generated${entity.inspector.singular.replaceAll(" ", "")}`;
    return [
      {
        relativePath: `packages/schemas/src/generated/entity-field-schemas.${entity.key}.gen.ts`,
        source:
          generatedHeader +
          `import definition${declaration.hasFilters ? ", {filterSchemas}" : ""} from ${JSON.stringify(declaration.path)};\n` +
          (declaration.enumExports.length
            ? `export {${declaration.enumExports.join(",")}} from ${JSON.stringify(declaration.path)};\n`
            : "") +
          `export const ${prefix}FieldSchemas = {create:${schemaMap("create", fieldModel.create)},update:${schemaMap("update", fieldModel.update)},read:${schemaMap("read", fieldModel.output)}} as const;\n` +
          (declaration.hasFilters
            ? `export const ${prefix}FilterFields = filterSchemas;\n`
            : ""),
      },
    ];
  });
  const portExportChecks = [
    ...new Map(
      entities.flatMap((entity) => {
        const { ports } = entity;
        const refs = [
          ports.repository,
          ports.references.label,
          ports.references.resolver,
          ports.filters,
          ports.search.projection,
          ports.search.semanticText,
          ports.search.dependentRefresh,
          ...entity.relationMutations.flatMap(({ itemSchema, adapter }) => [
            itemSchema,
            adapter,
          ]),
          ...entity.filterDescriptors.flatMap((descriptor) => [
            descriptor.optionsRef,
            descriptor.expandRef,
          ]),
        ].filter((ref): ref is SourceRef => ref !== null);
        return refs.map((ref) => [`${ref.module}#${ref.export}`, ref] as const);
      }),
    ).values(),
  ].sort((left, right) =>
    `${left.module}#${left.export}`.localeCompare(
      `${right.module}#${right.export}`,
    ),
  );
  const portTypeModuleAliases = new Map(
    [...new Set(portExportChecks.map((ref) => ref.module))]
      .sort((left, right) => left.localeCompare(right))
      .map((module, index) => [module, `entityPortModule${index}`]),
  );
  const portTypeImports = [...portTypeModuleAliases.entries()]
    .map(
      ([module, alias]) =>
        `import type * as ${alias} from ${JSON.stringify(module)};`,
    )
    .join("\n");
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
    {
      relativePath: "packages/shared/src/generated/shortcode-registry.gen.ts",
      source:
        generatedHeader +
        "// Generated shortcode registry stays one entity per line.\n// oxfmt-ignore\n" +
        `export const SHORTCODE_PREFIX = ${compactLiteral(shortcodePrefixes)} as const;\n` +
        "export type ShortcodeType = keyof typeof SHORTCODE_PREFIX;\n\n" +
        "/** Inbound-only aliases; canonical generation never emits these prefixes. */\n" +
        "// Generated legacy aliases stay compact.\n// oxfmt-ignore\n" +
        `export const LEGACY_SHORTCODE_PREFIX = ${compactLiteral(legacyShortcodePrefixes)} as const satisfies Record<string, ShortcodeType>;\n`,
    },
    {
      relativePath:
        "packages/schemas/src/generated/entity-manifest-data.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "../entity";\n' +
        'import type { EntityDescriptor } from "../entity-manifest";\n\n' +
        "// Generated data stays one entity per line.\n// oxfmt-ignore\n" +
        `export const generatedEntityManifest = ${compactLiteral(
          Object.fromEntries(
            entities.map(({ key, descriptor }) => [key, descriptor]),
          ),
        )} as const satisfies Record<Entity, EntityDescriptor>;\n`,
    },
    {
      relativePath: "packages/schemas/src/generated/entity-names.gen.ts",
      source:
        generatedHeader +
        // `entity-core` rather than `entity`: this artifact is imported by
        // `identifiers.ts`, and `entity.ts` reaches back into the (much
        // larger) manifest module.
        'import type { Entity } from "../entity-core";\n\n' +
        "/**\n" +
        " * Display names for one entity, exactly as its literal declares them.\n" +
        " *\n" +
        " * `singular` is Title Case and names ONE record; `plural` is the\n" +
        " * nav/section name, which is not a pluralization of the singular (see the\n" +
        " * `names` block in `packages/schemas/src/entity-definitions/*.entity.ts`). It is\n" +
        " * `null` for the entities that have no browser route to name a section of.\n" +
        " *\n" +
        " * Deliberately its own artifact rather than a field read off\n" +
        " * `entityInspectorMetadata`: these strings are needed by eagerly-loaded\n" +
        " * client code (the entity registry, `identifiers.ts`), and the inspector\n" +
        " * artifact is two orders of magnitude larger.\n" +
        " */\n" +
        "export type EntityNames = { singular: string; plural: string | null };\n\n" +
        "// Generated names stay one entity per line.\n// oxfmt-ignore\n" +
        `export const entityNames = ${compactLiteral(
          Object.fromEntries(
            entities.map(({ key, inspector }) => [
              key,
              { singular: inspector.singular, plural: inspector.plural },
            ]),
          ),
        )} as const satisfies Record<Entity, EntityNames>;\n`,
    },
    {
      relativePath: "packages/schemas/src/generated/entity-field-model.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "../entity-core";\n\n' +
        `export type GeneratedEntityFieldKind = ${fieldKinds.map((kind) => JSON.stringify(kind)).join(" | ")};\n` +
        `export type GeneratedEntityFieldControlKind = ${fieldControlKinds.map((kind) => JSON.stringify(kind)).join(" | ")};\n\n` +
        "export type GeneratedEntityFieldModel = {\n" +
        '  fields: readonly { key: string; kind: GeneratedEntityFieldKind; nullable: boolean; label: string; description: string | null; readKey: string | null; reference: { entity: string; multiple: boolean } | null; control: { kind: GeneratedEntityFieldControlKind; renderer: string | null; options: readonly { value: string; label: string }[] | null; section: string } | null; display: { list: boolean; detail: boolean; columnId: string | null; standard: "name" | "image" | null; detailOrder: number | null; detailSection: string } }[];\n' +
        '  storage: readonly { key: string; column: string; kind: GeneratedEntityFieldKind; nullable: boolean; default: "none" | "generated" | "now" | "literal"; defaultValue: unknown; reference: string | null; specialized: string | null }[];\n' +
        "  create: readonly string[];\n" +
        "  update: readonly string[];\n" +
        "  bulk: readonly string[];\n" +
        "  audit: readonly string[];\n" +
        "  output: readonly string[];\n" +
        "};\n\n" +
        "// One authoritative field model per compiled entity.\n// oxfmt-ignore\n" +
        `export const generatedEntityFieldModels = ${compactLiteral(fieldModels)} as const satisfies Record<Entity, GeneratedEntityFieldModel>;\n`,
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
        "export type EntityInspectorMetadata = {\n" +
        "  singular: string;\n" +
        "  plural: string | null;\n" +
        "  titleField: string;\n" +
        "  shortcodePrefix: string | null;\n" +
        "  legacyShortcodePrefix: string | null;\n" +
        "  searchable: boolean;\n" +
        "  browserRouted: boolean;\n" +
        "  auditable: boolean;\n" +
        "  hasImages: boolean;\n" +
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
        '  label: string | null; schemaDescription: string | null; deriveSchema: boolean; schemaFromRead: boolean; brandRef: { entity: string; kind: "id" | "shortcode" } | null; expandRef: EntityPortSourceRef | null;\n' +
        "  urlOnly: boolean; nullable: { field: string; label: string } | null;\n" +
        "};\n" +
        "type EntityPortSourceRoster = {\n" +
        "  repository: EntityPortSourceRef | null;\n" +
        "  references: { label: EntityPortSourceRef | null; resolver: EntityPortSourceRef | null };\n" +
        "  filters: EntityPortSourceRef | null;\n" +
        "  search: { projection: EntityPortSourceRef | null; semanticText: EntityPortSourceRef | null; dependentRefresh: EntityPortSourceRef | null };\n" +
        "};\n\n" +
        "// Generated inspector metadata stays one entity per line.\n// oxfmt-ignore\n" +
        `export const entityInspectorMetadata = ${compactLiteral(inspectorMetadata)} as const satisfies Record<Entity, EntityInspectorMetadata>;\n`,
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
        'import { MAX_PAGE_SIZE, MAX_SORTS } from "@cubby/schemas/pagination";\n' +
        'import type { FilterPatch } from "../filters";\n' +
        'import { z } from "zod";\n\n' +
        `export const listEntities = ${compactLiteral(browserCrudEntities)} as const;\n` +
        "export type ListEntity = (typeof listEntities)[number];\n\n" +
        'const entityListSortSchema = z.object({ orderBy: z.string().min(1), direction: z.enum(["asc", "desc"]) });\n' +
        "const entityListSortsSchema = z.union([entityListSortSchema, z.array(entityListSortSchema).min(1).max(MAX_SORTS)]);\n" +
        "const entityListPaginationSchema = z.object({ pageIndex: z.number().int().min(0), pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE) });\n" +
        "const entityListMetaSchema = z.object({ pageIndex: z.number().int().min(0), pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE), totalCount: z.number().int().min(0), sums: z.record(z.string(), z.number()).optional() });\n\n" +
        `${listFilterSchemas}\n\n` +
        "// One generated filter schema per list entity.\n// oxfmt-ignore\n" +
        `const ENTITY_LIST_FILTER_SCHEMAS = {\n${listFilterSchemaBindings}\n} as const;\n\n` +
        `export const entityListInputSchema = z.discriminatedUnion("entity", [\n  ${listInputVariants}\n]);\n\n` +
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
        'import { z } from "zod";\n' +
        'import { ENTITY_SCHEMA_BINDINGS, generatedEntityMutationCreateResultSchema, generatedEntityMutationUpdateResultSchema } from "~/server/generated/entity-bindings.gen";\n' +
        'import { resourceListQuerySchema } from "~/lib/http-api/resource-query";\n' +
        'import { entityDeleteResultSchema } from "~/server/entity-kernel/contracts";\n' +
        'import { entityListInputSchema, getEntityListOutputSchema } from "~/entities/generated/entity-lists.gen";\n' +
        'import { getEntityDetailOutputSchema } from "~/entities/generated/entity-details.gen";\n' +
        'import { httpGet, httpWrite, httpItem, httpDelete, httpCreate } from "~/lib/http-api/contract";\n' +
        `export const httpResources = {${httpResources}} as const;\n`,
    },
    {
      relativePath: "apps/web/src/server/generated/entity-bindings.gen.ts",
      source:
        generatedHeader +
        'import { mutationSideEffectsSchema } from "@cubby/schemas/background-jobs";\n' +
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
        ") => ({ entity, id: shortcodeSchema(entity), ...schemas });\n\n" +
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
        "// Generated routes stay one entity per line.\n// oxfmt-ignore\n" +
        `export const generatedBrowserRoutes = ${compactLiteral(
          Object.fromEntries(
            projections.routes.map((entity) => [
              entity.key,
              browserRoutes(entity),
            ]),
          ),
        )} as const satisfies Partial<Record<Entity, { basePath: string; routes: { detail: string; list: string } }>>;\n\n` +
        "// Generated entity roster stays one line.\n// oxfmt-ignore\n" +
        `export const generatedBrowserCrudEntities = ${compactLiteral(browserCrudEntities)} as const;\n` +
        "export type GeneratedBrowserCrudEntity = (typeof generatedBrowserCrudEntities)[number];\n",
    },
    {
      relativePath:
        "apps/web/src/server/generated/entity-kernel-entities.gen.ts",
      source:
        generatedHeader +
        "// Generated entity roster stays one line.\n// oxfmt-ignore\n" +
        `export const generatedEntityKernelEntities = ${compactLiteral(kernelEntityKeys)} as const;\n\n` +
        "// Generated capabilities stay compact and reviewable.\n// oxfmt-ignore\n" +
        `export const generatedEntityKernelContractCases = ${compactLiteral(kernelContractCases)} as const;\n\n` +
        "// Generated MCP exposure is a strict subset of executable kernel actions.\n" +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityKernelContractCases = ${compactLiteral(mcpKernelContractCases)} as const;\n\n` +
        "// One generated entity roster per MCP action.\n" +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityActionEntities = ${compactLiteral(
          Object.fromEntries(
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
        )} as const;\n\n` +
        "// Generated action rosters stay one line each.\n// oxfmt-ignore\n" +
        `export const generatedSearchEntityKernelEntities = ${compactLiteral(entitiesForAction("search"))} as const;\n` +
        `export const generatedMergeEntityKernelEntities = ${compactLiteral(entitiesForAction("merge"))} as const;\n`,
    },
    {
      relativePath:
        "apps/web/src/server/generated/entity-relation-contracts.gen.ts",
      source:
        generatedHeader +
        'import { relationMutationOut } from "@cubby/schemas/common";\n' +
        'import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";\n' +
        'import { shortcodeSchema } from "@cubby/schemas/identifiers";\n' +
        `${relationSchemaImports}\n` +
        'import { z } from "zod";\n\n' +
        "// Generated relation command schemas stay correlated by entity and relation.\n" +
        `const generatedEntityRelationCommandSchema = ${relationCommandSchema(null)};\n` +
        `export const generatedBrowserEntityRelationCommandSchema = ${relationCommandSchema("browser")};\n` +
        `export const generatedMcpEntityRelationCommandSchema = ${relationCommandSchema("mcp")};\n\n` +
        `export const generatedMcpEntityRelationPreviewInputSchema = ${mcpPreviewInputSchema};\n\n` +
        `export const generatedEntityRelationMutationResultSchema = ${relationResultSchema};\n\n` +
        "export type GeneratedEntityRelationCommand = z.infer<typeof generatedEntityRelationCommandSchema>;\n\n" +
        "/** Resolve generated relation metadata without a parallel hand-written roster. */\n" +
        "export function generatedEntityRelationTarget(command: GeneratedEntityRelationCommand): ShortcodeEntity {\n" +
        "  switch (`${command.entity}:${command.relation}`) {\n" +
        `${relationTargetCases}\n` +
        "  }\n" +
        "  throw new Error(`Unsupported relation ${command.entity}:${command.relation}`);\n" +
        "}\n\n" +
        "export const generatedEntityRelationItemIds = (command: GeneratedEntityRelationCommand): string[] => command.items.map((item) => item.id);\n",
    },
    {
      relativePath:
        "apps/web/src/server/generated/entity-relation-bindings.gen.ts",
      source:
        generatedHeader +
        'import type { EntityKernelContext } from "~/server/entity-kernel/adapter";\n' +
        'import type { Database } from "~/server/db";\n' +
        'import type { GeneratedEntityRelationCommand } from "~/server/generated/entity-relation-contracts.gen";\n' +
        'import type { RelationPlan } from "~/server/repo/relation-preflight";\n' +
        'import type { z } from "zod";\n' +
        'import { generatedEntityRelationMutationResultSchema } from "~/server/generated/entity-relation-contracts.gen";\n\n' +
        `${relationAdapterImports}\n\n` +
        "/** Dispatch is generated from each literal relationship mutation declaration. */\n" +
        "export async function executeGeneratedRelationMutation(ctx: EntityKernelContext, command: GeneratedEntityRelationCommand): Promise<z.infer<typeof generatedEntityRelationMutationResultSchema>> {\n" +
        "  switch (`${command.entity}:${command.relation}`) {\n" +
        `${relationRuntimeCases}\n` +
        "  }\n" +
        "  throw new Error(`Unsupported relation mutation ${command.entity}:${command.relation}`);\n" +
        "}\n\n" +
        "/** Advisory planning uses the same generated relation-to-adapter dispatch. */\n" +
        "export async function previewGeneratedRelationMutation(db: Database, command: GeneratedEntityRelationCommand, ownerId: string, targetIds: readonly string[]): Promise<RelationPlan> {\n" +
        "  switch (`${command.entity}:${command.relation}`) {\n" +
        `${relationPreviewCases}\n` +
        "  }\n" +
        "  throw new Error(`Unsupported relation preview ${command.entity}:${command.relation}`);\n" +
        "}\n",
    },
    {
      relativePath:
        "apps/web/src/server/generated/entity-kernel-bindings.gen.ts",
      source:
        generatedHeader +
        "// Generated port aliases retain deterministic import order.\n" +
        'import type { EntityKernelCoreBinding } from "~/server/entity-kernel/adapter";\n' +
        'import type { EntityKernelEntity } from "~/server/entity-kernel/contracts";\n\n' +
        'import { defineEntityOperations } from "~/server/entity-kernel/entity-operations";\n\n' +
        `${portTypeImports}\n\n` +
        "/** Each literal module/export source reference is checked without a runtime import. */\n" +
        `type EntityPortExportChecks = readonly [${portExportChecks
          .map(
            (ref) =>
              `typeof ${portTypeModuleAliases.get(ref.module)}[${JSON.stringify(ref.export)}]`,
          )
          .join(", ")}];\n\n` +
        `${runtimeAdapterImportSource}\n\n` +
        "type CorrelatedEntityKernelBindings = {\n" +
        "  [E in EntityKernelEntity]: EntityKernelCoreBinding<E>;\n" +
        "};\n\n" +
        "// Generated runtime assembly stays one entity per line.\n// oxfmt-ignore\n" +
        `export const ENTITY_KERNEL_BINDINGS = {\n${runtimeBindings}\n} as const satisfies CorrelatedEntityKernelBindings & { readonly __portExportChecks?: EntityPortExportChecks };\n` +
        "// Generated operation closures retain each binding's schema correlation.\n// oxfmt-ignore\n" +
        `export const ENTITY_KERNEL_OPERATIONS = {\n${runtimeOperations}\n} as const;\n`,
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
