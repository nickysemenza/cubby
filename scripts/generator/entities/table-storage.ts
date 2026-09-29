import { z } from "zod";

import type { EntityDeclarationMetadata } from "../../../packages/schemas/src/entity-definitions/definition.ts";
import {
  type CompiledEntity,
  type CompiledEntityTable,
  EntityDeclarationError,
  type EntityFieldModel,
  type EntityTableCheck,
  type EntityTableColumn,
  type EntityTableIndex,
  type EntityTableRelation,
} from "./declarations.ts";

/** `{columnKey}` placeholders in declared table SQL. */
export const TABLE_SQL_PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const lowerFirst = (value: string) =>
  `${value[0]?.toLowerCase() ?? ""}${value.slice(1)}`;

/** The enum a declared read schema narrows to, through optional/nullable/default. */
const readEnumValues = (
  fieldModel: EntityFieldModel,
  key: string,
  context: string,
): readonly string[] => {
  let read: unknown = fieldModel.fields.find((field) => field.key === key)
    ?.validation.read;
  while (
    read instanceof z.ZodOptional ||
    read instanceof z.ZodNullable ||
    read instanceof z.ZodDefault
  )
    read = read.unwrap();
  if (!(read instanceof z.ZodEnum))
    throw new EntityDeclarationError(
      `${context} needs explicit values: ${key} has no declared read enum.`,
    );
  return read.options.map(String);
};

/**
 * Compile `storage` (the table facts beyond model columns) against the
 * entity's stored columns. Every `{column}` placeholder, index column,
 * reference opt-out, and relation field must name a real column, so a
 * renamed column fails generation instead of emitting a broken table.
 */
