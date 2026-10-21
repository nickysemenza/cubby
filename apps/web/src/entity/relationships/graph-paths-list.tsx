import type { EntityRef } from "@cubby/schemas/entity";
import type {
  EntityGraphEdge,
  EntityGraphNode,
} from "@cubby/schemas/entity-graph";

import { entityLabel } from "~/entity/entities";
import { Button } from "~/ui/primitives/button";

import { graphRefKey } from "./entity-graph-state";
import { GraphRecordFacts, GraphRecordLink } from "./graph-record-content";

type GraphRecordStep = { ref: EntityRef; edge?: EntityGraphEdge };

/** A shortest witnessed route through the loaded map; no proximity claims or extra reads. */
function graphRecordPaths(root: EntityRef, edges: readonly EntityGraphEdge[]) {
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
  const paths = new Map<string, GraphRecordStep[]>();
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
            <GraphRecordLink node={node} compact />
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Inspect ${node.label} ${entityLabel(node.entityKind)}`}
              onClick={() => onSelect(graphRefKey(node))}
            >
              Inspect
            </Button>
          </div>
          {graphRefKey(node) === graphRefKey(root) ? (
            <p className="mb-3 text-xs text-muted-foreground">
              Starting record
            </p>
          ) : (
            <GraphPathSteps
              steps={paths.get(graphRefKey(node)) ?? []}
              byKey={byKey}
            />
          )}
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

function GraphPathSteps({
  steps,
  byKey,
}: {
  steps: readonly GraphRecordStep[];
  byKey: ReadonlyMap<string, EntityGraphNode>;
}) {
  return (
    <ol className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {steps.map(({ ref, edge }) => {
        const record = byKey.get(graphRefKey(ref));
        return record ? (
          <li
            key={graphRefKey(ref)}
            className="flex min-w-0 flex-wrap items-center gap-2"
          >
            {edge ? (
              <span className="text-2xs text-muted-foreground">
                {graphRefKey(edge.target) === graphRefKey(ref) ? "→" : "←"}{" "}
                {edge.label}
              </span>
            ) : null}
            <GraphRecordLink node={record} />
          </li>
        ) : null;
      })}
    </ol>
  );
}

export function GraphPathExplanation({
  root,
  selected,
  nodes,
  edges,
}: {
  root: EntityRef;
  selected: string;
  nodes: EntityGraphNode[];
  edges: EntityGraphEdge[];
}) {
  const steps = graphRecordPaths(root, edges).get(selected) ?? [];
  if (steps.length < 2) return null;
  return (
    <section
      aria-label="Why this record appears"
      className="border-t border-border pt-3"
    >
      <h3 className="mb-2 text-sm font-medium">Why this record appears</h3>
      <GraphPathSteps
        steps={steps}
        byKey={new Map(nodes.map((node) => [graphRefKey(node), node]))}
      />
      <p className="text-2xs text-muted-foreground">
        A recorded path through this map. Arrows retain the relationship’s
        stored direction.
      </p>
    </section>
  );
}
