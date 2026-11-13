import { z } from "zod";
import { retainedTableExports } from "@cubby/schemas/compiler/child-tables/retained";
import type {
  EdgeDefinition,
  EdgePolicyReference,
} from "@cubby/schemas/entity-definitions/edges";
import type { ChildTableDeclaration } from "@cubby/schemas/compiler/entity-definitions/child-definition";
import { generatedHeader, rawSource } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import { EntityDeclarationError } from "../source.ts";

type Hook = { key: string; handler: EdgePolicyReference };

/** Physical declarations emit literal keys; functions retain custom transaction policy. */
export const renderDeclaredEdges = (
  edges: readonly EdgeDefinition[],
  entities: readonly CompiledEntity[],
  children: readonly ChildTableDeclaration[],
  converted: ReadonlySet<string>,
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
  const groups = new Map<string, string[]>(),
    ordinary = new Map<string, string[]>(),
    owners = new Map<string, string>();
  const deletes = new Map<string, string[]>(),
    merges = new Map<string, string[]>();
  const deleteHooks = new Map<string, Hook[]>(),
    mergeHooks = new Map<string, Hook[]>();
  const add = (map: Map<string, string[]>, key: string, value: string) =>
    map.set(key, [...(map.get(key) ?? []), value]);
  for (const entity of entities) {
    ordinary.set(entity.key, []);
    if (!converted.has(entity.key)) continue;
    const life = z
      .object({ delete: z.object({}).nullable(), merge: z.boolean() })
      .parse(entity.descriptor.lifecycle);
    groups.set(entity.key, []);
    if (life.delete !== null) deletes.set(entity.key, []);
    if (life.merge) merges.set(entity.key, []);
  }
  const ownerFor = (
    edge: Extract<EdgeDefinition, { fromEnd: object }>,
    table: string,
  ) => {
    if (edge.ownership.kind === "entity") return;
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
        const name = tables.get(edge.ownership.table);
        if (!name)
          throw new EntityDeclarationError(
            `Unknown owner table ${edge.ownership.table}.`,
          );
        imports.add(name);
        owner = `{via:{column:${column(edge.ownership.column)},table:${name},owner:${column(edge.ownership.owner)}}}`;
        break;
      }
    }
    const previous = owners.get(table);
    if (previous !== undefined && previous !== owner)
      throw new EntityDeclarationError(`Conflicting edge owners for ${table}.`);
    owners.set(table, owner);
  };
  for (const edge of edges) {
    if (!("toEnd" in edge) || !("to" in edge.policies)) continue;
    const storage = edge.storage;

    const ends =
      storage.kind === "foreign-key"
        ? [
            {
              entity: edge.to,
              end: "to" as const,
              key: storage.column,
              column: column(storage.column),
              meaning: edge.toEnd,
              scope: "",
              ordinary: storage.ordinary === true,
            },
          ]
        : [
            {
              entity: edge.from,
              end: "from" as const,
              key: `EntityLink[${storage.linkKind}].from`,
              column: column("EntityLink.fromEntityId"),
              meaning: edge.fromEnd,
              scope: `scope:{column:${column("EntityLink.kind")},value:${JSON.stringify(storage.linkKind)}},`,
              ordinary: false,
            },
            {
              entity: edge.to,
              end: "to" as const,
              key: `EntityLink[${storage.linkKind}].to`,
              column: column("EntityLink.toEntityId"),
              meaning: edge.toEnd,
              scope: `scope:{column:${column("EntityLink.kind")},value:${JSON.stringify(storage.linkKind)}},`,
              ordinary: false,
            },
          ];
    if (storage.kind === "link" || converted.has(edge.to))
      ownerFor(
        edge,
        storage.kind === "link" ? "EntityLink" : storage.column.split(".")[0]!,
      );
    for (const end of ends) {
      if (!converted.has(end.entity)) continue;
      if (end.entity.startsWith("row:") || end.entity === "identity")
        throw new EntityDeclarationError(
          `${edge.key}: incoming projection requires an entity.`,
        );
      const key = JSON.stringify(end.key);
      add(
        end.ordinary ? ordinary : groups,
        end.entity,
        `${key}:{column:${end.column},${end.scope}...(${JSON.stringify(end.meaning)} as const)${storage.kind === "foreign-key" && !storage.constrained ? ",unconstrained:true" : ""}${edge.note ? `,note:${JSON.stringify(edge.note)}` : ""}}`,
      );
      for (const [operation, map, hooks] of [
        ["delete", deletes, deleteHooks],
        ["merge", merges, mergeHooks],
      ] as const) {
        const policy = edge.policies[end.end][operation];
        if (policy.kind === "unsupported") continue;
        add(map, end.entity, `${key}:${JSON.stringify(policy.disposition)}`);
        if (policy.handler)
          hooks.set(end.entity, [
            ...(hooks.get(end.entity) ?? []),
            { key: end.key, handler: policy.handler },
          ]);
      }
    }
  }
  const grouped = (name: string, map: Map<string, string[]>) =>
    `export const ${name}={${[...map].map(([entity, rows]) => `${JSON.stringify(entity)}:{${rows.join(",\n")}}`).join(",\n")}} as const;\n`;
  const hooksSource = (name: string, groups: Map<string, Hook[]>) => {
    if (!groups.size) return "";
    const bindings = [...groups].map(([entity, entries]) => {
      const factories = [
        ...new Map(
          entries
            .filter((e) => e.handler.member)
            .map((e) => [`${e.handler.module}#${e.handler.export}`, e.handler]),
        ).values(),
      ];
      const direct = (entry: Hook) =>
        `async(tx:DrizzleTransaction,ids:EntityId<${JSON.stringify(entity)}>[]):Promise<void> => (await import(${JSON.stringify(entry.handler.module)})).${entry.handler.export}(tx,ids${entry.handler.argument ? `,${JSON.stringify(entry.handler.argument)}` : ""})`;
      if (!factories.length)
        return `${JSON.stringify(entity)}:{overrides:{${entries.map((entry) => `${JSON.stringify(entry.key)}:${direct(entry)}`).join(",\n")}}}`;
      const context = factories
        .map(
          (ref) =>
            `Parameters<typeof import(${JSON.stringify(ref.module)}).${ref.export}>[0]`,
        )
        .join(" & ");
      const calls = factories
        .map(
          (ref, index) =>
            `const factory${index}=(await import(${JSON.stringify(ref.module)})).${ref.export}(context);`,
        )
        .join("\n");
      const values = entries
        .map((entry) => {
          const index = factories.findIndex(
            (ref) =>
              ref.module === entry.handler.module &&
              ref.export === entry.handler.export,
          );
          return `${JSON.stringify(entry.key)}:${entry.handler.member ? `factory${index}[${JSON.stringify(entry.handler.member)}]` : direct(entry)}`;
        })
        .join(",\n");
      return `${JSON.stringify(entity)}:async(context:${context})=>{${calls}\nreturn {overrides:{${values}}};}`;
    });
    return `export const ${name}={${bindings.join(",\n")}} as const;\n`;
  };
  return [
    {
      relativePath: "apps/web/src/server/db/generated/declared-edges.gen.ts",
      source: rawSource(
        generatedHeader +
          (deleteHooks.size || mergeHooks.size
            ? 'import type {DrizzleTransaction} from "~/server/db";\nimport type {EntityId} from "@cubby/schemas/identifiers";\n'
            : "") +
          (imports.size
            ? `import {${[...imports].sort().join(",")}} from "~/server/db/schema";\n`
            : "") +
          grouped("DECLARED_EDGE_OVERRIDES", groups) +
          grouped("DECLARED_EDGE_ORDINARY", ordinary) +
          `export const DECLARED_EDGE_OWNERS={${[...owners].map(([table, owner]) => `${JSON.stringify(table)}:${owner}`).join(",\n")}} as const;\n` +
          grouped("DECLARED_EDGE_DELETE_POLICIES", deletes) +
          (merges.size ? grouped("DECLARED_EDGE_MERGE_POLICIES", merges) : "") +
          hooksSource("DECLARED_EDGE_DELETE_HOOKS", deleteHooks) +
          hooksSource("DECLARED_EDGE_MERGE_HOOKS", mergeHooks),
      ),
    },
  ];
};
