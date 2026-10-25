/**
 * Every stored derived value (ADR 0021), read once from the entity manifest
 * (`model.derived.<key>.stored`). The drain,
 * the generated triggers, list reads and explanations all resolve declarations
 * here, so a value has one declaration and no parallel scheduling list.
 */
import { entitySchema, type Entity } from "@cubby/schemas/entity";
import { storedDerivedManifest } from "@cubby/schemas/entity-stored-derived";
import { z } from "zod";

/** One input: changes to `table` rows whose `tableColumn` equals the value's `entityColumn`. */
export interface DerivedInput {
  readonly table: string;
  readonly tableColumn: string;
  readonly entityColumn: string;
  /** Columns whose change matters; null = any column except `updatedAt`. */
  readonly columns: readonly string[] | null;
  /** Only rows holding these column values count. */
  readonly where: Readonly<Record<string, string>> | null;
}

/** Another stored value this one reads, joined `source.sourceColumn = this.entityColumn`. */
export interface DerivedDependency {
  readonly entity: Entity;
  readonly key: string;
  readonly sourceColumn: string;
  readonly entityColumn: string;
}

export type DerivedSortType = "number" | "date" | "text" | null;

export interface StoredDerivedDeclaration {
  readonly entity: Entity;
  readonly key: string;
  /** `<entity>.<key>`, the dirty-row target and explanation identifier. */
  readonly target: string;
  readonly table: string;
  readonly compute: string;
  readonly sort: DerivedSortType;
  readonly inputs: readonly DerivedInput[];
  readonly dependsOn: readonly DerivedDependency[];
}

/** The generated registry's entry, parsed at this boundary. */
const storedEntry = z.object({
  entity: entitySchema,
  key: z.string(),
  table: z.string().nullable(),
  type: z.string(),
  stored: z.object({
    compute: z.string(),
    inputs: z.array(
      z.object({
        table: z.string(),
        match: z.record(z.string(), z.string()),
        columns: z.array(z.string()).optional(),
        where: z.record(z.string(), z.string()).optional(),
      }),
    ),
    dependsOn: z
      .array(
        z.object({
          entity: entitySchema,
          key: z.string(),
          match: z.record(z.string(), z.string()),
        }),
      )
      .optional(),
  }),
});

const onePair = (match: Record<string, string>): [string, string] => {
  const entries = Object.entries(match);
  const [pair] = entries;
  if (entries.length !== 1 || !pair)
    throw new Error("A derived match pairs exactly one column");
  return pair;
};

const sortTypeOf = (type: string | undefined): DerivedSortType =>
  type === "number"
    ? "number"
    : type === "date"
      ? "date"
      : type
        ? "text"
        : null;

const manifestDeclarations = (): StoredDerivedDeclaration[] =>
  z
    .array(storedEntry)
    .parse(storedDerivedManifest)
    .flatMap((entry) => {
      if (!entry.table) return [];
      return [
        {
          entity: entry.entity,
          key: entry.key,
          target: `${entry.entity}.${entry.key}`,
          table: entry.table,
          compute: entry.stored.compute,
          sort: sortTypeOf(entry.type),
          inputs: entry.stored.inputs.map((input) => {
            const [tableColumn, entityColumn] = onePair(input.match);
            return {
              table: input.table,
              tableColumn,
              entityColumn,
              columns: input.columns ?? null,
              where: input.where ?? null,
            };
          }),
          dependsOn: (entry.stored.dependsOn ?? []).map((dependency) => {
            const [sourceColumn, entityColumn] = onePair(dependency.match);
            return {
              entity: dependency.entity,
              key: dependency.key,
              sourceColumn,
              entityColumn,
            };
          }),
        } satisfies StoredDerivedDeclaration,
      ];
    });

let cached: readonly StoredDerivedDeclaration[] | null = null;

export function storedDerivedDeclarations(): readonly StoredDerivedDeclaration[] {
  cached ??= manifestDeclarations();
  return cached;
}

export function storedDerived(
  entity: Entity,
  key: string,
): StoredDerivedDeclaration | null {
  return (
    storedDerivedDeclarations().find(
      (entry) => entry.entity === entity && entry.key === key,
    ) ?? null
  );
}

export function storedDerivedByTarget(
  target: string,
): StoredDerivedDeclaration | null {
  return (
    storedDerivedDeclarations().find((entry) => entry.target === target) ?? null
  );
}

/** Fanout targets carry the entity column the drain matches: `<entity>.<key>@<column>`. */
export const fanoutTarget = (target: string, entityColumn: string) =>
  `${target}@${entityColumn}`;

export function parseTarget(target: string): {
  declaration: StoredDerivedDeclaration;
  fanoutColumn: string | null;
} | null {
  const [base, fanoutColumn] = target.split("@");
  const declaration = base ? storedDerivedByTarget(base) : null;
  return declaration
    ? { declaration, fanoutColumn: fanoutColumn ?? null }
    : null;
}

/** Declarations that read `entity.key`, for propagation after it changes. */
export function dependentsOf(
  entity: Entity,
  key: string,
): readonly {
  declaration: StoredDerivedDeclaration;
  dependency: DerivedDependency;
}[] {
  return storedDerivedDeclarations().flatMap((declaration) =>
    declaration.dependsOn
      .filter(
        (dependency) => dependency.entity === entity && dependency.key === key,
      )
      .map((dependency) => ({ declaration, dependency })),
  );
}

/** Reset the cache; tests that register declarations call it. */
export function resetStoredDerivedCache(): void {
  cached = null;
}
