import type { ChildTableMetadata } from "@cubby/schemas/compiler/entity-definitions/child-definition";
import { sqlTemplate, TABLE_SQL_PLACEHOLDER } from "../table-storage.ts";

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
  entityReferences: ReadonlyMap<string, string> = new Map(),
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
                ? `,{mode:${JSON.stringify(column.bigintMode ?? "number")}}`
                : column.values
                  ? `,{enum:${JSON.stringify(column.values)}}`
                  : "";
        let value = `${column.kind}(${JSON.stringify(column.name ?? column.key)}${options})`;
        if (column.array) value += ".array()";
        if (column.primaryKey) value += ".primaryKey()";
        if (column.notNull) value += ".notNull()";
        if (column.type) value += `.$type<${column.type}>()`;
        else if (column.kind === "uuid" && column.reference?.column === "id") {
          const target = entityReferences.get(column.reference.table);
          if (target !== undefined)
            value += `.$type<EntityId<${JSON.stringify(target)}>>()`;
        }
        if (column.default !== undefined)
          value +=
            column.default.kind === "now"
              ? ".defaultNow()"
              : column.default.kind === "sql"
                ? `.default(${sqlTemplate(column.default.sql)})`
                : `.default(${JSON.stringify(column.default.value)})`;
        if (column.generated) {
          const expression = column.generated.replace(
            TABLE_SQL_PLACEHOLDER,
            (_, key: string) =>
              JSON.stringify(
                table.columns.find((field) => field.key === key)!.name ?? key,
              ),
          );
          value += `.generatedAlwaysAs(${sqlTemplate(expression)})`;
        }
        if (column.onUpdateNow) value += ".$onUpdate(() => new Date())";
        return `${JSON.stringify(column.key)}:${value}`;
      });
      const constraints = [
        ...table.columns.flatMap((column) => {
          const ref = column.reference;
          if (!ref) return [];
          return [
            `foreignKey({name:[${JSON.stringify(table.name)}, ${JSON.stringify(column.name ?? column.key)},getTableName(${ref.table}),${JSON.stringify(ref.column)},"fk"].join("_").slice(0,63),columns:[table.${column.key}],foreignColumns:[${ref.table}.${ref.column}]})${ref.onDelete ? `.onDelete(${JSON.stringify(ref.onDelete)})` : ""}${ref.onUpdate ? `.onUpdate(${JSON.stringify(ref.onUpdate)})` : ""}`,
          ];
        }),

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
      return `export const ${table.exportName} = pgTable(${JSON.stringify(table.name)},{${columns.join(",")}},(${constraints.some((constraint) => /\btable\b/.test(constraint)) ? "table" : "_table"}):PgTableExtraConfigValue[]=>[${constraints.join(",")}]);`;
    })
    .join("\n\n");

/**
 * To-many relations into soft-deletable tables load live rows only, so nested
 * reads never repeat the liveness filter. To-one relations stay unfiltered: a
 * deleted parent still resolves, and readers decide how to present it.
 */
export const liveRelationWhere = "where: { deletedAt: { isNull: true } }";

export const renderChildRelations = (
  tables: readonly ChildTableMetadata[],
  softDeleted: ReadonlySet<string>,
): string =>
  tables
    .filter((table) => table.relations.length > 0)
    .map(
      (table) =>
        `${table.exportName}: {${table.relations
          .map((relation) => {
            const config = [
              ...(relation.fields
                ? [
                    `from:[${relation.fields.map((key) => `r.${table.exportName}.${key}`).join(",")}]`,
                    `to:[${relation.references!.map((key) => `r.${relation.table}.${key}`).join(",")}]`,
                    ...(relation.kind === "one" &&
                    relation.fields.every(
                      (key) =>
                        table.columns.find((column) => column.key === key)
                          ?.notNull,
                    )
                      ? ["optional:false"]
                      : []),
                  ]
                : []),
              ...(relation.relationName
                ? [`alias:${JSON.stringify(relation.relationName)}`]
                : []),
              ...(relation.kind === "many" && softDeleted.has(relation.table)
                ? [liveRelationWhere]
                : []),
            ];
            return `${JSON.stringify(relation.name)}:r.${relation.kind}.${relation.table}({${config.join(",")}})`;
          })
          .join(",")}}`,
    )
    .join(",\n");
