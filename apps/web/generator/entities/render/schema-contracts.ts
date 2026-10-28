import { bulkSchemaFor } from "./edit-validation.ts";
import { generatedHeader } from "../../artifacts.ts";
import { EntityDeclarationError } from "../declarations.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import { kernelEntitiesFor } from "./shared.ts";
import { entityProjectionMaps } from "./capabilities.ts";
import { treeRowExtension } from "./capabilities.ts";
import { kernelActionsFor } from "./capabilities.ts";

export const renderEntitySchemaArtifacts = (
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
      const bulkUpdateInput = bulkSchemaFor(entity);
      const filters =
        filterSchema === null
          ? "z.object({})"
          : entity.descriptor.searchable === true
            ? `z.object(${filterSchema.export}).extend({searchQuery:z.string().trim().min(1).max(100).optional()})`
            : `z.object(${filterSchema.export})`;
      return `  ${JSON.stringify(entity.key)}: entitySchema(${JSON.stringify(entity.key)},{filters:${filters},createInput:${contract.create?.export ?? "null"},updateInput:${contract.update?.export ?? "null"},bulkUpdateInput:${bulkUpdateInput},output:${contract.output.export},detail:${contract.detail.export},list:${contract.list.export},mcpOutput:${contract.mcpOutput.export},mcpDetail:${contract.mcpDetail.export},mcpList:${contract.mcpList.export}},entityFieldEnvelopeSchemas[${JSON.stringify(entity.key)}]),`;
    })
    .join("\n");
  const repositoryListBindings = schemaEntitySpecs
    .map(
      ({ key, contract, inspector }) =>
        `  ${JSON.stringify(key)}: compileListReadSchema(withEntityListMedia(mergeReadSchemas(${contract.list.export}, ${contract.detail.export}))${treeRowExtension(inspector)}),`,
    )
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
  const exposed = (entity: CompiledEntity, action: string, mcp: boolean) =>
    !mcp || entity.mcpActions.includes(action);
  const commandVariants = (action: "create" | "update", mcp = false) =>
    schemaEntitySpecs
      .filter(
        (entity) =>
          entity.contract[action] !== null &&
          kernelActionsFor(entity).includes(action) &&
          exposed(entity, action, mcp),
      )
      .map((entity) => {
        const schema = entity.contract[action];
        if (schema === null)
          throw new EntityDeclarationError(
            `${entity.key}.${action} is missing.`,
          );
        const id =
          action === "update"
            ? `,id:shortcodeSchema(${JSON.stringify(entity.key)})`
            : "";
        return `z.strictObject({action:z.literal(${JSON.stringify(action)}),entity:z.literal(${JSON.stringify(entity.key)})${id},data:${schema.export}})`;
      })
      .join(",\n  ");
  const mutationResultVariants = (action: "create" | "update", mcp = false) =>
    schemaEntitySpecs
      .filter(
        (entity) =>
          entity.contract[action] !== null &&
          kernelActionsFor(entity).includes(action) &&
          exposed(entity, action, mcp),
      )
      .map(
        ({ key }) =>
          `z.object({action:z.literal(${JSON.stringify(action)}),entity:z.literal(${JSON.stringify(key)}),item:entityMutationItemFor(${JSON.stringify(key)}),appliedFields:entityMutationAppliedFields,sideEffects:mutationSideEffectsSchema})`,
      )
      .join(",\n  ");
  const queryResultVariants = (action: "get" | "list", mcp = false) =>
    schemaEntitySpecs
      .filter((entity) => exposed(entity, action, mcp))
      .map(({ key, inspector }) => {
        const projection =
          action === "get"
            ? mcp
              ? "mcpDetail"
              : "detail"
            : mcp
              ? "mcpList"
              : "list";
        const schema = `entityFieldEnvelopeSchemas[${JSON.stringify(key)}].${projection}`;
        const result =
          action === "get"
            ? `item:${schema}.nullable()`
            : `items:z.array(${schema}${treeRowExtension(inspector)}),meta:paginatedMetaSchema`;
        return `z.object({action:z.literal(${JSON.stringify(action)}),entity:z.literal(${JSON.stringify(key)}),${result}})`;
      })
      .join(",\n  ");
  // Strict input objects reject excluded fields; references to normal update
  // fields keep the derived roster checked against the actual update contract.
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
        return `z.object({action:z.literal("bulkUpdate"),entity:z.literal(${JSON.stringify(entity.key)}),ids,data:${bulkSchemaFor(entity)}})`;
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
  const mergeResultVariants = (mcp = false) =>
    kernelEntities
      .filter(
        (entity) =>
          kernelActionsFor(entity).includes("merge") &&
          exposed(entity, "merge", mcp),
      )
      .map((entity) => {
        if (entity.contract === null)
          throw new EntityDeclarationError(
            `${entity.key}.merge output is missing.`,
          );
        const projection = mcp ? "mcpOutput" : "output";
        return `z.object({action:z.literal("merge"),entity:z.literal(${JSON.stringify(entity.key)}),item:entityFieldEnvelopeSchemas[${JSON.stringify(entity.key)}].${projection},mergeSummary:z.json(),sideEffects:mutationSideEffectsSchema})`;
      })
      .join(",\n  ");
  return [
    {
      relativePath: "apps/web/src/server/generated/entity-bindings.gen.ts",
      source:
        generatedHeader +
        'import { bulkUpdateInputSchema, bulkCollectionPatchSchema } from "@cubby/schemas/entity-collection";\n' +
        'import { mutationSideEffectsSchema } from "@cubby/schemas/mutation-side-effects";\n' +
        'import { entityMutationItemFor, entityMutationAppliedFields } from "@cubby/schemas/entity-mutation";\n' +
        'import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";\n' +
        'import { withEntityListMedia } from "@cubby/schemas/entity-read-media";\n' +
        'import { compileListReadSchema, mergeReadSchemas } from "~/entity/model/list-read-fields";\n' +
        'import { listChildCountSchema, paginatedMetaSchema } from "@cubby/schemas/pagination";\n' +
        'import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";\n' +
        `${schemaImports}\n` +
        'import { z } from "zod";\n\n' +
        'import { entitySchema } from "@cubby/schemas/entity-schema-bindings";\n\n' +
        "// Generated schema correlations stay one entity per line.\n// oxfmt-ignore\n" +
        `export const ENTITY_SCHEMA_BINDINGS = {\n${schemaBindings}\n} as const;\n` +
        `export const ENTITY_REPOSITORY_READ_SCHEMAS = {\n${repositoryListBindings}\n} as const;\n` +
        "export type EntitySchemaBindingMap = typeof ENTITY_SCHEMA_BINDINGS;\n" +
        "export type EntitySchemaBindingEntity = keyof EntitySchemaBindingMap;\n" +
        "type EntitySchemaBinding = EntitySchemaBindingMap[EntitySchemaBindingEntity];\n" +
        "type EntityBinding = { crud: EntitySchemaBinding | null };\n\n" +
        "// Generated bindings stay one entity per line.\n// oxfmt-ignore\n" +
        `export const ENTITY_BINDINGS = {\n${bindings}\n} satisfies Record<ShortcodeEntity, EntityBinding>;\n\n` +
        "// One generated variant per entity.\n// oxfmt-ignore\n" +
        `export const generatedEntityCreateCommandSchema = z.union([\n  ${commandVariants("create")}\n]);\n\n` +
        "// One generated variant per entity.\n// oxfmt-ignore\n" +
        `export const generatedEntityUpdateCommandSchema = z.union([\n  ${commandVariants("update")}\n]);\n\n` +
        "// MCP command variants are filtered by each literal's declared exposure.\n" +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityCreateCommandSchema = z.union([\n  ${commandVariants("create", true)}\n]);\n\n` +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityUpdateCommandSchema = z.union([\n  ${commandVariants("update", true)}\n]);\n\n` +
        "/** The kernel owns the shared 1-500 unique-id bound, so it injects `ids`. */\n" +
        "// One generated variant per bulk-updatable entity.\n// oxfmt-ignore\n" +
        `export const generatedEntityBulkUpdateCommandSchema = ${bulkUpdateCommandFactory};\n` +
        `export const generatedMcpEntityBulkUpdateCommandSchema = ${mcpBulkUpdateCommandFactory};\n` +
        "\n" +
        `export const generatedEntityMutationCreateResultSchema = z.discriminatedUnion("entity", [\n  ${mutationResultVariants("create")}\n]);\n\n` +
        `export const generatedEntityMutationUpdateResultSchema = z.discriminatedUnion("entity", [\n  ${mutationResultVariants("update")}\n]);\n` +
        "// One generated query result per correlated entity output.\n// oxfmt-ignore\n" +
        `export const generatedEntityGetResultSchema = z.discriminatedUnion("entity", [\n  ${queryResultVariants("get")}\n]);\n\n` +
        "// One generated query result per correlated entity output.\n// oxfmt-ignore\n" +
        `export const generatedEntityListResultSchema = z.discriminatedUnion("entity", [\n  ${queryResultVariants("list")}\n]);\n` +
        "\n// Merge summaries are workflow-specific JSON; the surviving item remains entity-correlated.\n// oxfmt-ignore\n" +
        `export const generatedEntityMergeResultSchema = z.discriminatedUnion("entity", [\n  ${mergeResultVariants()}\n]);\n` +
        "\n// MCP variants preserve entity correlation while projecting storage-only child ids.\n// oxfmt-ignore\n" +
        `export const generatedMcpEntityGetResultSchema = z.discriminatedUnion("entity", [\n  ${queryResultVariants("get", true)}\n]);\n\n` +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityListResultSchema = z.discriminatedUnion("entity", [\n  ${queryResultVariants("list", true)}\n]);\n\n` +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityMutationCreateResultSchema = z.discriminatedUnion("entity", [\n  ${mutationResultVariants("create", true)}\n]);\n\n` +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityMutationUpdateResultSchema = z.discriminatedUnion("entity", [\n  ${mutationResultVariants("update", true)}\n]);\n\n` +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityMergeResultSchema = z.discriminatedUnion("entity", [\n  ${mergeResultVariants(true)}\n]);\n`,
    },
  ];
};
