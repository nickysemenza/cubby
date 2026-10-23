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
      const title = entity.fieldModel.fields.find(
        (field) => field.readKey === entity.inspector.titleField,
      );
      const titleColumn = title
        ? (entity.fieldModel.storage.find((entry) => entry.key === title.key)
            ?.column ?? null)
        : null;
      return [
        {
          key: entity.key,
          dbTable: stringValue(dbTable, `${entity.key}.descriptor.dbTable`),
          titleColumn,
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
  const titleColumnBindings = shortcodeTableEntities
    .map(
      ({ key, dbTable, titleColumn }) =>
        `  ${JSON.stringify(key)}: ${titleColumn === null ? "null" : `${lowerCamelCase(dbTable)}[${JSON.stringify(titleColumn)}]`},`,
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
        `export const SHORTCODE_TABLE = {\n${shortcodeTableBindings}\n} as const;\n\n` +
        "// Physical title columns only; computed titles remain null for the resolver's explicit overrides.\n// oxfmt-ignore\n" +
        `export const TITLE_FIELD_COLUMN = {\n${titleColumnBindings}\n} as const;\n`,
    },
  ];
};
