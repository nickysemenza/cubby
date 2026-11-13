import { getTableName, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { CompiledEntity } from "./declarations.ts";
import {
  edgeDefinitionSchema,
  defineEdge,
  type EdgeDefinition,
  type EdgePolicyReference,
} from "@cubby/schemas/entity-definitions/edges";
import type { DeclarationObject } from "./declarations.ts";
import { EntityDeclarationError } from "./source.ts";

/** Read the module-ready edges without importing any policy implementation. */
export const collectEdgeDeclarations = (
  declarations: readonly DeclarationObject[],
): EdgeDefinition[] =>
  declarations.flatMap((declaration) =>
    edgeDefinitionSchema
      .array()
      .parse(declaration.edges ?? [])
      .map((edge) => defineEdge(edge)),
  );

/** Inverses are navigation names; only physical declarations claim storage. */
export const validateEdgeDeclarations = (
  edges: readonly EdgeDefinition[],
  legacyPaths: ReadonlySet<string> = new Set(),
): void => {
  const keys = new Set<string>();
  const storageOwners = new Map<string, string>();
  const columnPartitions = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (keys.has(edge.key))
      throw new EntityDeclarationError(`Duplicate edge key ${edge.key}.`);
    keys.add(edge.key);
    if (edge.inverse.from !== edge.to || edge.inverse.to !== edge.from)
      throw new EntityDeclarationError(
        `${edge.key}: inverse must reverse the endpoints.`,
      );
    const storage = edge.storage;
    if (storage.kind === "composition") continue;
    if (
      storage.kind === "foreign-key" &&
      storage.partition &&
      (storage.partition.column !==
        `${storage.column.split(".")[0]}.entityKind` ||
        storage.partition.value !== edge.to)
    )
      throw new EntityDeclarationError(
        `${edge.key}: partition must identify its declared endpoint kind.`,
      );
    const key =
      storage.kind === "foreign-key"
        ? `${storage.column}${storage.partition ? `[${storage.partition.column}=${storage.partition.value}]` : ""}`
        : `EntityLink[${storage.linkKind}]`;
    if (storage.kind === "foreign-key") {
      const claims = columnPartitions.get(storage.column) ?? new Set<string>();
      const partition = storage.partition?.value ?? "*";
      if (claims.size && (partition === "*" || claims.has("*")))
        throw new EntityDeclarationError(
          `${edge.key}: overlapping storage claims for ${storage.column}.`,
        );
      claims.add(partition);
      columnPartitions.set(storage.column, claims);
    }
    const owner = storageOwners.get(key);
    if (owner !== undefined)
      throw new EntityDeclarationError(
        `${edge.key} and ${owner} both claim storage ${key}.`,
      );
    storageOwners.set(key, edge.key);
  }
  const paths = edges.flatMap((edge) => {
    if (edge.storage.kind === "composition") return [];
    if (edge.storage.kind === "link")
      return [
        {
          key: `EntityLink[${edge.storage.linkKind}].from`,
          from: `row:EntityLink[${edge.storage.linkKind}]`,
          to: edge.from,
        },
        {
          key: `EntityLink[${edge.storage.linkKind}].to`,
          from: `row:EntityLink[${edge.storage.linkKind}]`,
          to: edge.to,
        },
      ];
    return [{ key: edge.storage.column, from: edge.from, to: edge.to }];
  });
  for (const edge of edges) {
    if (edge.storage.kind !== "composition") continue;
    const sourceKeys = new Set<string>();
    for (const source of edge.storage.sources) {
      if (sourceKeys.has(source.key))
        throw new EntityDeclarationError(
          `${edge.key}: duplicate source ${source.key}.`,
        );
      sourceKeys.add(source.key);
      if (source.provenance.kind !== "local-path") continue;
      let reachable = new Set<string>([edge.from]);
      let legacy = false;
      for (const step of source.provenance.steps) {
        const candidates = paths.filter((path) => path.key === step.edge);
        if (!candidates.length && legacyPaths.has(step.edge)) {
          legacy = true;
          continue;
        }
        const next = new Set(
          candidates.flatMap((path) => {
            const from = step.direction === "outgoing" ? path.from : path.to;
            const to = step.direction === "outgoing" ? path.to : path.from;
            return legacy || reachable.has(from) ? [to] : [];
          }),
        );
        if (!next.size)
          throw new EntityDeclarationError(
            `${edge.key}.${source.key}: ${step.edge} does not continue the declared path.`,
          );
        reachable = next;
      }
      if (!legacy && !reachable.has(edge.to))
        throw new EntityDeclarationError(
          `${edge.key}.${source.key} does not reach ${edge.to}.`,
        );
    }
  }
};

