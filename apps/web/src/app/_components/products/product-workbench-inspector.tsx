import { displayGtin } from "@cubby/schemas/external-id";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import {
  type ProductWithFoodOut,
  productWithFoodOut,
} from "@cubby/schemas/product";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FC, type ReactNode, useMemo, useState } from "react";

import { EntityActionButtons } from "~/app/_components/actions/entity-actions";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import {
  EntityInspectorFrame,
  type InspectorTab,
} from "~/app/_components/inspector-frame";
import { product as productOperations } from "~/app/products/product.functions";
import { EntityCover } from "~/components/entity/entity-cover";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { entityDetail } from "~/entities/entity-detail.functions";
import { formatCurrency } from "~/lib/utils";

import { tryFormatAmount } from "../inventory/format-amount";
import { CategoryLabel } from "./CategoryLabel";
import { heroPresence } from "./product-hero-presence";
import {
  ProductRelationshipRouteContent,
  type ProductRelationshipRouteOperations,
  useProductRelationshipRoute,
} from "./product-relationship-route";

/** Remote reads that make the inspector useful after its local frame mounts. */
export interface ProductWorkbenchInspectorOperations extends ProductRelationshipRouteOperations {
  productDetail: typeof entityDetail.detail;
}

const productionOperations: ProductWorkbenchInspectorOperations = {
  productDetail: entityDetail.detail.forEntity("product"),
  relationshipRoute: productOperations.relationshipRoute,
};

const Field: FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => (
  <div className="grid grid-cols-[7.25rem_minmax(0,1fr)] gap-2 border-b border-border py-1.5 last:border-b-0">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 text-right text-foreground">{children}</dd>
  </div>
);

const Overview: FC<{
  product: ProductWithFoodOut;
  relationshipQuery: ReturnType<typeof useProductRelationshipRoute>;
  onViewRelations: () => void;
}> = ({ product, relationshipQuery, onViewRelations }) => {
  const price = product.pricing.effectivePrice ?? product.price;
  const presence = heroPresence({
    entryCount: product.inventoryEntry.length,
    entryUnit: product.inventoryEntry[0]?.amount.unit,
    onHandUnits: product.onHandUnits,
    stockedLocationIds: product.inventoryEntry.map(
      (entry) => entry.location.id,
    ),
    identityLocationIds: product.servingAsLocations.map(
      (location) => location.id,
    ),
    componentCount: product.componentCount,
  });
  const unknownLedgerLines =
    product.quantityLedger.unknownAcquisitionLines +
    product.quantityLedger.unknownExitLines;

  return (
    <div className="space-y-3 px-3 py-3">
      <dl
        data-testid="product-inspector-truth"
        className="border-y border-border"
      >
        <Field label={presence.onHand.label}>
          <span className="font-mono tabular-nums">
            {presence.onHand.kind === "amount"
              ? tryFormatAmount(presence.onHand.amount)
              : `${presence.onHand.count} record${presence.onHand.count === 1 ? "" : "s"} (mixed units)`}
          </span>
        </Field>
        <Field label="Expected">
          <span className="font-mono tabular-nums">
            {product.quantityLedger.expectedQuantity}
          </span>
          {unknownLedgerLines > 0 ? (
            <span className="ml-1 text-muted-foreground">
              ({unknownLedgerLines} unknown ledger line
              {unknownLedgerLines === 1 ? "" : "s"})
            </span>
          ) : null}
        </Field>
        <Field label="Locations">
          <span className="font-mono tabular-nums">
            {presence.locationCount}
          </span>
        </Field>
      </dl>

      <ProductRelationshipRouteContent
        product={product}
        query={relationshipQuery}
        variant="strip"
        onViewAll={onViewRelations}
      />

      <div className="flex flex-wrap gap-2">
        <EntityActionButtons
          entity="product"
          record={{ id: product.id, name: product.name }}
          surface="inspector"
        />
      </div>

      <dl className="border-y border-border">
        <Field label="Category">
          <span className="inline-flex justify-end">
            <CategoryLabel category={product.category} />
          </span>
        </Field>
        <Field label="Manufacturer">{product.manufacturer || "—"}</Field>
        <Field label="Model">{product.model || "—"}</Field>
        <Field label="Price">
          {price === null ? "No price" : formatCurrency(price)}
          {product.pricing.source !== "none" ? (
            <span className="ml-1 text-muted-foreground">
              ({product.pricing.source})
            </span>
          ) : null}
        </Field>
        <Field label="Identifier">
          {product.primaryGtin ? displayGtin(product.primaryGtin) : "—"}
        </Field>
        <Field label="External IDs">
          {product.externalIds.length > 0
            ? product.externalIds
                .map(({ externalId, source }) => `${source}: ${externalId}`)
                .join(", ")
            : "—"}
        </Field>
        <Field label="Ingredient">
          {product.ingredient ? (
            <Link
              to="/ingredients/$shortcode"
              params={{ shortcode: product.ingredient.id }}
              className="text-primary underline-offset-2 hover:underline"
            >
              {product.ingredient.name}
            </Link>
          ) : (
            "—"
          )}
        </Field>
        <Field label="Tags">
          {product.tags.length > 0 ? (
            <span className="flex flex-wrap justify-end gap-1">
              {product.tags.map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </span>
          ) : (
            "—"
          )}
        </Field>
        <Field label="Recipe uses">
          <span className="font-mono tabular-nums">
            {product.recipeUsages.length}
          </span>
        </Field>
        <Field label="Kit components">
          <span className="font-mono tabular-nums">
            {product.componentCount}
          </span>
        </Field>
      </dl>

      {product.notes ? (
        <section className="border-t border-border pt-2">
          <h3 className="text-xs font-semibold text-foreground">Notes</h3>
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
            {product.notes}
          </p>
        </section>
      ) : null}
    </div>
  );
};

const Relations: FC<{
  product: ProductWithFoodOut;
  relationshipQuery: ReturnType<typeof useProductRelationshipRoute>;
}> = ({ product, relationshipQuery }) => (
  <div className="px-3 py-3">
    <ProductRelationshipRouteContent
      product={product}
      query={relationshipQuery}
    />
  </div>
);

function ProductInspectorContent({
  product,
  onClose,
  operations,
}: {
  product: ProductWithFoodOut;
  onClose?: () => void;
  operations: ProductWorkbenchInspectorOperations;
}) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("overview");
  const relationshipQuery = useProductRelationshipRoute(product.id, operations);
  const coverImage = product.images.find(isDisplayableImageFile);

  return (
    <EntityInspectorFrame
      entity="product"
      id={product.id}
      name={product.name}
      eyebrow={
        <span className="inline-flex items-center gap-1 text-2xs font-medium text-[var(--domain-pantry)]">
          <span
            aria-hidden
            className="size-1.5 rounded-full bg-[var(--domain-pantry)]"
          />
          Pantry
        </span>
      }
      leading={
        <EntityCover
          images={coverImage ? [coverImage] : []}
          entity="product"
          size={40}
          className="rounded-md border border-border"
        />
      }
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onClose={onClose}
      overview={
        <Overview
          product={product}
          relationshipQuery={relationshipQuery}
          onViewRelations={() => setActiveTab("relations")}
        />
      }
      relations={
        <Relations product={product} relationshipQuery={relationshipQuery} />
      }
      activity={
        <div className="px-3 py-3">
          <AuditLogList
            entityType="product"
            entityId={product.id}
            showEntityLink={false}
          />
        </div>
      }
    />
  );
}

