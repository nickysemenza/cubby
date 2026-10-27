import { compactLiteral, generatedHeader } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import { entityProjectionMaps } from "./capabilities.ts";
import { treeRowExtension } from "./capabilities.ts";

export const renderEntityReadArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const projections = entityProjectionMaps(entities);
  const detailEntities = projections.detail;
  const detailSchemas = detailEntities
    .map(
      ({ key }) =>
        `  ${JSON.stringify(key)}: entityFieldEnvelopeSchemas[${JSON.stringify(key)}].detail,`,
    )
    .join("\n");
  const detailRuntimeImportSource = [
    {
      module: "@cubby/schemas/entity-field-envelopes",
      source:
        'import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";',
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

  const listEntitySpecs = projections.list;
  const listEntityKeys = listEntitySpecs.map(({ key }) => key);
  const crudEntitySpecs = projections.crud;
  const browserCrudEntities = crudEntitySpecs.map(({ key }) => key);
  const listFilterFieldImports = listEntitySpecs
    .flatMap(({ key, filterSchema }) =>
      filterSchema === null
        ? []
        : [
            `import { ${filterSchema.export} as ${key}ListFilterFields } from ${JSON.stringify(filterSchema.module)};`,
          ],
    )
    .join("\n");
  // Only a declared `list.tree` accepts a nesting scope.
  const listInputVariants = listEntitySpecs
    .map(
      ({ key, filterSchema, inspector }) =>
        `z.object({entity:z.literal(${JSON.stringify(key)}),filters:${filterSchema === null ? "z.record(z.string(),z.unknown())" : `${key}ListFiltersSchema`},sort:entityListSortsSchema.optional(),pagination:entityListPaginationSchema.optional(),groupBy:listGroupByDimensionsSchema.optional()${inspector.list.tree === null ? "" : ",nesting:listNestingSchema.optional()"}})`,
    )
    .join(",\n  ");
  // Strict: an unknown filter name is a 400, not a silently wider list.
  const listFilterSchemas = listEntitySpecs
    .map(({ key, filterSchema, descriptor }) =>
      filterSchema === null
        ? `const ${key}ListFiltersSchema = z.record(z.string(), z.unknown());`
        : `const ${key}ListFiltersSchema = ${
            descriptor.searchable === true
              ? `z.strictObject(${key}ListFilterFields).extend({searchQuery:z.string().trim().min(1).max(100).optional()})`
              : `z.strictObject(${key}ListFilterFields)`
          }.extend({ids:z.array(z.string()).max(500).optional()});`,
    )
    .join("\n");
  const listFilterSchemaBindings = listEntitySpecs
    .map(({ key }) => `  ${JSON.stringify(key)}: ${key}ListFiltersSchema,`)
    .join("\n");
  // One named export per list row so the native contract stage names the component
  // `<Entity>ListItem` (the export walk in `http-api/schema-names.ts` names
  // exported instances only); an inline `withEntityListMedia(...)` call would
  // surface in Swift as a positional `ItemsPayloadPayload`.
  const listItemSchemas = listEntitySpecs
    .map(
      ({ key, inspector }) =>
        `export const ${key}ListItem = entityFieldEnvelopeSchemas[${JSON.stringify(key)}].list${treeRowExtension(inspector)};`,
    )
    .join("\n");
  const listReadSchemas = listEntitySpecs
    .map(
      ({ key }) =>
        `  ${JSON.stringify(key)}: compileListReadSchema(${key}ListItem),`,
    )
    .join("\n");
  const listOutputSchemas = listEntitySpecs
    .map(
      ({ key }) =>
        `  ${JSON.stringify(key)}: z.object({items:z.array(${key}ListItem),meta:entityListMetaSchema}),`,
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
  return [
    {
      relativePath: "apps/web/src/entity/generated/entity-details.gen.ts",
      source:
        generatedHeader +
        `${detailRuntimeImportSource}\n\n` +
        `export const detailEntities = ${compactLiteral(detailEntities.map(({ key }) => key))} as const;\n` +
        "export type DetailEntity = (typeof detailEntities)[number];\n\n" +
        "// One generated detail schema per entity.\n// oxfmt-ignore\n" +
        `const ENTITY_DETAIL_OUTPUT_SCHEMAS: { [E in DetailEntity]: (typeof entityFieldEnvelopeSchemas)[E]["detail"] } = {\n${detailSchemas}\n};\n\n` +
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
      relativePath: "apps/web/src/entity/generated/entity-lists.gen.ts",
      source:
        generatedHeader +
        "// Generated schema aliases retain deterministic import order.\n" +
        `${listFilterFieldImports}\n` +
        'import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";\n' +
        'import { compileListReadSchema } from "../model/list-read-fields";\n' +
        'import { listChildCountSchema, listNestingSchema, listGroupByDimensionsSchema, type ListGroupBy, MAX_PAGE_SIZE, MAX_SORTS, paginatedMetaSchema } from "@cubby/schemas/pagination";\n' +
        'import type { FilterPatch } from "../filters";\n' +
        'import { z } from "zod";\n\n' +
        `export const listEntities = ${compactLiteral(listEntityKeys)} as const;\n` +
        "export type ListEntity = (typeof listEntities)[number];\n\n" +
        'const entityListSortSchema = z.object({ orderBy: z.string().min(1), direction: z.enum(["asc", "desc"]) });\n' +
        "const entityListSortsSchema = z.array(entityListSortSchema).min(1).max(MAX_SORTS);\n" +
        "const entityListPaginationSchema = z.object({ pageIndex: z.number().int().min(0), pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE) });\n" +
        "// The one page-metadata schema every list shares (one native model).\nconst entityListMetaSchema = paginatedMetaSchema;\n\n" +
        `${listFilterSchemas}\n\n` +
        "// One generated filter schema per list entity.\n// oxfmt-ignore\n" +
        `const ENTITY_LIST_FILTER_SCHEMAS = {\n${listFilterSchemaBindings}\n} as const;\n\n` +
        `export const entityListInputSchema = z.discriminatedUnion("entity", [\n  ${listInputVariants}\n]);\n\n` +
        `${listItemSchemas}\n\n` +
        `export const ENTITY_LIST_READ_SCHEMAS = {\n${listReadSchemas}\n} as const;\n\n` +
        "const ENTITY_LIST_OUTPUT_SCHEMAS = {\n" +
        `${listOutputSchemas}\n` +
        "} as const;\n\n" +
        "type EntityListInputFiltersByEntity = { [E in ListEntity]: z.input<(typeof ENTITY_LIST_FILTER_SCHEMAS)[E]> };\n" +
        "type EntityListParsedFiltersByEntity = { [E in ListEntity]: z.output<(typeof ENTITY_LIST_FILTER_SCHEMAS)[E]> };\n" +
        "type EntityListSort = z.input<typeof entityListSortSchema>;\n" +
        "export type EntityListInputByEntity = {\n" +
        "  [E in ListEntity]: { entity: E; filters: EntityListInputFiltersByEntity[E]; sort?: EntityListSort[]; pagination?: { pageIndex: number; pageSize: number }; groupBy?: ListGroupBy[]; nesting?: z.input<typeof listNestingSchema> };\n" +
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
        "export type EntityListParseInput = EntityListInputByEntity[ListEntity] | { entity: ListEntity; filters: FilterPatch; sort?: EntityListSort[]; pagination?: { pageIndex: number; pageSize: number }; groupBy?: ListGroupBy[]; nesting?: z.input<typeof listNestingSchema> };\n\n" +
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
        "apps/web/src/entity/generated/entity-mutation-results.gen.ts",
      source:
        generatedHeader +
        'import { entityMutationItem } from "@cubby/schemas/entity-mutation";\n' +
        'import { shortcodeSchema } from "@cubby/schemas/identifiers";\n' +
        'import type { z } from "zod";\n\n' +
        `export const entityMutationOutputEntities = ${compactLiteral(browserCrudEntities)} as const;\n` +
        "export type EntityMutationOutputEntity = (typeof entityMutationOutputEntities)[number];\n\n" +
        "export type EntityMutationOutputByEntity = { [E in EntityMutationOutputEntity]: z.output<typeof entityMutationItem> };\n\n" +
        'type UnparsedMutationOutput = Parameters<z.ZodType["parse"]>[0];\n' +
        "export function parseEntityMutationOutput<E extends EntityMutationOutputEntity>(entity: E, value: UnparsedMutationOutput): EntityMutationOutputByEntity[E] {\n" +
        "  const item = entityMutationItem.parse(value);\n" +
        "  shortcodeSchema(entity).parse(item.id);\n" +
        "  return item;\n" +
        "}\n",
    },
    {
      relativePath: "apps/web/src/entity/generated/entity-filter-fields.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n' +
        'import type { z } from "zod";\n' +
        `${filterFieldImportSource}\n\n` +
        "// Generated filter field assembly stays one entity per line.\n// oxfmt-ignore\n" +
        `export const entityFilterFieldMaps = {\n${filterFieldBindings}\n} satisfies Partial<Record<Entity, Record<string, z.ZodType>>>;\n`,
    },
  ];
};
