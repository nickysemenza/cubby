import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable, PgUUID } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  storedDerivedDeclarations,
  type DerivedPathStep,
} from "~/server/db/derived-declarations";
import { derivedTriggerDdl } from "~/server/db/derived-trigger-ddl";
import { drizzleSchema as schema } from "~/server/db/drizzle-schema";

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
    new Map(
      Object.values(getTableColumns(table)).map((column) => [
        column.name,
        column,
      ]),
    ),
  ]),
);

const missing = (table: string, columns: readonly string[]) => {
  const known = columnsByTable.get(table);
  if (!known) return [`${table} (table)`];
  return columns
    .filter((column) => !known.has(column))
    .map((c) => `${table}.${c}`);
};

const missingPath = (path: readonly DerivedPathStep[]) =>
  path.flatMap((step) => [
    ...missing(step.table, [
      step.from,
      step.to,
      ...Object.keys(step.where ?? {}),
    ]),
    ...(step.recursive
      ? [step.from, step.to].flatMap((name) => {
          const column = columnsByTable.get(step.table)?.get(name);
          return column && is(column, PgUUID)
            ? []
            : [`${step.table}.${name} (recursive UUID)`];
        })
      : []),
  ]);

describe("stored derived declarations", () => {
  it("keeps current automatic ownership out of the derived cache and trigger targets", () => {
    expect(
      storedDerivedDeclarations().filter(
        (entry) => entry.key === "automaticFields",
      ),
    ).toEqual([]);
    expect(derivedTriggerDdl()).not.toContain("automaticFields");
  });
  it("name only real tables and columns", () => {
    const problems = storedDerivedDeclarations().flatMap((declaration) => [
      ...missing(declaration.table, ["id"]),
      ...declaration.inputs.flatMap((input) => [
        ...[
          ...(input.path ? [input.path] : []),
          ...(input.paths ?? []),
        ].flatMap(missingPath),
        ...missing(input.table, [
          input.tableColumn,
          ...(input.columns ?? []),
          ...input.except,
          ...Object.keys(input.where ?? {}),
        ]),
        ...missing(declaration.table, [
          input.entityColumn,
          ...Object.keys(input.targetWhere ?? {}),
        ]),
      ]),
      ...declaration.dependsOn.flatMap((dependency) =>
        "targetWhere" in dependency
          ? missing(declaration.table, Object.keys(dependency.targetWhere))
          : "path" in dependency
            ? missingPath(dependency.path)
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

describe("generated derived triggers", () => {
  // A row entering or leaving an input's `where` filter changes which values
  // read it, so a watched-column input must also watch its filter columns.
  it("watch the filter columns of inputs that list watched columns", () => {
    const ddl = derivedTriggerDdl();
    const watched = [...ddl.matchAll(/\(([^()]*)\) IS DISTINCT FROM \(/g)].map(
      (match) => match[1] ?? "",
    );
    const unwatched = storedDerivedDeclarations().flatMap((declaration) =>
      declaration.inputs.flatMap((input) =>
        input.columns && input.where
          ? Object.keys(input.where)
              .filter(
                (key) =>
                  !watched.some(
                    (tuple) =>
                      tuple.includes(`OLD."${key}"`) &&
                      tuple.includes(`OLD."${input.tableColumn}"`),
                  ),
              )
              .map((key) => `${declaration.target}: ${input.table}.${key}`)
          : [],
      ),
    );
    expect(unwatched).toEqual([]);
  });
});