export const compileEntityTable = (
  declaration: EntityDeclarationMetadata,
  fieldModel: EntityFieldModel,
  context: string,
): CompiledEntityTable | null => {
  const storage = declaration.storage;
  const tableContext = `${context}.storage`;
  if (declaration.table === null) {
    if (storage !== undefined)
      throw new EntityDeclarationError(
        `${tableContext} is declared but the entity has no table.`,
      );
    return null;
  }
  if (fieldModel.storage.length === 0)
    throw new EntityDeclarationError(
      `${context}.model.storage must declare the columns of table ${declaration.table}.`,
    );
  const name = declaration.table;
  const declared = storage ?? {
    columns: [],
    indexes: [],
    checks: [],
    unindexedReferences: {},
    relations: {},
  };

  const columns: EntityTableColumn[] = declared.columns.map((column) => ({
    key: column.key,
    kind: column.kind,
    notNull: column.notNull === true,
    defaultValue: column.defaultValue ?? null,
    reference: column.reference ?? null,
    type: column.type ?? null,
  }));
  /** Column key → SQL column name, model columns first. */
  const columnNames = new Map<string, string>();
  const references = new Map<string, string>();
  for (const field of fieldModel.storage) {
    if (field.specialized === "amount-columns") {
      for (const suffix of ["Value", "Unit"]) {
        columnNames.set(`${field.key}${suffix}`, `${field.column}${suffix}`);
      }
      continue;
    }
    columnNames.set(field.key, field.column);
    if (field.reference !== null) references.set(field.key, field.reference);
  }
  for (const column of columns) {
    if (columnNames.has(column.key))
      throw new EntityDeclarationError(
        `${tableContext}.columns.${column.key} duplicates a model storage column.`,
      );
    columnNames.set(column.key, column.key);
    if (column.reference !== null) references.set(column.key, column.reference);
  }
  const columnName = (key: string, where: string) => {
    const column = columnNames.get(key);
    if (column === undefined)
      throw new EntityDeclarationError(
        `${where} names ${key}, which is not a column of ${name}.`,
      );
    return column;
  };
  const checkSql = (sql: string, where: string) => {
    for (const [, key] of sql.matchAll(TABLE_SQL_PLACEHOLDER))
      columnName(key!, where);
    return sql;
  };

  const indexes: EntityTableIndex[] = declared.indexes.map((index, i) => {
    const where = `${tableContext}.indexes[${i}]`;
    if ("trigram" in index)
      return {
        name: `${name}_${columnName(index.trigram, where)}_gin_idx`,
        unique: false,
        using: "gin",
        on: [{ sql: `{${index.trigram}} gin_trgm_ops` }],
        where: null,
      };
    const on = index.on.map((part): EntityTableIndex["on"][number] =>
      "sql" in part
        ? { sql: checkSql(part.sql, where) }
        : { column: part.column, desc: part.desc },
    );
    const plainColumns = on.flatMap((part) =>
      "column" in part ? [columnName(part.column, where)] : [],
    );
    if (index.name === undefined && plainColumns.length !== on.length)
      throw new EntityDeclarationError(
        `${where} indexes an expression and must be named.`,
      );
    return {
      name:
        index.name ??
        `${name}_${plainColumns.join("_")}_${index.unique ? "key" : "idx"}`,
      unique: index.unique === true,
      using: index.using ?? "btree",
      on,
      where: index.where === undefined ? null : checkSql(index.where, where),
    };
  });

  // Only a full (non-partial) index serves the FK's lookups on every row.
  const leadingColumns = new Set(
    indexes.flatMap(({ on, where }) => {
      const first = on[0];
      return where === null && first !== undefined && "column" in first
        ? [first.column]
        : [];
    }),
  );
  for (const [key, reason] of Object.entries(declared.unindexedReferences)) {
    const where = `${tableContext}.unindexedReferences.${key}`;
    if (!references.has(key))
      throw new EntityDeclarationError(`${where} is not a reference column.`);
    if (leadingColumns.has(key))
      throw new EntityDeclarationError(
        `${where} is stale: a declared full index already leads with it.`,
      );
    if (!reason.trim())
      throw new EntityDeclarationError(`${where} must give a reason.`);
  }
  for (const key of references.keys()) {
    if (leadingColumns.has(key) || key in declared.unindexedReferences)
      continue;
    const column = columnName(key, tableContext);
    indexes.push({
      name: `${name}_${column}_idx`,
      unique: false,
      using: "btree",
      on: [{ column: key, desc: false }],
      where: null,
    });
  }

  const checks: EntityTableCheck[] = declared.checks.map((check, i) => {
    const where = `${tableContext}.checks[${i}]`;
    if ("sql" in check)
      return { name: check.name, sql: checkSql(check.sql, where), bare: false };
    const column = columnName(check.column, where);
    const values =
      check.values ??
      readEnumValues(fieldModel, check.column, `${where}.values`);
    const inList = `{${check.column}} IN (${values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ")})`;
    const sql = check.nullClause
      ? `{${check.column}} IS NULL OR ${inList}`
      : inList;
    const bare = check.bare === true;
    return {
      name: check.name ?? `${name}_${column}_check`,
      // A bare check is rendered verbatim, so its placeholders resolve here.
      sql: bare
        ? sql.replaceAll(
            TABLE_SQL_PLACEHOLDER,
            (_, key: string) => `"${columnName(key, where)}"`,
          )
        : sql,
      bare,
    };
  });

  const relations: EntityTableRelation[] = Object.entries(
    declared.relations,
  ).map(([relation, value]) => {
    const where = `${tableContext}.relations.${relation}`;
    const referenceOne = (field: string, relationName: string | null) => {
      const target = references.get(field);
      if (target === undefined || target === "user")
        throw new EntityDeclarationError(
          `${where} names ${field}, which does not reference an entity.`,
        );
      return {
        kind: "one" as const,
        name: relation,
        target: { entity: target },
        fields: [field],
        references: ["id"],
        relationName,
      };
    };
    if ("many" in value)
      return {
        kind: "many",
        name: relation,
        target: { table: value.many },
        relationName: value.relationName ?? null,
      };
    if (!("one" in value))
      return referenceOne(value.field, value.relationName ?? null);
    if ((value.field === undefined) !== (value.references === undefined))
      throw new EntityDeclarationError(
        `${where} must declare both field and references, or neither.`,
      );
    if (value.field !== undefined) columnName(value.field, where);
    return {
      kind: "one",
      name: relation,
      target: { table: value.one },
      fields: value.field === undefined ? [] : [value.field],
      references: value.references === undefined ? [] : [value.references],
      relationName: null,
    };
  });

  const indexNames = indexes.map((index) => index.name);
  const duplicate = indexNames.find(
    (indexName, i) => indexNames.indexOf(indexName) !== i,
  );
  if (duplicate !== undefined)
    throw new EntityDeclarationError(
      `${tableContext} declares index ${duplicate} twice.`,
    );
  return {
    name,
    exportName: lowerFirst(name),
    columns,
    indexes,
    checks,
    relations,
  };
};

/** A table's every FK must target an entity with a table (or `user`). */
export const validateEntityTables = (entities: readonly CompiledEntity[]) => {
  const tables = new Set(
    entities.flatMap((entity) => (entity.table === null ? [] : [entity.key])),
  );
  for (const entity of entities) {
    if (entity.table === null) continue;
    const references = [
      ...entity.fieldModel.storage.flatMap(({ reference }) =>
        reference === null ? [] : [reference],
      ),
      ...entity.table.columns.flatMap(({ reference }) =>
        reference === null || reference === "user" ? [] : [reference],
      ),
    ];
    for (const reference of references)
      if (!tables.has(reference))
        throw new EntityDeclarationError(
          `${entity.key} references ${reference}, which has no table.`,
        );
  }
};
