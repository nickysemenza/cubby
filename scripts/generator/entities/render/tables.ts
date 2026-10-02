import { generatedHeader } from "../../artifacts.ts";
import {
  childTableMetadataSchema,
  type ChildTableDeclaration,
} from "../../../../packages/schemas/src/entity-definitions/child-definition.ts";
import { validateChildTables } from "../child-tables.ts";
import { retainedTableExports } from "../../../../packages/schemas/src/child-tables/retained.ts";
import { childTableDependencies, renderChildTables } from "./children.ts";
import type {
  CompiledEntity,
  CompiledEntityTable,
  EntityTableColumn,
  EntityTableIndex,
  EntityTableRelation,
} from "../declarations.ts";
import { TABLE_SQL_PLACEHOLDER } from "../table-storage.ts";
import {
  identifierTypeNames,
  renderStorageColumn,
  storageColumnImports,
} from "./columns.ts";

type TabledEntity = CompiledEntity & { table: CompiledEntityTable };

const escapeTemplate = (text: string) =>
  text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");

/** Declared table SQL as a Drizzle `sql` template bound to `table` columns. */
const sqlTemplate = (text: string) => {
  let rendered = "";
  let cursor = 0;
  for (const match of text.matchAll(TABLE_SQL_PLACEHOLDER)) {
    rendered += `${escapeTemplate(text.slice(cursor, match.index))}\${table.${match[1]}}`;
    cursor = match.index + match[0].length;
  }
  return `sql\`${rendered}${escapeTemplate(text.slice(cursor))}\``;
};

const columnBuilders = {
  text: "text",
  identifier: "uuid",
  timestamp: "timestamp",
  json: "jsonb",
} as const;

const renderTableColumn = (
  column: EntityTableColumn,
  exportOf: (entity: string) => string,
) => {
  const name = JSON.stringify(column.key);
  let expression =
    column.kind === "timestamp"
      ? `timestamp(${name},{mode:"date"})`
      : `${columnBuilders[column.kind]}(${name})`;
  if (column.notNull) expression += ".notNull()";
  if (column.type !== null) expression += `.$type<${column.type.export}>()`;
  if (column.defaultValue !== null)
    expression += `.default(${JSON.stringify(column.defaultValue)})`;
  if (column.reference !== null)
    expression += `.references((): AnyPgColumn => ${column.reference === "user" ? "user" : exportOf(column.reference)}.id)`;
  return `${name}:${expression}`;
};

const renderIndex = (index: EntityTableIndex) => {
  const parts = index.on.map((part) =>
    "sql" in part
      ? sqlTemplate(part.sql)
      : `table.${part.column}${part.desc ? ".desc()" : ""}`,
  );
  const builder = `${index.unique ? "uniqueIndex" : "index"}(${JSON.stringify(index.name)})`;
  const columns =
    index.using === "gin"
      ? `.using("gin", ${parts.join(", ")})`
      : `.on(${parts.join(", ")})`;
  const where =
    index.where === null ? "" : `.where(${sqlTemplate(index.where)})`;
  return `${builder}${columns}${where}`;
};

const renderTable = (
  entity: TabledEntity,
  exportOf: (entity: string) => string,
) => {
  const { table } = entity;
  const reference = (target: string) =>
    `(): AnyPgColumn => ${exportOf(target)}.id`;
  const columns = [
    ...entity.fieldModel.storage.map((field) =>
      renderStorageColumn(entity, field, reference),
    ),
    ...table.columns.map((column) => renderTableColumn(column, exportOf)),
  ];
  const hasShortcode = entity.fieldModel.storage.some(
    ({ key }) => key === "shortcode",
  );
  const constraints = [
    // Whole-table on purpose, soft-deleted rows included: a code is never
    // reused, so a deleted row's code stays a permanent tombstone. A partial
    // `deletedAt IS NULL` index would hand it to a second entity.
    ...(hasShortcode
      ? [
          `uniqueIndex(${JSON.stringify(`${table.name}_shortcode_unique`)}).on(table.shortcode)`,
          `entityIdentityFk(${JSON.stringify(table.name)}, table)`,
        ]
      : []),
    ...table.indexes.map(renderIndex),
    ...table.checks.map(
      (check) =>
        `check(${JSON.stringify(check.name)}, ${check.bare ? `sql.raw(${JSON.stringify(check.sql)})` : sqlTemplate(check.sql)})`,
    ),
  ];
  return `export const ${table.exportName} = pgTable(${JSON.stringify(table.name)}, {${columns.join(",")}}, (table) => [${constraints.join(",")}]);`;
};

