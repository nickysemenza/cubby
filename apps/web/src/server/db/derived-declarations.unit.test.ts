import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { storedDerivedDeclarations } from "~/server/db/derived-declarations";
import { derivedTriggerDdl } from "~/server/db/derived-trigger-ddl";
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
  it("publishes automatic provenance for every fill entity without a list field", () => {
    const expected = Object.entries(entityFieldModels)
      .filter(([, model]) =>
        model.fields.some(
          (field) =>
            field.control?.suggest?.mode === "fill" &&
            !field.control.suggest.reviewRequired,
        ),
      )
      .map(([entity]) => entity);
    const declarations = storedDerivedDeclarations().filter(
      (entry) => entry.key === "automaticFields",
    );
    expect(declarations.map((entry) => entry.entity)).toEqual(expected);
    for (const declaration of declarations) {
      expect(declaration.publishes).toBe("derivedValue");
      expect(
        entityFieldModels[declaration.entity].fields.map((field) => field.key),
      ).not.toContain("automaticFields");
      expect(declaration.inputs.map((input) => input.table)).toEqual([
        declaration.table,
        "AssessmentState",
        "Assessment",
        "Feedback",
        "AuditLog",
      ]);
    }
  });
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
          ...input.except,
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
