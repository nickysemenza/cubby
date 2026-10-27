import type { ChildTableDeclaration } from "@cubby/schemas/compiler/entity-definitions/child-definition";
import { generatedHeader } from "../../artifacts.ts";
import { stringValue } from "../declarations.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import {
  renderEntityTableArtifacts,
  renderIdentityStorageTablesArtifact,
} from "./tables.ts";
import { lowerCamelCase } from "./routes.ts";

export const renderEntityDatabaseArtifacts = (
  entities: readonly CompiledEntity[],
  moduleChildren: readonly ChildTableDeclaration[],
): EntityArtifacts[] => {
  const entityTables = renderEntityTableArtifacts(entities, moduleChildren);
  const shortcodeTableEntities = entities
    .flatMap((entity) => {
      const { dbTable } = entity.descriptor;
      if (
        entity.shortcode === null ||
        dbTable === null ||
        dbTable === undefined
      )
        return [];
      return [
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
      relativePath: "apps/web/src/server/db/generated/entity-tables.gen.ts",
      source: entityTables.relations,
    },
    {
      relativePath:
        "apps/web/src/server/db/generated/entity-table-definitions.gen.ts",
      source: entityTables.definitions,
    },
    {
      relativePath:
        "apps/web/src/server/db/generated/identity-storage-tables.gen.ts",
      source: renderIdentityStorageTablesArtifact(entities),
    },
    {
      relativePath: "apps/web/src/server/generated/shortcode-tables.gen.ts",
      source:
        generatedHeader +
        "// Generated table imports stay one entity per line.\n// oxfmt-ignore\n" +
        `import {\n${shortcodeTableImportNames.map((name) => `  ${name},`).join("\n")}\n} from "~/server/db/generated/entity-table-definitions.gen";\n\n` +
        "// Generated table bindings stay one entity per line.\n// oxfmt-ignore\n" +
        `export const SHORTCODE_TABLE = {\n${shortcodeTableBindings}\n} as const;\n`,
    },
  ];
};
