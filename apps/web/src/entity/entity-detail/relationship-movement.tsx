import type { Entity } from "@cubby/schemas/entity";
import type { ProductMovementKind } from "@cubby/schemas/product";
import type { ProductPurchaseOut } from "@cubby/schemas/purchase";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import type { z } from "zod";

import type { generatedEntityRelationListOutputSchema } from "~/entity/generated/entity-relation-lists.gen";
import { entityGraph } from "~/integrations/tanstack-query/generated/catalog.gen";
import { Badge } from "~/ui/primitives/badge";

import { CellFrame } from "../../ui/data-table/cell-frame";
type MovementEvidence = Pick<
  ProductPurchaseOut,
  "movementKinds" | "hasPlanned" | "source"
>;
export interface RelationshipMovementOperations {
  relation?: typeof entityGraph.relation;
}

export function relationshipMovementSource(
  source: Entity,
  target: Entity,
  relation: string,
): "purchase" | "product" | null {
  if (source === "purchase" && target === "product" && relation === "products")
    return "purchase";
  if (source === "product" && target === "purchase" && relation === "purchases")
    return "product";
  return null;
}

const MovementContext = createContext<{
  rows: Map<string, MovementEvidence>;
  pending: boolean;
} | null>(null);
const KIND_LABEL = {
  linked: "Linked",
  acquired: "Acquired",
  exited: "Exited",
  discarded: "Discarded",
  adjusted: "Price adjusted",
  unknown: "Unknown movement",
} satisfies Record<ProductMovementKind, string>;

export function RelationshipMovementBadges({
  id,
  compact = false,
}: {
  id: string;
  compact?: boolean;
}) {
  const context = useContext(MovementContext);
  const evidence = context?.rows.get(id);
  if (!evidence)
    return (
      <span className="text-muted-foreground">
        {context?.pending ? "Loading movement…" : "—"}
      </span>
    );
  const labels = evidence.movementKinds.map((kind) => KIND_LABEL[kind]);
  if (labels.length === 0 && evidence.source !== "expense")
    labels.push("Linked");
  if (evidence.hasPlanned) labels.push("Planned");
  const badges = (
    <span
      className={
        compact
          ? "inline-flex items-center gap-1"
          : "inline-flex flex-wrap items-center gap-1"
      }
      title={labels.join(" · ")}
    >
      {labels.map((label) => (
        <Badge key={label} variant="outline">
          {label}
        </Badge>
      ))}
    </span>
  );
  return compact ? <CellFrame trailing={null}>{badges}</CellFrame> : badges;
}

function combineMovementQueries(
  queries: UseQueryResult<
    z.infer<typeof generatedEntityRelationListOutputSchema>
  >[],
) {
  const rows = new Map<string, MovementEvidence>();
  for (const query of queries)
    for (const row of query.data?.items ?? []) {
      if (
        !("movementKinds" in row) ||
        !("hasPlanned" in row) ||
        !("source" in row)
      )
        continue;
      const id =
        "productId" in row
          ? row.productId
          : "purchaseId" in row
            ? row.purchaseId
            : null;
      if (typeof id === "string") rows.set(id, row);
    }
  return {
    rows,
    pending: queries.some((query) => query.isPending),
    errors: queries
      .filter((query) => query.isError)
      .map((query) => query.error),
  };
}

/** Read only the currently rendered targets, in bounded batches. */
export function RelationshipMovementProvider({
  source,
  recordId,
  targetIds,
  operations,
  children,
}: {
  source: "purchase" | "product" | null;
  recordId: string;
  targetIds: string[];
  operations: RelationshipMovementOperations;
  children: ReactNode;
}) {
  const ids = [...new Set(targetIds)].sort();
  const batches = Array.from(
    { length: source ? Math.ceil(ids.length / 50) : 0 },
    (_, index) => ids.slice(index * 50, (index + 1) * 50),
  );
  const evidence = useQueries({
    combine: combineMovementQueries,
    queries:
      source === null
        ? []
        : batches.map((targetIds) =>
            (operations.relation ?? entityGraph.relation).queryOptions({
              entity: source,
              relation: source === "purchase" ? "products" : "purchases",
              id: recordId,
              targetIds,
              offset: 0,
              limit: 50,
            }),
          ),
  });
  return (
    <MovementContext.Provider value={evidence}>
      {children}
      {[...new Set(evidence.errors.map(String))].map((error) => (
        <p key={error} role="alert" className="text-xs text-destructive">
          Could not load movement evidence: {error}
        </p>
      ))}
    </MovementContext.Provider>
  );
}