function ProductInspectorState({
  productId,
  onClose,
  children,
}: {
  productId: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <EntityInspectorFrame
      entity="product"
      id={productId}
      activeTab="overview"
      onTabChange={() => undefined}
      onClose={onClose}
      overview={<div className="p-3 text-sm">{children}</div>}
    />
  );
}

export function ProductWorkbenchInspector({
  productId,
  onClose,
  operations = productionOperations,
}: {
  productId: string;
  onClose?: () => void;
  operations?: ProductWorkbenchInspectorOperations;
}) {
  const queryOptions = useMemo(
    () =>
      operations.productDetail.queryOptions({
        entity: "product",
        shortcode: productId,
      }),
    [operations.productDetail, productId],
  );
  const query = useQuery(queryOptions);
  const parsedProduct = productWithFoodOut.safeParse(query.data);
  const product = parsedProduct.success ? parsedProduct.data : undefined;

  if (query.isLoading) {
    return (
      <ProductInspectorState productId={productId} onClose={onClose}>
        <span className="text-muted-foreground">Loading product…</span>
      </ProductInspectorState>
    );
  }

  if (query.isError && !query.data) {
    return (
      <ProductInspectorState productId={productId} onClose={onClose}>
        <p className="text-muted-foreground">Product could not be loaded.</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </ProductInspectorState>
    );
  }

  if (!query.data) {
    return (
      <ProductInspectorState productId={productId} onClose={onClose}>
        <span className="text-muted-foreground">Product (deleted)</span>
      </ProductInspectorState>
    );
  }

  if (!product) {
    return (
      <ProductInspectorState productId={productId} onClose={onClose}>
        <span className="text-muted-foreground">
          Product could not be loaded.
        </span>
      </ProductInspectorState>
    );
  }

  return (
    <ProductInspectorContent
      product={product}
      onClose={onClose}
      operations={operations}
    />
  );
}
