import type { Entity } from "@cubby/schemas/entity";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { entityGraph } from "~/entities/entity-graph.functions";

/** The overview and Relations tab share one cached manifest-backed read. */
export function EntityRelationshipPreview({
  entity,
  sourceId,
  name,
  onViewAll,
  operations = entityGraph,
}: {
  entity: Entity;
  sourceId: string;
  name?: string;
  onViewAll: () => void;
  operations?: Pick<typeof entityGraph, "graph">;
}) {
  const query = useQuery(
    operations.graph.queryOptions({
      roots: [{ entityType: entity, entityId: sourceId }],
      limit: 12,
    }),
  );
  if (query.isPending)
    return (
      <output className="text-sm text-muted-foreground">
        Loading connections…
      </output>
    );
  if (query.isError)
    return (
      <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
        Retry connections
      </Button>
    );
  const populated = query.data.branches.filter(
    (branch) => branch.totalCount > 0,
  );
  return (
    <nav
      aria-label={`${name ?? "Record"} relationships`}
      className="border-y border-border py-2"
    >
      <Row wrap gap="sm">
        {populated.slice(0, 3).map((branch) => (
          <Button
            key={branch.relationshipKey}
            variant="ghost"
            size="sm"
            onClick={onViewAll}
          >
            {branch.label}{" "}
            <span className="ml-1 text-muted-foreground tabular-nums">
              {branch.totalCount}
            </span>
          </Button>
        ))}
        {populated.length === 0 && (
          <span className="text-sm text-muted-foreground">
            No linked records.
          </span>
        )}
        {populated.length > 3 && (
          <span className="text-xs text-muted-foreground">
            +{populated.length - 3} more
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={onViewAll}>
          View all
        </Button>
        <Link
          to="/entities"
          search={{ tab: "explore", entity, root: sourceId, view: "graph" }}
          className="text-sm text-primary hover:underline"
        >
          Explore graph
        </Link>
      </Row>
    </nav>
  );
}