const policyReferences = (edge: EdgeDefinition): EdgePolicyReference[] => {
  if ("kind" in edge.policies) return [];
  return Object.values(edge.policies).flatMap((end) =>
    Object.values(end).flatMap((policy) =>
      policy.kind === "disposition"
        ? [
            policy.handler,
            policy.before,
            policy.after,
            policy.beforeLock,
            policy.expand,
          ].filter((ref): ref is EdgePolicyReference => ref != null)
        : [],
    ),
  );
};

/** The server compiler verifies export existence and callability without loading repo code. */
export const renderEdgePolicyChecks = (
  edges: readonly EdgeDefinition[],
): string => {
  const refs = [
    ...new Map(
      edges
        .flatMap(policyReferences)
        .map((ref) => [`${ref.module}#${ref.export}#${ref.member ?? ""}`, ref]),
    ).values(),
  ].sort((a, b) =>
    `${a.module}#${a.export}`.localeCompare(`${b.module}#${b.export}`),
  );
  return (
    refs
      .map(
        (ref, index) =>
          `import type { ${ref.export} as edgePolicy${index} } from ${JSON.stringify(ref.module)};`,
      )
      .join("\n") +
    (refs.length
      ? "\ntype CallableEdgePolicy<T extends (...args: never[]) => unknown> = T;\n"
      : "\n") +
    `export type EntityEdgePolicyChecks = [${refs.map((ref, index) => `CallableEdgePolicy<${ref.member ? `ReturnType<typeof edgePolicy${index}>[${JSON.stringify(ref.member)}]` : `typeof edgePolicy${index}`}>`).join(", ")}];\n`
  );
};

/** Schema introspection makes an undeclared FK fail even when no navigation uses it. */
export const validateEdgeStorageCoverage = (
  edges: readonly EdgeDefinition[],
  entities: readonly CompiledEntity[],
  schema: typeof import("~/server/db/drizzle-schema").drizzleSchema,
  declaredEntities: ReadonlySet<string>,
): void => {
  const tables = Object.values(schema).flatMap((value) =>
    is(value, PgTable) ? [value] : [],
  );
  const byName = new Map<string, PgTable>(
    tables.map((table) => [getTableName(table), table]),
  );
  const byEntity = new Map(
    entities.flatMap((entity) =>
      entity.table ? [[entity.key, entity.table.name] as const] : [],
    ),
  );
  const byTable = new Map([...byEntity].map(([key, table]) => [table, key]));
  const physical = edges.filter((edge) => edge.storage.kind === "foreign-key");
  for (const edge of physical) {
    const storage = edge.storage;
    if (storage.kind !== "foreign-key") continue;
    const [name, column] = storage.column.split(".");
    const table = name ? byName.get(name) : undefined;
    if (
      !table ||
      !getTableConfig(table).columns.some(
        (candidate) => candidate.name === column,
      )
    )
      throw new EntityDeclarationError(
        `${edge.key}: unknown storage column ${storage.column}.`,
      );
    if (!storage.constrained) continue;
    const target = storage.partition ? "Entity" : byEntity.get(edge.to);
    if (
      !getTableConfig(table).foreignKeys.some((key) => {
        const ref = key.reference();
        return (
          getTableName(ref.foreignTable) === target &&
          ref.columns.some(
            (candidate, index) =>
              candidate.name === column &&
              ref.foreignColumns[index]?.name === "id",
          )
        );
      })
    )
      throw new EntityDeclarationError(
        `${edge.key}: declared constraint does not target ${target}.`,
      );
  }
  for (const table of tables) {
    const config = getTableConfig(table);
    for (const key of config.foreignKeys) {
      const ref = key.reference(),
        target = byTable.get(getTableName(ref.foreignTable));
      if (!target || !declaredEntities.has(target)) continue;
      for (const [index, column] of ref.columns.entries()) {
        if (ref.foreignColumns[index]?.name !== "id") continue;
        const name = `${config.name}.${column.name}`;
        if (
          !physical.some(
            (edge) =>
              edge.to === target &&
              edge.storage.kind === "foreign-key" &&
              edge.storage.column === name,
          )
        )
          throw new EntityDeclarationError(
            `${name}: missing defineEdge declaration for ${target}.`,
          );
      }
    }
  }
};
