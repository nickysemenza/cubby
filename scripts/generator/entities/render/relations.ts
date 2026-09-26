import { compactLiteral, generatedHeader } from "../../artifacts.ts";
import { EntityDeclarationError } from "../declarations.ts";
import type {
  CompiledEntity,
  EntityArtifacts,
  RelationMutation,
} from "../declarations.ts";

/**
 * Every literal relationship mutation (`attach`/`detach` on an entity's
 * relation), compiled into the browser/MCP command and result schemas plus
 * the kernel dispatch that executes and previews them. One render pass keeps
 * command, result, and dispatch correlated by the same `entity:relation` key
 * space instead of drifting across independently hand-maintained rosters.
 */
export const renderRelationArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const relationMutations = entities.flatMap(
    (entity) => entity.relationMutations,
  );
  const relationMutationKeys = relationMutations.map(
    ({ entity, relation }) => `${entity}:${relation}`,
  );
  if (new Set(relationMutationKeys).size !== relationMutationKeys.length) {
    throw new EntityDeclarationError("Relation mutation keys must be unique.");
  }
  const schemaImports = (refs: readonly RelationMutation["itemSchema"][]) =>
    [
      ...new Map(
        refs.map((ref) => [`${ref.module}#${ref.export}`, ref] as const),
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
  const relationSchemaImports = schemaImports(
    relationMutations.map(({ itemSchema }) => itemSchema),
  );
  const relationRowSchemaImports = schemaImports(
    relationMutations.map(({ rowSchema }) => rowSchema),
  );
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
  // `listRelation` reads every relation that declares an adapter. The kernel
  // command stays correlated per relation; the operation input/output are the
  // flat object shapes an MCP tool schema requires, with the input refined
  // back through the correlated command.
  const listUnion = (variants: readonly string[]) =>
    variants.length === 0
      ? "z.never()"
      : variants.length === 1
        ? variants[0]
        : `z.union([\n  ${variants.join(",\n  ")}\n])`;
  const relationListCommandSchema = listUnion(
    relationMutations.map(
      ({ entity, relation }) =>
        `z.object({action:z.literal("listRelation"),entity:z.literal(${JSON.stringify(entity)}),relation:z.literal(${JSON.stringify(relation)}),id:shortcodeSchema(${JSON.stringify(entity)})}).strict()`,
    ),
  );
  const relationListResultSchema = listUnion(
    relationMutations.map(
      ({ entity, relation, rowSchema }) =>
        `z.object({action:z.literal("listRelation"),entity:z.literal(${JSON.stringify(entity)}),relation:z.literal(${JSON.stringify(relation)}),id:shortcodeSchema(${JSON.stringify(entity)}),items:z.array(${rowSchema.export})})`,
    ),
  );
  const relationListEntities = compactLiteral([
    ...new Set(relationMutations.map(({ entity }) => entity)),
  ]);
  const relationListRelations = compactLiteral([
    ...new Set(relationMutations.map(({ relation }) => relation)),
  ]);
  const relationListRows = [
    ...new Set(
      relationMutations.map(({ rowSchema }) => `z.array(${rowSchema.export})`),
    ),
  ];
  const relationListInputSchema =
    relationMutations.length === 0
      ? "z.never()"
      : `z.object({entity:z.enum(${relationListEntities}),relation:z.enum(${relationListRelations}),id:anyShortcodeSchema(${relationListEntities})}).strict().superRefine((input,ctx)=>{const result=generatedEntityRelationListCommandSchema.safeParse({action:"listRelation",...input});if(!result.success){for(const issue of result.error.issues)ctx.addIssue({code:"custom",path:issue.path,message:issue.message});}})`;
  const relationListOutputSchema =
    relationMutations.length === 0
      ? "z.never()"
      : `z.object({entity:z.enum(${relationListEntities}),relation:z.enum(${relationListRelations}),id:z.string(),items:${schemaUnion(relationListRows)}})`;
  const relationListCases = relationMutations
    .map(
      ({ entity, relation, adapter }) =>
        `    case ${JSON.stringify(`${entity}:${relation}`)}: return {...command,entity:${JSON.stringify(entity)},relation:${JSON.stringify(relation)},items:await ${adapter.export}.list(ctx.readDb,command.id)};`,
    )
    .join("\n");
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
  return [
    {
      // Client-safe: the `entity.relation` operation contract imports it.
      relativePath:
        "apps/web/src/entities/generated/entity-relation-lists.gen.ts",
      source:
        generatedHeader +
        'import { anyShortcodeSchema, shortcodeSchema } from "@cubby/schemas/identifiers";\n' +
        `${relationRowSchemaImports}\n` +
        'import { z } from "zod";\n\n' +
        `export const generatedEntityRelationListCommandSchema = ${relationListCommandSchema};\n\n` +
        `export const generatedEntityRelationListResultSchema = ${relationListResultSchema};\n\n` +
        `export const generatedEntityRelationListInputSchema = ${relationListInputSchema};\n\n` +
        `export const generatedEntityRelationListOutputSchema = ${relationListOutputSchema};\n\n` +
        "export type GeneratedEntityRelationListCommand = z.infer<typeof generatedEntityRelationListCommandSchema>;\n",
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
        'import type { GeneratedEntityRelationListCommand, generatedEntityRelationListResultSchema } from "~/entities/generated/entity-relation-lists.gen";\n' +
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
        "}\n\n" +
        "/** Relation reads dispatch through the same generated adapter roster. */\n" +
        "export async function listGeneratedRelation(ctx: EntityKernelContext, command: GeneratedEntityRelationListCommand): Promise<z.input<typeof generatedEntityRelationListResultSchema>> {\n" +
        "  switch (`${command.entity}:${command.relation}`) {\n" +
        `${relationListCases}\n` +
        "  }\n" +
        "  throw new Error(`Unsupported relation list ${command.entity}:${command.relation}`);\n" +
        "}\n",
    },
  ];
};
