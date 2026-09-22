import { compactLiteral, generatedHeader } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import { entityProjectionMaps } from "./index.ts";

/**
 * `entity-timelines.gen.ts`: the roster of entities with a timeline
 * capability, one branded input schema per entity (the entity's list filters
 * plus the shared window and pagination), and the one shared output schema. The timeline
 * reads the list filters, so the roster is a subset of the list roster.
 */
export const renderTimelineArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const { list } = entityProjectionMaps(entities);
  const timelineEntities = list.filter((entity) => entity.timeline !== null);
  const filterImports = timelineEntities
    .flatMap(({ key, filterSchema }) =>
      filterSchema === null
        ? []
        : [
            `import { ${filterSchema.export} as ${key}TimelineFilterFields } from ${JSON.stringify(filterSchema.module)};`,
          ],
    )
    .join("\n");
  const inputVariants = timelineEntities
    .map(
      ({ key, filterSchema }) =>
        `z.object({entity:z.literal(${JSON.stringify(key)}),filters:${filterSchema === null ? "z.record(z.string(),z.unknown())" : `z.object(${key}TimelineFilterFields)`},window:entityTimelineWindowFor(shortcodeSchema(${JSON.stringify(key)})),pagination:entityTimelinePagination})`,
    )
    .join(",\n  ");
  const modes = Object.fromEntries(
    timelineEntities.map(({ key, timeline }) => [key, timeline]),
  );
  return [
    {
      relativePath: "apps/web/src/entities/generated/entity-timelines.gen.ts",
      source:
        generatedHeader +
        `${filterImports}\n` +
        'import { entityTimelineOut, entityTimelinePagination, entityTimelineWindowFor } from "@cubby/schemas/entity-timeline";\n' +
        'import { shortcodeSchema } from "@cubby/schemas/identifiers";\n' +
        'import { z } from "zod";\n\n' +
        `export const timelineEntities = ${compactLiteral(timelineEntities.map(({ key }) => key))} as const;\n` +
        "export type TimelineEntity = (typeof timelineEntities)[number];\n\n" +
        '/** `"default"`: audit log plus declared date fields; `"custom"`: the bound `ports.timeline`. */\n' +
        "// oxfmt-ignore\n" +
        `export const entityTimelineModes = ${compactLiteral(modes)} as const satisfies Record<TimelineEntity, "default" | "custom">;\n\n` +
        "// One generated timeline input variant per entity.\n// oxfmt-ignore\n" +
        `export const entityTimelineInputSchema = ${timelineEntities.length === 0 ? "z.never()" : `z.discriminatedUnion("entity", [\n  ${inputVariants}\n])`};\n\n` +
        "type EntityTimelineInput = z.input<typeof entityTimelineInputSchema>;\n" +
        "type ParsedEntityTimelineInput = z.output<typeof entityTimelineInputSchema>;\n" +
        "export type EntityTimelineInputByEntity = { [E in TimelineEntity]: Extract<EntityTimelineInput, { entity: E }> };\n" +
        "export type ParsedEntityTimelineInputByEntity = { [E in TimelineEntity]: Extract<ParsedEntityTimelineInput, { entity: E }> };\n" +
        'export type EntityTimelineParamsByEntity = { [E in TimelineEntity]: Omit<EntityTimelineInputByEntity[E], "entity"> };\n\n' +
        "export function entityTimelineInputFor<E extends TimelineEntity>(entity: E, input: EntityTimelineParamsByEntity[E]): EntityTimelineInputByEntity[E];\n" +
        "export function entityTimelineInputFor(entity: TimelineEntity, input: EntityTimelineParamsByEntity[TimelineEntity]) {\n" +
        "  return { entity, ...input };\n" +
        "}\n\n" +
        "export function parseEntityTimelineInput<E extends TimelineEntity>(entity: E, value: EntityTimelineInputByEntity[E]): ParsedEntityTimelineInputByEntity[E];\n" +
        "export function parseEntityTimelineInput(entity: TimelineEntity, value: EntityTimelineInputByEntity[TimelineEntity]) {\n" +
        "  const parsed = entityTimelineInputSchema.parse(value);\n" +
        '  if (parsed.entity !== entity) throw new Error("Entity timeline input discriminator mismatch");\n' +
        "  return parsed;\n" +
        "}\n\n" +
        "/** One output shape for every entity's timeline. */\n" +
        "export const getEntityTimelineOutputSchema = (_entity: TimelineEntity) => entityTimelineOut;\n",
    },
  ];
};