const renderRelations = (
  table: CompiledEntityTable,
  exportOf: (entity: string) => string,
) => {
  const targetOf = (relation: EntityTableRelation) =>
    "entity" in relation.target
      ? exportOf(relation.target.entity)
      : relation.target.table;
  const helpers = [...new Set(table.relations.map(({ kind }) => kind))].sort();
  const entries = table.relations.map((relation) => {
    const target = targetOf(relation);
    if (relation.kind === "many")
      return `${relation.name}: many(${target}${relation.relationName === null ? "" : `, { relationName: ${JSON.stringify(relation.relationName)} }`})`;
    if (relation.fields.length === 0) return `${relation.name}: one(${target})`;
    const config = [
      `fields: [${relation.fields.map((field) => `${table.exportName}.${field}`).join(", ")}]`,
      `references: [${relation.references.map((column) => `${target}.${column}`).join(", ")}]`,
      ...(relation.relationName === null
        ? []
        : [`relationName: ${JSON.stringify(relation.relationName)}`]),
    ];
    return `${relation.name}: one(${target}, { ${config.join(", ")} })`;
  });
  return `export const ${table.exportName}Relations = relations(${table.exportName}, ({ ${helpers.join(", ")} }) => ({${entries.join(",")}}));`;
};

/**
 * Every entity's complete Drizzle table and relational-query relations,
 * from its declaration's `model.storage` + `storage`. `schema.ts` re-exports
 * this module; child tables that entity relations name are imported back
 * from it, a cycle that is safe only because every cross-table reference
 * here (FK thunks, extra-config callbacks, `relations()` callbacks) is lazy.
 */
export const renderEntityTablesArtifact = (
  entities: readonly CompiledEntity[],
  moduleChildren: readonly ChildTableDeclaration[] = [],
): string => {
  const tabled = entities.filter(
    (entity): entity is TabledEntity => entity.table !== null,
  );
  const exports = new Map(
    tabled.map((entity) => [entity.key, entity.table.exportName]),
  );
  const exportOf = (entity: string) => {
    const name = exports.get(entity);
    if (name === undefined)
      throw new Error(`Entity ${entity} has no generated table.`);
    return name;
  };
  const declaredChildren = validateChildTables(
    [
      ...entities.flatMap((entity) => entity.children),
      ...moduleChildren.map((child) => childTableMetadataSchema.parse(child)),
    ],
    new Set([
      ...exports.values(),
      ...retainedTableExports,
      "user",
      "entityIdentity",
    ]),
  );
  const tableNames = new Set(tabled.map(({ table }) => table.name));
  for (const child of declaredChildren)
    if (tableNames.has(child.name))
      throw new Error(`Duplicate table ${child.name}.`);
  const tableExports = new Set([
    ...exports.values(),
    ...declaredChildren.map((table) => table.exportName),
  ]);
  const childTables = [
    ...new Set([
      ...childTableDependencies(declaredChildren).filter(
        (name) =>
          !tableExports.has(name) &&
          name !== "user" &&
          name !== "entityIdentity",
      ),
      ...tabled.flatMap(({ table }) =>
        table.relations.flatMap((relation) =>
          "table" in relation.target && !tableExports.has(relation.target.table)
            ? [relation.target.table]
            : [],
        ),
      ),
    ]),
  ].sort();
  const identifierTypes = new Set<string>(Object.values(identifierTypeNames));
  const typeImports = new Map<string, Set<string>>();
  for (const table of declaredChildren)
    for (const { module, exports: names } of table.types)
      for (const name of names) {
        if (
          module === "@cubby/schemas/identifiers" &&
          identifierTypes.has(name)
        )
          continue;
        const imports = typeImports.get(module) ?? new Set<string>();
        imports.add(name);
        typeImports.set(module, imports);
      }
  for (const { table } of tabled)
    for (const { type } of table.columns) {
      if (type === null) continue;
      if (
        type.module === "@cubby/schemas/identifiers" &&
        identifierTypes.has(type.export)
      )
        continue;
      const names = typeImports.get(type.module) ?? new Set<string>();
      names.add(type.export);
      typeImports.set(type.module, names);
    }
  const usesUser =
    childTableDependencies(declaredChildren).includes("user") ||
    tabled.some(({ table }) =>
      table.columns.some(({ reference }) => reference === "user"),
    );
  return (
    generatedHeader +
    "// Import through `~/server/db/schema`, never directly: the cycle with\n" +
    "// schema.ts only resolves when schema.ts is the first module loaded.\n\n" +
    storageColumnImports +
    [...typeImports]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([module, names]) =>
          `import type { ${[...names].sort().join(", ")} } from ${JSON.stringify(module)};\n`,
      )
      .join("") +
    'import { relations, sql } from "drizzle-orm";\n' +
    'import { type AnyPgColumn, bigint, boolean, check, date, doublePrecision, foreignKey, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";\n\n' +
    (usesUser ? 'import { user } from "../auth.schema";\n' : "") +
    'import { entityIdentity, entityIdentityFk } from "../entity-identity-schema";\n' +
    (childTables.length === 0
      ? ""
      : `import { ${childTables.join(", ")} } from "../schema";\n`) +
    "\n" +
    tabled.map((entity) => renderTable(entity, exportOf)).join("\n\n") +
    "\n\n" +
    renderChildTables(declaredChildren) +
    "\n\n" +
    tabled
      .filter(({ table }) => table.relations.length > 0)
      .map(({ table }) => renderRelations(table, exportOf))
      .join("\n\n") +
    "\n"
  );
};
