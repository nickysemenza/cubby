import {
  childTableMetadataSchema,
  type ChildTableMetadata,
} from "../../../packages/schemas/src/entity-definitions/child-definition.ts";
import { EntityDeclarationError } from "./declarations.ts";
import { TABLE_SQL_PLACEHOLDER } from "./table-storage.ts";

/** Children keep their declared indexes exactly; adopting declarations must not add DDL. */
export const compileChildTables = (
  declarations: readonly unknown[],
  externalTables: ReadonlySet<string>,
): ChildTableMetadata[] => {
  const tables = declarations.map((value) =>
    childTableMetadataSchema.parse(value),
  );
  return validateChildTables(tables, externalTables);
};

const validateExpressions = (
  table: ChildTableMetadata,
  column: (key: string) => void,
  target: (name: string, fields: readonly string[]) => void,
  validateSql: (sql: string) => void,
) => {
  for (const field of table.columns) {
    if (field.reference)
      target(field.reference.table, [field.reference.column]);
    if (field.values && field.kind !== "text")
      throw new EntityDeclarationError(
        `${table.name}.${field.key} enum requires text.`,
      );
    if (field.onUpdateNow && field.kind !== "timestamp")
      throw new EntityDeclarationError(
        `${table.name}.${field.key} update clock requires timestamp.`,
      );
  }
  for (const index of table.indexes) {
    for (const part of index.on) {
      if ("column" in part) column(part.column);
      else validateSql(part.sql);
    }
    if (index.where) validateSql(index.where);
  }
  for (const check of table.checks) validateSql(check.sql);
};

export const validateChildTables = (
  tables: ChildTableMetadata[],
  externalTables: ReadonlySet<string>,
): ChildTableMetadata[] => {
  const names = new Set<string>();
  const exports = new Map<string, ReadonlySet<string>>();
  for (const table of tables) {
    if (
      names.has(table.name) ||
      exports.has(table.exportName) ||
      externalTables.has(table.exportName)
    )
      throw new EntityDeclarationError(
        `Duplicate child table ${table.name} / ${table.exportName}.`,
      );
    names.add(table.name);
    const columns = new Set<string>();
    for (const column of table.columns) {
      if (columns.has(column.key))
        throw new EntityDeclarationError(
          `Duplicate ${table.name}.${column.key}.`,
        );
      columns.add(column.key);
    }
    exports.set(table.exportName, columns);
  }
  for (const table of tables) {
    const columns = exports.get(table.exportName)!;
    const column = (key: string) => {
      if (!columns.has(key))
        throw new EntityDeclarationError(
          `${table.name} names missing column ${key}.`,
        );
    };
    const target = (name: string, fields: readonly string[]) => {
      if (!exports.has(name) && !externalTables.has(name))
        throw new EntityDeclarationError(
          `${table.name} references unknown table ${name}.`,
        );
      const sibling = exports.get(name);
      if (sibling)
        for (const field of fields)
          if (!sibling.has(field))
            throw new EntityDeclarationError(
              `${table.name} references missing ${name}.${field}.`,
            );
    };
    const validateSql = (text: string) => {
      for (const match of text.matchAll(TABLE_SQL_PLACEHOLDER))
        column(match[1]!);
    };
    validateExpressions(table, column, target, validateSql);
    for (const fk of table.foreignKeys) {
      fk.columns.forEach(column);
      if (fk.columns.length !== fk.references.length)
        throw new EntityDeclarationError(
          `${fk.name} has mismatched FK columns.`,
        );
      target(fk.table, fk.references);
    }
    for (const relation of table.relations) {
      (relation.fields ?? []).forEach(column);
      if ((relation.fields?.length ?? 0) !== (relation.references?.length ?? 0))
        throw new EntityDeclarationError(
          `${table.name}.${relation.name} has mismatched relation columns.`,
        );
      target(relation.table, relation.references ?? []);
    }
  }
  return tables;
};
