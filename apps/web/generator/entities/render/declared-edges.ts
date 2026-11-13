import { z } from "zod";
import { retainedTableExports } from "@cubby/schemas/compiler/child-tables/retained";
import type { EdgeDefinition } from "@cubby/schemas/entity-definitions/edges";
import type { ChildTableDeclaration } from "@cubby/schemas/compiler/entity-definitions/child-definition";
import { generatedHeader, rawSource } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import { EntityDeclarationError } from "../source.ts";

/** Physical declarations emit the same literal keys consumed by the existing graph and executors. */
export const renderDeclaredEdges = (
  edges: readonly EdgeDefinition[],
  entities: readonly CompiledEntity[],
  children: readonly ChildTableDeclaration[],
): EntityArtifacts[] => {
  const tables = new Map([
    ...retainedTableExports.map(
      (name) => [name.charAt(0).toUpperCase() + name.slice(1), name] as const,
    ),
    ...entities.flatMap((entity) =>
      entity.table
        ? [[entity.table.name, entity.table.exportName] as const]
        : [],
    ),
    ...[...children, ...entities.flatMap((entity) => entity.children)].map(
      (table) => [table.name, table.exportName] as const,
    ),
  ]);
  const imports = new Set<string>();
  const column = (key: string) => {
    const [table, field] = key.split(".");
    const name = table ? tables.get(table) : undefined;
    if (!name || !field)
      throw new EntityDeclarationError(`Unknown edge column ${key}.`);
    imports.add(name);
    return `${name}.${field}`;
  };
  const groups = new Map<string, string[]>();
  const owners = new Map<string, string>();
  const deletes = new Map<string, string[]>();
  const merges = new Map<string, string[]>();
  const hooks = new Map<string, string[]>();
  const navigationOwners = new Set<string>(
    edges.flatMap((edge) =>
      "navigation" in edge && edge.navigation ? [edge.from] : [],
    ),
  );
  for (const entity of entities) {
    if (!navigationOwners.has(entity.key)) continue;
    const lifecycle = z
      .object({ delete: z.object({}).nullable(), merge: z.boolean() })
      .parse(entity.descriptor.lifecycle);
    groups.set(entity.key, []);
    if (lifecycle.delete !== null) deletes.set(entity.key, []);
    if (lifecycle.merge) merges.set(entity.key, []);
  }
  const add = (map: Map<string, string[]>, key: string, value: string) =>
    map.set(key, [...(map.get(key) ?? []), value]);
  for (const edge of edges) {
    if (edge.storage.kind !== "foreign-key") continue;
    if (!("toEnd" in edge) || !("to" in edge.policies))
      throw new EntityDeclarationError(
        `${edge.key} requires physical semantics.`,
      );
    if (edge.to.startsWith("row:") || edge.to === "identity")
      throw new EntityDeclarationError(
        `${edge.key}: an entity endpoint is required for the incoming projection.`,
      );
    const key = JSON.stringify(edge.storage.column);
    add(
      groups,
      edge.to,
      `${key}: { column: ${column(edge.storage.column)}, ...(${JSON.stringify(edge.toEnd)} as const)${edge.storage.constrained ? "" : ", unconstrained: true"} }`,
    );
    for (const [operation, map] of [
      ["delete", deletes],
      ["merge", merges],
    ] as const) {
      const policy = edge.policies.to[operation];
      if (policy.kind === "unsupported") continue;
      add(map, edge.to, `${key}: ${JSON.stringify(policy.disposition)}`);
      if (operation === "delete" && policy.handler) {
        add(
          hooks,
          edge.to,
          `${key}: async (tx: DrizzleTransaction, ids: EntityId<${JSON.stringify(edge.to)}>[]): Promise<void> => (await import(${JSON.stringify(policy.handler.module)})).${policy.handler.export}(tx, ids)`,
        );
      }
    }
    if (edge.ownership.kind === "entity") continue;
    let owner: string;
    switch (edge.ownership.kind) {
      case "column":
        owner = `{owner:${column(edge.ownership.column)}}`;
        break;
      case "identity":
        owner = `{ownerIdentity:${column(edge.ownership.column)}}`;
        break;
      case "link-from":
        owner = `{linkFrom:${column(edge.ownership.column)}}`;
        break;
      case "excluded":
        owner = `{excluded:${JSON.stringify(edge.ownership.reason)}}`;
        break;
      case "via": {
        const exportName = tables.get(edge.ownership.table);
        if (!exportName)
          throw new EntityDeclarationError(
            `Unknown owner table ${edge.ownership.table}.`,
          );
        imports.add(exportName);
        owner = `{via:{column:${column(edge.ownership.column)},table:${exportName},owner:${column(edge.ownership.owner)}}}`;
        break;
      }
    }
    const table = edge.storage.column.split(".")[0]!;
    const previous = owners.get(table);
    if (previous !== undefined && previous !== owner)
      throw new EntityDeclarationError(`Conflicting edge owners for ${table}.`);
    owners.set(table, owner);
  }
  const grouped = (name: string, map: Map<string, string[]>) =>
    `export const ${name} = {${[...map].map(([entity, rows]) => `${JSON.stringify(entity)}:{${rows.join(",\n")}}`).join(",\n")}} as const;\n`;
  return [
    {
      relativePath: "apps/web/src/server/db/generated/declared-edges.gen.ts",
      source: rawSource(
        generatedHeader +
          (hooks.size
            ? 'import type { DrizzleTransaction } from "~/server/db";\nimport type { EntityId } from "@cubby/schemas/identifiers";\n'
            : "") +
          (imports.size
            ? `import {${[...imports].sort().join(",")}} from "~/server/db/schema";\n`
            : "") +
          grouped("DECLARED_EDGE_OVERRIDES", groups) +
          `export const DECLARED_EDGE_OWNERS = {${[...owners].map(([table, owner]) => `${JSON.stringify(table)}:${owner}`).join(",\n")}} as const;\n` +
          grouped("DECLARED_EDGE_DELETE_POLICIES", deletes) +
          (merges.size ? grouped("DECLARED_EDGE_MERGE_POLICIES", merges) : "") +
          `export const DECLARED_EDGE_DELETE_HOOKS = {${[...hooks].map(([entity, rows]) => `${JSON.stringify(entity)}:{overrides:{${rows.join(",\n")}}}`).join(",\n")}} as const;\n`,
      ),
    },
  ];
};
