import { z } from "zod";

export const listReadRowSchema = z
  .object({ id: z.string() })
  .catchall(z.unknown());
export type ListReadRow = z.output<typeof listReadRowSchema>;

type ListFieldOwnership = {
  core: string[];
  media: string[];
  quality: string[];
  relations: string[];
  derived: string[];
};

export const listEnrichmentGroups = [
  "media",
  "quality",
  "relations",
  "derived",
] as const;
export type ListEnrichmentGroup = (typeof listEnrichmentGroups)[number];
export type ListReadGroup = "core" | ListEnrichmentGroup;
export type ListFieldPartition = Partial<
  Record<ListEnrichmentGroup, readonly string[]>
>;
export type ListLoaderDependencies = Partial<
  Record<ListEnrichmentGroup, readonly ListEnrichmentGroup[]>
>;

export function compileListReadSchema(
  schema: z.ZodObject,
  partition: ListFieldPartition & { dependencies?: ListLoaderDependencies },
  dependencies: ListLoaderDependencies = {},
) {
  const owners = new Map<string, ListReadGroup>();
  for (const group of listEnrichmentGroups) {
    for (const key of partition[group] ?? []) {
      if (!(key in schema.shape)) throw new Error(`Unknown list field: ${key}`);
      if (key === "id" || owners.has(key))
        throw new Error(`List field has multiple owners: ${key}`);
      owners.set(key, group);
    }
  }
  const active = new Set<ListEnrichmentGroup>();
  const visited = new Set<ListEnrichmentGroup>();
  const visit = (group: ListEnrichmentGroup) => {
    if (active.has(group))
      throw new Error(`List loader dependency cycle: ${group}`);
    if (visited.has(group)) return;
    active.add(group);
    for (const dependency of dependencies[group] ?? []) {
      if ((partition[dependency]?.length ?? 0) === 0)
        throw new Error(`Missing list loader dependency: ${dependency}`);
      visit(dependency);
    }
    active.delete(group);
    visited.add(group);
  };
  for (const group of listEnrichmentGroups) visit(group);
  const fields: ListFieldOwnership = {
    core: [],
    media: [],
    quality: [],
    relations: [],
    derived: [],
  };
  for (const key of Object.keys(schema.shape))
    fields[owners.get(key) ?? "core"].push(key);
  const schemas = Object.fromEntries(
    Object.entries(fields).map(([group, keys]) => [
      group,
      z
        .object(
          Object.fromEntries(
            ["id", ...keys].map((key) => [key, schema.shape[key]]),
          ),
        )
        .partial()
        .required({ id: true }),
    ]),
  );
  return {
    schemas,
    fields: { ...fields, dependencies },
    project(row: ListReadRow, group: ListReadGroup): ListReadRow {
      const groupSchema = schemas[group];
      if (!groupSchema) throw new Error(`Missing list schema: ${group}`);
      return listReadRowSchema.parse(groupSchema.parse(row));
    },
  };
}
