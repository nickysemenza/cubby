import type { Entity } from "@cubby/schemas/entity";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ProductMovementKind } from "@cubby/schemas/product";
import type { ProductPurchaseOut } from "@cubby/schemas/purchase";
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";

import {
  product as productOperations,
  purchase as purchaseOperations,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { Badge } from "~/ui/primitives/badge";

import { CellFrame } from "../../ui/data-table/cell-frame";
type MovementEvidence = Pick<
  ProductPurchaseOut,
  "movementKinds" | "hasPlanned" | "source"
>;
export interface RelationshipMovementOperations {
  purchaseProducts?: typeof purchaseOperations.products;
  productPurchases?: typeof productOperations.purchases;
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

type ProviderProps = {
  recordId: string;
  operations: RelationshipMovementOperations;
  children: ReactNode;
};

function PurchaseMovementProvider({
  recordId,
  operations,
  children,
}: ProviderProps) {
  const query = useQuery(
    (operations.purchaseProducts ?? purchaseOperations.products).queryOptions({
      purchaseId: parseShortcodeFor("purchase", recordId),
    }),
  );
  return (
    <MovementContext.Provider
      value={{
        rows: new Map(query.data?.map((row) => [row.productId, row])),
        pending: query.isPending,
      }}
    >
      {children}
      {query.isError ? (
        <p role="alert" className="text-xs text-destructive">
          Could not load movement evidence: {String(query.error)}
        </p>
      ) : null}
    </MovementContext.Provider>
  );
}

function ProductMovementProvider({
  recordId,
  operations,
  children,
}: ProviderProps) {
  const query = useQuery(
    (operations.productPurchases ?? productOperations.purchases).queryOptions({
      productId: parseShortcodeFor("product", recordId),
    }),
  );
  return (
    <MovementContext.Provider
      value={{
        rows: new Map(query.data?.map((row) => [row.purchaseId, row])),
        pending: query.isPending,
      }}
    >
      {children}
      {query.isError ? (
        <p role="alert" className="text-xs text-destructive">
          Could not load movement evidence: {String(query.error)}
        </p>
      ) : null}
    </MovementContext.Provider>
  );
}

/** One cached relation read per source supplies both desktop and phone rows. */
export function RelationshipMovementProvider({
  source,
  ...props
}: ProviderProps & { source: "purchase" | "product" | null }) {
  if (source === "purchase") return <PurchaseMovementProvider {...props} />;
  if (source === "product") return <ProductMovementProvider {...props} />;
  return props.children;
}
