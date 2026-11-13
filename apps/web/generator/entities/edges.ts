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
      policy.kind === "disposition" && policy.handler ? [policy.handler] : [],
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
