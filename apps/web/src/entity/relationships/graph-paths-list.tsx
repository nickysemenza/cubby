import type { EntityRef } from "@cubby/schemas/entity";
import type {
  EntityGraphEdge,
  EntityGraphNode,
} from "@cubby/schemas/entity-graph";

import { Button } from "~/ui/primitives/button";

import { graphRefKey } from "./entity-graph-state";
import { GraphRecordFacts, GraphRecordLink } from "./graph-record-content";

/** A shortest witnessed route through the loaded map; no proximity claims or extra reads. */
export function graphRecordPaths(
  root: EntityRef,
  edges: readonly EntityGraphEdge[],
) {
  const adjacency = new Map<
    string,
    { next: EntityRef; edge: EntityGraphEdge }[]
  >();
  for (const edge of edges)
    for (const [from, next] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ]) {
      if (!from || !next) continue;
      const key = graphRefKey(from);
      adjacency.set(key, [...(adjacency.get(key) ?? []), { next, edge }]);
    }
  const paths = new Map<string, { ref: EntityRef; edge?: EntityGraphEdge }[]>();
  const key = graphRefKey(root);
  paths.set(key, [{ ref: root }]);
  const queue = [key];
  for (const current of queue)
    for (const { next, edge } of adjacency.get(current) ?? []) {
      const nextKey = graphRefKey(next);
      if (paths.has(nextKey)) continue;
      paths.set(nextKey, [...(paths.get(current) ?? []), { ref: next, edge }]);
      queue.push(nextKey);
    }
  return paths;
}

export function GraphPathsList({
  root,
  nodes,
  edges,
  matches,
  onSelect,
}: {
  root: EntityRef;
  nodes: EntityGraphNode[];
  matches: EntityGraphNode[];
  edges: EntityGraphEdge[];
  onSelect: (key: string) => void;
}) {
  const byKey = new Map(nodes.map((node) => [graphRefKey(node), node]));
  const paths = graphRecordPaths(root, edges);
  return (
    <div className="divide-y divide-border px-3" aria-label="Connection paths">
      {matches.map((node) => (
        <article key={graphRefKey(node)} className="py-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <GraphRecordLink node={node} />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onSelect(graphRefKey(node))}
            >
              Inspect {node.label}
            </Button>
          </div>
          <ol className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {(paths.get(graphRefKey(node)) ?? []).map(({ ref, edge }) => {
              const record = byKey.get(graphRefKey(ref));
              return record ? (
                <li
                  key={graphRefKey(ref)}
                  className="flex min-w-0 flex-wrap items-center gap-2"
                >
                  {edge ? (
                    <span className="text-2xs text-muted-foreground">
                      {graphRefKey(edge.target) === graphRefKey(ref)
                        ? "→"
                        : "←"}{" "}
                      {edge.label}
                    </span>
                  ) : null}
                  <GraphRecordLink node={record} />
                </li>
              ) : null;
            })}
          </ol>
          <GraphRecordFacts node={node} />
        </article>
      ))}
      {!matches.length ? (
        <p className="py-4 text-sm text-muted-foreground">
          No explored records match.
        </p>
      ) : null}
    </div>
  );
}
