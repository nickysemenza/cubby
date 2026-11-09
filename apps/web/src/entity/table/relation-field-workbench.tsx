import type { Entity } from "@cubby/schemas/entity";
import type { EntityFieldProvenance } from "@cubby/schemas/entity-fields";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { isBrowserRoutedEntity } from "~/entity/entities";
import {
  formatFieldProvenance,
  isInspectableFieldProvenance,
} from "~/entity/fields/field-provenance";
import { entityGraph } from "~/integrations/tanstack-query/generated/domains/entityGraph.gen";
import { EmptyState } from "~/ui/feedback/empty-state";
import { Row, Stack } from "~/ui/layout";
import { Section } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

import { TableCellWorkbench } from "../../ui/data-table/table-cell-workbench";

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
      roots: [{ entityKind: sourceEntity, entityId: sourceId }],
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
      `${node.entityKind}:${node.entityId}`,
      node,
    ]),
  );
  const branches = query.data.branches.filter((branch) =>
    relationKeys.includes(branch.relationshipKey),
  );
  if (branches.every((branch) => branch.items.length === 0)) {
    return <EmptyState size="inline">No related records.</EmptyState>;
  }

  return (
    <Stack gap="sm">
      {branches.map((branch) => (
        <Section
          key={branch.relationshipKey}
          title={branch.label}
          headingAs="h3"
          compact
          count={branch.totalCount}
          ruled
        >
          <div className="border-y border-border">
            {branch.items.map((item) => {
              const node = nodes.get(`${item.entityKind}:${item.entityId}`);
              const label = node?.label ?? item.entityId;
              return (
                <Row
                  key={`${item.entityKind}:${item.entityId}`}
                  align="center"
                  gap="sm"
                  className="min-h-9 border-b border-border px-2 py-1 last:border-b-0"
                >
                  {isBrowserRoutedEntity(item.entityKind) ? (
                    <EntityRefLink
                      entity={item.entityKind}
                      id={item.entityId}
                      name={label}
                      displayImage={node?.image ?? null}
                    />
                  ) : (
                    <span className="min-w-0 truncate">{label}</span>
                  )}
                </Row>
              );
            })}
          </div>
        </Section>
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
