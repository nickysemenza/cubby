/** Manifest-owned typed results and ordering for the hourly deterministic pass. */
import { entitySchema, type Entity } from "@cubby/schemas/entity";
import { storedDerivedManifest } from "@cubby/schemas/entity-stored-derived";
import { z } from "zod";

const storedEntry = z.object({
  entity: entitySchema,
  key: z.string(),
  table: z.string().nullable(),
  type: z.string(),
  publishes: z.enum(["derivedValue", "ownTable"]),
  stored: z.object({
    compute: z.string(),
    rebuildPhase: z
      .enum(["facts", "quality", "search", "diagnostics"])
      .optional(),
    snapshotSource: z
      .object({
        table: z.string(),
        value: z.union([z.string(), z.record(z.string(), z.string())]),
        computedAt: z.string(),
        decidedBy: z.string().optional(),
        sort: z.string().optional(),
        storage: z.enum(["json", "number", "text"]).optional(),
        view: z.boolean().optional(),
      })
      .optional(),
    recordSource: z
      .object({
        value: z.string(),
        computedAt: z.string(),
        freshAt: z.string().optional(),
      })
      .optional(),
    dependsOn: z
      .array(z.object({ entity: entitySchema, key: z.string() }))
      .optional(),
  }),
});

const sortTypeOf = (type: string): "number" | "date" | "text" | null =>
  type === "number"
    ? "number"
    : type === "date"
      ? "date"
      : type
        ? "text"
        : null;

type StoredEntry = z.infer<typeof storedEntry>;
export type EntityStoredDerivedDeclaration = Pick<
  StoredEntry,
  "entity" | "key" | "publishes"
> & {
  readonly target: string;
  readonly table: string;
  readonly compute: string;
  readonly rebuildPhase: NonNullable<StoredEntry["stored"]["rebuildPhase"]>;
  readonly snapshotSource: StoredEntry["stored"]["snapshotSource"];
  readonly recordSource: NonNullable<
    StoredEntry["stored"]["recordSource"]
  > | null;
  readonly sort: "number" | "date" | "text" | null;
  readonly dependsOn: Readonly<NonNullable<StoredEntry["stored"]["dependsOn"]>>;
};

const manifestDeclarations = (): EntityStoredDerivedDeclaration[] =>
  z
    .array(storedEntry)
    .parse(storedDerivedManifest)
    .flatMap((entry) =>
      entry.table
        ? [
            {
              entity: entry.entity,
              key: entry.key,
              target: `${entry.entity}.${entry.key}`,
              table: entry.table,
              compute: entry.stored.compute,
              rebuildPhase: entry.stored.rebuildPhase ?? "facts",
              publishes: entry.publishes,
              recordSource: entry.stored.recordSource ?? null,
              snapshotSource: entry.stored.snapshotSource,
              sort: sortTypeOf(entry.type),
              dependsOn: entry.stored.dependsOn ?? [],
            },
          ]
        : [],
    );

let cached: readonly EntityStoredDerivedDeclaration[] | null = null;

export function entityStoredDerivedDeclarations(): readonly EntityStoredDerivedDeclaration[] {
  cached ??= manifestDeclarations();
  return cached;
}

export function storedDerived(
  entity: Entity,
  key: string,
): EntityStoredDerivedDeclaration | null {
  return (
    entityStoredDerivedDeclarations().find(
      (entry) => entry.entity === entity && entry.key === key,
    ) ?? null
  );
}
