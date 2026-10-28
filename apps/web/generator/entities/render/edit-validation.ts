import { generatedHeader } from "../../artifacts.ts";
import {
  EntityDeclarationError,
  type CompiledEntity,
  type EntityArtifacts,
} from "../declarations.ts";

export const bulkSchemaFor = (entity: CompiledEntity): string => {
  if (entity.bulkUpdateFields === null) return "null";
  const update = entity.contract?.update;
  if (!update)
    throw new EntityDeclarationError(
      `${entity.key}.bulkUpdate requires an update contract.`,
    );
  const fields = entity.bulkUpdateFields
    .map((key) => {
      const field = entity.fieldModel.fields.find(
        (candidate) => candidate.key === key,
      );
      const original = `${update.export}.shape[${JSON.stringify(key)}]`;
      const schema =
        field?.collection || field?.reference?.multiple === true
          ? `bulkCollectionPatchSchema(${original},${JSON.stringify(field?.collection?.key ?? "value")},${JSON.stringify(`${entity.key}${key}BulkCollection`)}).optional()`
          : original;
      return `${JSON.stringify(key)}:${schema}`;
    })
    .join(",");
  const collections = entity.fieldModel.fields
    .filter(
      (field) =>
        entity.bulkUpdateFields?.includes(field.key) &&
        (field.collection || field.reference?.multiple === true),
    )
    .map((field) => field.key);
  return `bulkUpdateInputSchema(${update.export},{${fields}},${JSON.stringify(collections)})`;
};

/** Demand-loaded canonical edit contracts share the ordinary bulk compiler. */
export const renderEntityEditValidationArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const editable = entities.filter(
    (entity) => entity.fieldModel.intents !== null,
  );
  const slices = editable.map((entity): EntityArtifacts => {
    const contract = entity.contract;
    if (!contract)
      throw new EntityDeclarationError(
        `${entity.key} editing requires a contract.`,
      );
    const imports = new Map<string, Set<string>>();
    for (const ref of [contract.create, contract.update]) {
      if (!ref) continue;
      const names = imports.get(ref.module) ?? new Set<string>();
      names.add(ref.export);
      imports.set(ref.module, names);
    }
    const bulkImports =
      entity.bulkUpdateFields === null
        ? []
        : [
            "bulkUpdateInputSchema",
            ...(entity.fieldModel.fields.some(
              (field) =>
                entity.bulkUpdateFields?.includes(field.key) &&
                (field.collection || field.reference?.multiple),
            )
              ? ["bulkCollectionPatchSchema"]
              : []),
          ];
    return {
      relativePath: `packages/schemas/src/generated/entity-edit-validation.${entity.key}.gen.ts`,
      source:
        generatedHeader +
        (bulkImports.length
          ? `import { ${bulkImports.join(", ")} } from "@cubby/schemas/entity-collection";\n`
          : "") +
        [...imports]
          .map(
            ([module, names]) =>
              `import { ${[...names].join(", ")} } from ${JSON.stringify(module)};\n`,
          )
          .join("") +
        `export const create = ${contract.create?.export ?? "null"};\n` +
        `export const update = ${contract.update?.export ?? "null"};\n` +
        `export const bulkUpdate = ${bulkSchemaFor(entity)};\n`,
    };
  });
  return [
    ...slices,
    {
      relativePath:
        "apps/web/src/server/generated/entity-edit-validation.gen.ts",
      source:
        generatedHeader +
        "export const entityEditValidationLoaders = {\n" +
        editable
          .map(
            ({ key }) =>
              `${JSON.stringify(key)}: () => import(${JSON.stringify(`@cubby/schemas/compiler/generated/entity-edit-validation/${key}`)}),\n`,
          )
          .join("") +
        "} as const;\n",
    },
    {
      relativePath:
        "apps/web/src/entity/generated/entity-edit-validation-types.gen.ts",
      source:
        generatedHeader +
        'import type { z } from "zod";\n' +
        "type Output<S> = S extends z.ZodType ? z.output<S> : never;\n" +
        "export type EntityEditValidationInputs = {\n" +
        editable
          .map(
            ({ key }) =>
              `${JSON.stringify(key)}: {\n` +
              ["create", "update", "bulkUpdate"]
                .map(
                  (operation) =>
                    `${operation}: Output<typeof import(${JSON.stringify(`@cubby/schemas/compiler/generated/entity-edit-validation/${key}`)}).${operation}>;\n`,
                )
                .join("") +
              "} ;\n",
          )
          .join("") +
        "};\n" +
        `export const generatedEditableEntities = ${JSON.stringify(editable.map(({ key }) => key))} as const;\n` +
        `export const generatedBulkEditEntities = ${JSON.stringify(entities.filter((entity) => entity.shortcode !== null && entity.bulkUpdateFields !== null).map(({ key }) => key))} as const;\n`,
    },
  ];
};
