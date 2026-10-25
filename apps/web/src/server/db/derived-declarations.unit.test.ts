import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { storedDerivedDeclarations } from "~/server/db/derived-declarations";
import * as schema from "~/server/db/schema";

// PL/pgSQL resolves trigger column references when a row fires, not when the
// trigger is created: a misspelled declared column would fail every save to
// that table in production. Every name a declaration hands the generated
// triggers and the drain must exist in the Drizzle schema.
const tables: PgTable[] = [];
for (const value of Object.values<unknown>(schema))
  if (is(value, PgTable)) tables.push(value);
const columnsByTable = new Map(
  tables.map((table) => [
    getTableName(table),
    new Set(Object.values(getTableColumns(table)).map((column) => column.name)),
  ]),
);

const missing = (table: string, columns: readonly string[]) => {
  const known = columnsByTable.get(table);
  if (!known) return [`${table} (table)`];
  return columns
    .filter((column) => !known.has(column))
    .map((c) => `${table}.${c}`);
};

describe("stored derived declarations", () => {
  it("name only real tables and columns", () => {
    const problems = storedDerivedDeclarations().flatMap((declaration) => [
      ...missing(declaration.table, ["id"]),
      ...declaration.inputs.flatMap((input) => [
        ...(input.path ?? []).flatMap((step) =>
          missing(step.table, [
            step.from,
            step.to,
            ...Object.keys(step.where ?? {}),
          ]),
        ),
        ...missing(input.table, [
          input.tableColumn,
          ...(input.columns ?? []),
          ...Object.keys(input.where ?? {}),
        ]),
        ...missing(declaration.table, [input.entityColumn]),
      ]),
      ...declaration.dependsOn.flatMap((dependency) =>
        "path" in dependency
          ? dependency.path.flatMap((step) =>
              missing(step.table, [step.from, step.to]),
            )
          : "through" in dependency
            ? missing(dependency.through.table, [
                dependency.through.source,
                dependency.through.dependent,
                ...Object.keys(dependency.through.where ?? {}),
              ])
            : [
                ...missing(declaration.table, [dependency.entityColumn]),
                ...(storedDerivedDeclarations()
                  .filter(
                    (source) =>
                      source.entity === dependency.entity &&
                      source.key === dependency.key,
                  )
                  .flatMap((source) =>
                    missing(source.table, [dependency.sourceColumn]),
                  ) ?? []),
              ],
      ),
    ]);
    expect([...new Set(problems)]).toEqual([]);
  });

  it("depend only on declared stored values", () => {
    const targets = new Set(
      storedDerivedDeclarations().map((declaration) => declaration.target),
    );
    const unknown = storedDerivedDeclarations().flatMap((declaration) =>
      declaration.dependsOn
        .map((dependency) => `${dependency.entity}.${dependency.key}`)
        .filter((target) => !targets.has(target)),
    );
    expect(unknown).toEqual([]);
  });
});
