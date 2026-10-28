import { compactLiteral, generatedHeader } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import { entityProjectionMaps } from "./capabilities.ts";

/** Browser contracts carry wire plans and inferred output types, never domain schemas. */
export function renderBrowserReadContracts(
  entities: readonly CompiledEntity[],
): EntityArtifacts[] {
  const projections = entityProjectionMaps(entities);
  return [
    {
      relativePath: "apps/web/src/entity/generated/entity-lists.gen.ts",
      source:
        generatedHeader +
        'import { z } from "zod";\n' +
        'import { listNestingSchema, listResultMembership, listGroupByDimensionsSchema, MAX_PAGE_SIZE, MAX_SORTS } from "@cubby/schemas/pagination";\n' +
        'import type { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";\nimport type { buildPaginatedResponse } from "@cubby/schemas/pagination";\nexport type EntityListResultByEntity = { [E in ListEntity]: ReturnType<typeof buildPaginatedResponse<z.output<(typeof entityFieldEnvelopeSchemas)[E]["list"]>>> };\n' +
        `export const listEntities = ${compactLiteral(projections.list.map(({ key }) => key))} as const;\n` +
        "export type ListEntity = (typeof listEntities)[number];\n" +
        "const filterValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]).optional();\n" +
        'const entityListPlan = z.object({filters:z.record(z.string(),filterValue),sort:z.array(z.object({orderBy:z.string().min(1),direction:z.enum(["asc","desc"])})).min(1).max(MAX_SORTS).optional(),pagination:z.object({pageIndex:z.number().int().min(0),pageSize:z.number().int().min(1).max(MAX_PAGE_SIZE)}).optional(),groupBy:listGroupByDimensionsSchema.optional(),nesting:listNestingSchema.optional(),resultMembership:listResultMembership.optional(),includeCount:z.boolean().optional()});\n' +
        `export const entityListInputSchema = z.discriminatedUnion("entity", [${projections.list.map(({ key }) => `entityListPlan.extend({entity:z.literal(${JSON.stringify(key)})})`).join(",")}]);\n` +
        "type Plan = z.input<typeof entityListInputSchema>;\n" +
        'export type EntityListInputByEntity = { [E in ListEntity]: Omit<Plan, "entity"> & {entity:E} };\n' +
        'export type ParsedEntityListInputByEntity = { [E in ListEntity]: Omit<z.output<typeof entityListInputSchema>, "entity"> & {entity:E} };\n' +
        'export type EntityListParamsByEntity = { [E in ListEntity]: Omit<EntityListInputByEntity[E], "entity"> };\n' +
        'export type EntityListParseInput = Omit<Plan, "entity" | "filters"> & {entity:ListEntity; filters:Record<string,unknown>};\n' +
        "export function entityListInputFor<E extends ListEntity>(entity:E,input:EntityListParamsByEntity[E]):EntityListInputByEntity[E];\n" +
        "export function entityListInputFor(entity:ListEntity,input:EntityListParamsByEntity[ListEntity]) { return {entity,...input}; }\n" +
        "export function entityListParamsFromParsed<E extends ListEntity>(entity:E,input:ParsedEntityListInputByEntity[E]):EntityListParamsByEntity[E];\n" +
        'export function entityListParamsFromParsed(entity:ListEntity,input:ParsedEntityListInputByEntity[ListEntity]) { if(input.entity!==entity) throw new Error("Entity list input discriminator mismatch"); const {entity:_entity,...params}=input; return params; }\n' +
        "// Entity-specific filters are validated by the selected server read owner.\n" +
        "export function parseEntityListInput<E extends ListEntity>(entity:E,value:EntityListInputByEntity[E]|EntityListParseInput):ParsedEntityListInputByEntity[E];\n" +
        'export function parseEntityListInput(entity:ListEntity,value:EntityListParseInput) { const parsed=entityListInputSchema.parse(value); if(parsed.entity!==entity) throw new Error("Entity list input discriminator mismatch"); return parsed; }\n',
    },
    {
      relativePath: "apps/web/src/entity/generated/entity-details.gen.ts",
      source:
        generatedHeader +
        'import { shortcodeSchema } from "@cubby/schemas/identifiers";\n' +
        'import { z } from "zod";\n' +
        'import type { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";\nexport type EntityDetailByEntity = { [E in DetailEntity]: z.output<(typeof entityFieldEnvelopeSchemas)[E]["detail"]> };\n' +
        `export const detailEntities = ${compactLiteral(projections.detail.map(({ key }) => key))} as const;\n` +
        "export type DetailEntity = (typeof detailEntities)[number];\n" +
        'export const entityDetailInputSchema = z.discriminatedUnion("entity", [\n' +
        projections.detail
          .map(
            ({ key }) =>
              `z.object({entity:z.literal(${JSON.stringify(key)}),shortcode:shortcodeSchema(${JSON.stringify(key)})})`,
          )
          .join(",\n") +
        "]);\n" +
        "export type EntityDetailInputByEntity = { [E in DetailEntity]: Extract<z.input<typeof entityDetailInputSchema>, {entity:E}> };\n" +
        "export type ParsedEntityDetailInputByEntity = { [E in DetailEntity]: Extract<z.output<typeof entityDetailInputSchema>, {entity:E}> };\n" +
        'export function entityDetailInputFor<E extends DetailEntity>(entity:E,shortcode:EntityDetailInputByEntity[E]["shortcode"]):EntityDetailInputByEntity[E];\n' +
        "export function entityDetailInputFor(entity:DetailEntity,shortcode:string) { return {entity,shortcode}; }\n" +
        "export function parseEntityDetailInput<E extends DetailEntity>(entity:E,value:EntityDetailInputByEntity[E]):ParsedEntityDetailInputByEntity[E];\n" +
        'export function parseEntityDetailInput(entity:DetailEntity,value:EntityDetailInputByEntity[DetailEntity]) { const parsed=entityDetailInputSchema.parse(value); if(parsed.entity!==entity) throw new Error("Entity detail input discriminator mismatch"); return parsed; }\n',
    },
  ];
}
