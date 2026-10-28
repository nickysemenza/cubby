import { entityContractName } from "../contracts.ts";
import { pascalCase } from "@cubby/shared/text-case";
import { generatedHeader } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";

/** Public contracts have one standard surface; domain modules compose only their refinements. */
export const renderSchemaWrapperArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] =>
  entities
    .filter((entity) => entity.contract !== null)
    .map((entity) => {
      const name = entityContractName(entity.key);
      // Domain write refinements keep their declared owner. Publishing a second
      // unrefined schema under the standard name would bypass those contracts.
      const ordinaryInput = (operation: "create" | "update") =>
        entity.contract?.[operation]?.module ===
        `@cubby/schemas/entity-contracts/${entity.key}`;
      const create = ordinaryInput("create");
      const update = ordinaryInput("update");
      const publicInputs = [
        ...(create ? [`${name}CreateInput`] : []),
        ...(update ? [`${name}UpdateData`] : []),
        `${name}FilterFields`,
      ];
      const values = [
        ...publicInputs.filter((value) => !value.endsWith("FilterFields")),
        `${name}Out`,
        `${name}ListItemOut`,
        `${name}DetailOut`,
        `${name}McpOut`,
        `${name}McpListItemOut`,
        `${name}McpDetailOut`,
      ];
      const declarations = [
        `export { ${publicInputs.join(", ")} };`,
        ...(update
          ? [
              `export const ${name}UpdateInput = z.object({ id: shortcodeSchema(${JSON.stringify(entity.key)}), data: ${name}UpdateData });`,
            ]
          : []),
        `export const ${name}Out = ${entity.key}FieldEnvelopeSchemas.output;`,
        `export const ${name}ListItemOut = ${entity.key}FieldEnvelopeSchemas.list;`,
        `export const ${name}DetailOut = ${entity.key}FieldEnvelopeSchemas.detail;`,
        `export const ${name}McpOut = ${entity.key}FieldEnvelopeSchemas.mcpOutput;`,
        `export const ${name}McpListItemOut = ${entity.key}FieldEnvelopeSchemas.mcpList;`,
        `export const ${name}McpDetailOut = ${entity.key}FieldEnvelopeSchemas.mcpDetail;`,
        `export const ${name}FiltersSchema = z.object(${name}FilterFields);`,
        `export type ${pascalCase(name)}Filters = z.infer<typeof ${name}FiltersSchema>;`,
        ...values.map(
          (value) =>
            `export type ${pascalCase(value)} = z.infer<typeof ${value}>;`,
        ),
        ...(update
          ? [
              `export type ${pascalCase(name)}UpdateInput = z.infer<typeof ${name}UpdateInput>;`,
            ]
          : []),
      ];
      return {
        relativePath: `packages/schemas/src/generated/entities/${entity.key}.gen.ts`,
        source:
          generatedHeader +
          'import { z } from "zod";\n' +
          (update
            ? 'import { shortcodeSchema } from "../../identifier-fields";\n'
            : "") +
          `import { ${publicInputs.join(", ")} } from "../entity-contracts.${entity.key}.gen";\n` +
          `import { ${entity.key}FieldEnvelopeSchemas } from "../entity-field-envelopes.${entity.key}.gen";\n` +
          declarations.join("\n") +
          "\n",
      };
    });
