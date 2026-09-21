import type { Entity } from "@cubby/schemas/entity";
import type { EntityFieldProvenance } from "@cubby/schemas/entity-fields";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { EntityIdentityMark } from "~/components/entity/entity-identity-mark";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  browserEntityDefinition,
  entityDetailParams,
  isBrowserRoutedEntity,
  type EntityDetailRoute,
} from "~/entities/entities";
import { entityGraph } from "~/entities/entity-graph.functions";
import {
  formatFieldProvenance,
  isInspectableFieldProvenance,
} from "~/entities/field-provenance";

import { TableLink } from "../table/TableLink";
import { TableCellWorkbench } from "./table-cell-workbench";

type RelationWorkbenchOperations = Pick<typeof entityGraph, "graph">;

function RelatedRecords({
  sourceEntity,
  sourceId,
  relationKeys,
  operations,
}: {
  sourceEntity: Entity;
  sourceId: string;
  relationKeys: readonly string[];
  operations: RelationWorkbenchOperations;
}) {
  const query = useQuery(
    operations.graph.queryOptions({
      roots: [{ entityType: sourceEntity, entityId: sourceId }],
      relationshipKeys: [...relationKeys],
      limit: 25,
    }),
  );

  if (query.isPending) {
    return <output className="text-sm text-muted-foreground">Loading…</output>;
  }
  if (query.isError) {
    return (
      <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
        Retry related records
      </Button>
    );
  }

  const nodes = new Map(
    query.data.nodes.map((node) => [
      `${node.entityType}:${node.entityId}`,
      node,
    ]),
  );
  const branches = query.data.branches.filter((branch) =>
    relationKeys.includes(branch.relationshipKey),
  );
  if (branches.every((branch) => branch.items.length === 0)) {
    return <p className="text-sm text-muted-foreground">No related records.</p>;
  }

  return (
    <Stack gap="sm">
      {branches.map((branch) => (
        <section key={branch.relationshipKey} aria-label={branch.label}>
          <Row align="center" justify="between" className="mb-1">
            <h3 className="font-mono text-2xs tracking-wider text-muted-foreground uppercase">
              {branch.label}
            </h3>
            <span className="font-mono text-2xs text-muted-foreground tabular-nums">
              {branch.totalCount}
            </span>
          </Row>
          <div className="border-y border-border">
            {branch.items.map((item) => {
              const node = nodes.get(`${item.entityType}:${item.entityId}`);
              const label = node?.label ?? item.entityId;
              return (
                <Row
                  key={`${item.entityType}:${item.entityId}`}
                  align="center"
                  gap="sm"
                  className="min-h-9 border-b border-border px-2 py-1 last:border-b-0"
                >
                  <EntityIdentityMark
                    entity={item.entityType}
                    displayImage={node?.image ?? null}
                    size="row"
                  />
                  {isBrowserRoutedEntity(item.entityType) ? (
                    <TableLink
                      // SAFETY: the browser-routed guard establishes that this entity has a detail route.
                      to={
                        browserEntityDefinition(item.entityType).routes
                          .detail as EntityDetailRoute
                      }
                      params={entityDetailParams(item.entityId)}
                      className="min-w-0 truncate"
                    >
                      {label}
                    </TableLink>
                  ) : (
                    <span className="min-w-0 truncate">{label}</span>
                  )}
                </Row>
              );
            })}
          </div>
        </section>
      ))}
    </Stack>
  );
}

/**
 * Adds lazy inspection only when provenance names an executable relation.
 * The summary is whatever the column renders — entity links, an inline edit
 * trigger, a quick-edit pencil — so the workbench control sits beside it
 * rather than around it.
 */
export function RelationFieldWorkbench({
  sourceEntity,
  sourceId,
  provenance,
  summary,
  operations = entityGraph,
}: {
  sourceEntity: Entity;
  sourceId: string;
  provenance: EntityFieldProvenance;
  summary: ReactNode;
  operations?: RelationWorkbenchOperations;
}) {
  if (!isInspectableFieldProvenance(provenance)) return summary;

  const relationKeys = provenance.sources.flatMap((source) =>
    source.relation ? [source.relation] : [],
  );

  const description = formatFieldProvenance(provenance);
  return (
    <TableCellWorkbench
      title="Related records"
      description={description}
      summary={summary}
      trigger="icon"
    >
      <RelatedRecords
        sourceEntity={sourceEntity}
        sourceId={sourceId}
        relationKeys={relationKeys}
        operations={operations}
      />
    </TableCellWorkbench>
  );
}
