import { generatedHeader } from "../../artifacts.ts";
import {
  childTableMetadataSchema,
  type ChildTableDeclaration,
} from "../../../../../packages/schemas/src/entity-definitions/child-definition.ts";
import { validateChildTables } from "../child-tables.ts";
import { retainedTableExports } from "../../../../../packages/schemas/src/child-tables/retained.ts";
import {
  childTableDependencies,
  renderChildTables,
  renderChildRelations,
} from "./children.ts";
import type {
  CompiledEntity,
  CompiledEntityTable,
  EntityTableColumn,
  EntityTableIndex,
  EntityTableRelation,
} from "../declarations.ts";
import {
  TABLE_SQL_PLACEHOLDER,
  validateEntityTables,
} from "../table-storage.ts";
import {
  identifierTypeNames,
  renderStorageColumn,
  referencedImports,
  storageColumnImportsFor,
} from "./columns.ts";

type TabledEntity = CompiledEntity & { table: CompiledEntityTable };

const identifierTypes = new Set<string>(Object.values(identifierTypeNames));
const declaredColumnTypeImports = (
  tables: readonly TabledEntity[],
  imports = new Map<string, Set<string>>(),
): Map<string, Set<string>> => {
  for (const { table } of tables)
    for (const { type } of table.columns) {
      if (
        type === null ||
        (type.module === "@cubby/schemas/identifiers" &&
          identifierTypes.has(type.export))
      )
        continue;
      const names = imports.get(type.module) ?? new Set<string>();
      names.add(type.export);
      imports.set(type.module, names);
    }
  return imports;
};

const renderTypeImports = (
  imports: ReadonlyMap<string, ReadonlySet<string>>,
): string =>
  [...imports]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([module, names]) =>
        `import type { ${[...names].sort().join(", ")} } from ${JSON.stringify(module)};\n`,
    )
    .join("");

// Compilation ownership roots; actual FK dependencies determine the closed group.
const identityStorageRoots = ["product", "vendor"] as const;

export const tableDependencyClosure = (
  entities: readonly CompiledEntity[],
  roots: readonly string[],
): readonly TabledEntity[] => {
  const tables = new Map(
    entities
      .filter((entity): entity is TabledEntity => entity.table !== null)
      .map((entity) => [entity.key, entity]),
  );
  const owned = new Set(roots.filter((key) => tables.has(key)));
  for (const key of owned) {
    const entity = tables.get(key)!;
    const dependencies = [
      ...entity.fieldModel.storage.map((field) => field.reference),
      ...entity.table.columns.map((column) => column.reference),
    ];
    for (const target of dependencies) {
      if (target === null) continue;
      if (!tables.has(target))
        throw new Error(
          `Storage table group ${key} has an external FK to ${target}.`,
        );
      owned.add(target);
    }
  }
  return entities.filter(
    (entity): entity is TabledEntity =>
      owned.has(entity.key) && entity.table !== null,
  );
};

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
  return `export const ${table.exportName} = pgTable(${JSON.stringify(table.name)}, {${columns.join(",")}}, (${constraints.some((constraint) => /\btable\b/.test(constraint)) ? "table" : "_table"}) => [${constraints.join(",")}]);`;
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

/** Canonical definitions and downstream relational assembly share one render context. */
export const renderEntityTableArtifacts = (
  entities: readonly CompiledEntity[],
  moduleChildren: readonly ChildTableDeclaration[] = [],
) => {
  validateEntityTables(entities, moduleChildren);
  const tabled = entities.filter(
    (entity): entity is TabledEntity => entity.table !== null,
  );
  const identityTables = tableDependencyClosure(entities, identityStorageRoots);
  const identityKeys = new Set(identityTables.map((entity) => entity.key));
  const identityExports = identityTables.map(
    (entity) => entity.table.exportName,
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
  for (const child of declaredChildren)
    exports.set(child.exportName, child.exportName);
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
  declaredColumnTypeImports(
    tabled.filter((entity) => !identityKeys.has(entity.key)),
    typeImports,
  );
  const ownedDefinitions = tabled
    .filter((entity) => !identityKeys.has(entity.key))
    .map((entity) => renderTable(entity, exportOf))
    .join("\n\n");
  const childDefinitions = renderChildTables(declaredChildren);
  const definitionSource = ownedDefinitions + "\n\n" + childDefinitions;
  const relationSource =
    tabled
      .filter(({ table }) => table.relations.length > 0)
      .map(({ table }) => renderRelations(table, exportOf))
      .join("\n\n") +
    "\n\n" +
    renderChildRelations(declaredChildren);
  const retainedImports = childTables.length
    ? `import { ${childTables.join(", ")} } from "~/server/db/retained-tables";\n`
    : "";
  const sharedImports =
    'import { user } from "~/server/db/auth.schema";\n' +
    'import { entityIdentity, entityIdentityFk } from "~/server/db/entity-identity-schema";\n';
  const definitions =
    generatedHeader +
    storageColumnImportsFor(definitionSource, renderTypeImports(typeImports)) +
    referencedImports(
      'import { sql } from "drizzle-orm";\n' +
        'import { type AnyPgColumn, bigint, boolean, check, date, doublePrecision, foreignKey, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";\n' +
        sharedImports +
        retainedImports,
      definitionSource,
    ) +
    (identityExports.length
      ? `import { ${identityExports.join(", ")} } from "~/server/db/generated/identity-storage-tables.gen";\nexport { ${identityExports.join(", ")} };\n`
      : "") +
    "\n" +
    definitionSource +
    "\n";
  const relations =
    generatedHeader +
    'export * from "~/server/db/generated/entity-table-definitions.gen";\n' +
    'import { relations } from "drizzle-orm";\n' +
    referencedImports(
      `import { ${[...tableExports].sort().join(", ")} } from "~/server/db/generated/entity-table-definitions.gen";\n` +
        sharedImports +
        retainedImports,
      relationSource,
    ) +
    "\n" +
    relationSource +
    "\n";
  return { definitions, relations };
};

/** Canonical FK-closed definitions; relations remain in the full assembly. */
export const renderIdentityStorageTablesArtifact = (
  entities: readonly CompiledEntity[],
): string => {
  const tables = tableDependencyClosure(entities, identityStorageRoots);
  const names = new Map(
    tables.map((entity) => [entity.key, entity.table.exportName]),
  );
  const source = tables
    .map((entity) =>
      renderTable(entity, (target) => {
        const name = names.get(target);
        if (!name)
          throw new Error(
            `Identity storage references unowned table ${target}.`,
          );
        return name;
      }),
    )
    .join("\n\n");
  return (
    generatedHeader +
    storageColumnImportsFor(
      source,
      renderTypeImports(declaredColumnTypeImports(tables)),
    ) +
    'import { sql } from "drizzle-orm";\n' +
    referencedImports(
      'import { type AnyPgColumn, bigint, boolean, check, date, doublePrecision, foreignKey, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";\n',
      source,
    ) +
    'import { entityIdentityFk } from "~/server/db/entity-identity-schema";\n\n' +
    source +
    "\n"
  );
};
