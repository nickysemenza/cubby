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
    const key =
      storage.kind === "foreign-key"
        ? storage.column
        : `EntityLink[${storage.linkKind}]`;
    const owner = storageOwners.get(key);
    if (owner !== undefined)
      throw new EntityDeclarationError(
        `${edge.key} and ${owner} both claim storage ${key}.`,
      );
    storageOwners.set(key, edge.key);
  }
  const byKey = new Map(edges.map((edge) => [edge.key, edge]));
  for (const edge of edges) {
    if (edge.storage.kind !== "composition") continue;
    const sourceKeys = new Set<string>();
    for (const source of edge.storage.sources) {
      if (sourceKeys.has(source.key))
        throw new EntityDeclarationError(
          `${edge.key}: duplicate source ${source.key}.`,
        );
      sourceKeys.add(source.key);
      let endpoint = edge.from;
      for (const step of source.path) {
        const referenced = byKey.get(step.edge);
        if (!referenced || referenced.storage.kind === "composition")
          throw new EntityDeclarationError(
            `${edge.key}.${source.key}: ${step.edge} must name a physical edge.`,
          );
        const from =
          step.direction === "outgoing" ? referenced.from : referenced.to;
        const to =
          step.direction === "outgoing" ? referenced.to : referenced.from;
        if (from !== endpoint)
          throw new EntityDeclarationError(
            `${edge.key}.${source.key}: ${step.edge} starts at ${from}, expected ${endpoint}.`,
          );
        endpoint = to;
      }
      if (endpoint !== edge.to)
        throw new EntityDeclarationError(
          `${edge.key}.${source.key} ends at ${endpoint}, expected ${edge.to}.`,
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
        .map((ref) => [`${ref.module}#${ref.export}`, ref]),
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
    `export type EntityEdgePolicyChecks = [${refs.map((_, index) => `CallableEdgePolicy<typeof edgePolicy${index}>`).join(", ")}];\n`
  );
};
