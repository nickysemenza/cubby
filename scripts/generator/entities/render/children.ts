import type { ChildTableMetadata } from "../../../../packages/schemas/src/entity-definitions/child-definition.ts";
import { TABLE_SQL_PLACEHOLDER } from "../table-storage.ts";

const escapeTemplate = (value: string) =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${");
const sqlTemplate = (value: string) => {
  let rendered = "";
  let cursor = 0;
  for (const match of value.matchAll(TABLE_SQL_PLACEHOLDER)) {
    rendered += `${escapeTemplate(value.slice(cursor, match.index))}\${table.${match[1]}}`;
    cursor = match.index + match[0].length;
  }
  return `sql\`${rendered}${escapeTemplate(value.slice(cursor))}\``;
};
const actions = (ref: { onDelete?: string; onUpdate?: string }) =>
  Object.fromEntries(
    Object.entries(ref).filter(
      ([key]) => key === "onDelete" || key === "onUpdate",
    ),
  );

export const childTableDependencies = (
  tables: readonly ChildTableMetadata[],
) => [
  ...new Set(
    tables.flatMap((table) => [
      ...table.columns.flatMap((column) =>
        column.reference ? [column.reference.table] : [],
      ),
      ...table.foreignKeys.map((fk) => fk.table),
      ...table.relations.map((relation) => relation.table),
    ]),
  ),
];

export const renderChildTables = (
  tables: readonly ChildTableMetadata[],
): string =>
  tables
    .map((table) => {
      const columns = table.columns.map((column) => {
        const options =
          column.kind === "timestamp"
            ? ',{mode:"date"}'
            : column.kind === "date"
              ? ',{mode:"string"}'
              : column.kind === "bigint"
                ? ',{mode:"number"}'
                : column.values
                  ? `,{enum:${JSON.stringify(column.values)}}`
                  : "";
        let value = `${column.kind}(${JSON.stringify(column.name ?? column.key)}${options})`;
        if (column.array) value += ".array()";
        if (column.primaryKey) value += ".primaryKey()";
        if (column.notNull) value += ".notNull()";
        if (column.type) value += `.$type<${column.type}>()`;
        if (column.default !== undefined)
          value +=
            column.default.kind === "now"
              ? ".defaultNow()"
              : column.default.kind === "sql"
                ? `.default(${sqlTemplate(column.default.sql)})`
                : `.default(${JSON.stringify(column.default.value)})`;
        if (column.onUpdateNow) value += ".$onUpdate(() => new Date())";
        if (column.reference) {
          const policy = actions(column.reference);
          value += `.references((): AnyPgColumn => ${column.reference.table}.${column.reference.column}${Object.keys(policy).length ? `, ${JSON.stringify(policy)}` : ""})`;
        }
        return `${JSON.stringify(column.key)}:${value}`;
      });
      const constraints = [
        ...table.indexes.map((index) => {
          const parts = index.on.map((part) =>
            "column" in part
              ? `table.${part.column}${part.desc ? ".desc()" : ""}`
              : sqlTemplate(part.sql),
          );
          return `${index.unique ? "uniqueIndex" : "index"}(${JSON.stringify(index.name)})${index.using ? `.using("gin", ${parts.join(", ")})` : `.on(${parts.join(", ")})`}${index.where ? `.where(${sqlTemplate(index.where)})` : ""}`;
        }),
        ...table.checks.map(
          (check) =>
            `check(${JSON.stringify(check.name)},${sqlTemplate(check.sql)})`,
        ),
        ...table.foreignKeys.map(
          (fk) =>
            `foreignKey({name:${JSON.stringify(fk.name)},columns:[${fk.columns.map((key) => `table.${key}`).join(",")}],foreignColumns:[${fk.references.map((key) => `${fk.table}.${key}`).join(",")}]})${fk.onDelete ? `.onDelete(${JSON.stringify(fk.onDelete)})` : ""}${fk.onUpdate ? `.onUpdate(${JSON.stringify(fk.onUpdate)})` : ""}`,
        ),
      ];
      const relations = table.relations.length
        ? `\nexport const ${table.exportName}Relations = relations(${table.exportName}, ({ ${[...new Set(table.relations.map(({ kind }) => kind))].join(", ")} }) => ({${table.relations.map((relation) => `${JSON.stringify(relation.name)}:${relation.kind}(${relation.table}${relation.fields ? `,{fields:[${relation.fields.map((key) => `${table.exportName}.${key}`).join(",")}],references:[${relation.references!.map((key) => `${relation.table}.${key}`).join(",")}]${relation.relationName ? `,relationName:${JSON.stringify(relation.relationName)}` : ""}}` : relation.relationName ? `,{relationName:${JSON.stringify(relation.relationName)}}` : ""})`).join(",")}}));`
        : "";
      return `export const ${table.exportName} = pgTable(${JSON.stringify(table.name)},{${columns.join(",")}},(table)=>[${constraints.join(",")}]);${relations}`;
    })
    .join("\n\n");
