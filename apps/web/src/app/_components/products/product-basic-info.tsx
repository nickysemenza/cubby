import type { ProductWithFoodOut } from "@cubby/schemas/product-responses";
import { Link } from "@tanstack/react-router";
import { Package } from "lucide-react";
import type { FC } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { getErrorMessage } from "~/lib/error-utils";
import { queryKeys } from "~/lib/query-keys";
import { savedWithRecompute } from "~/lib/recompute-summary";
import { formatCurrency } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import { EditableCell } from "../data-table/editable-cell";
import { EntityPillLink } from "../EntityPill";
import { EntityPillLinkList } from "../EntityPillLinkList";
import { useEntityDelete } from "../hooks/useEntityDelete";
import { NoneState } from "../NoneState";
import { PrintLabelButton } from "../print-label-button";
import { CategoryBadge } from "./CategoryBadge";
import { productCategoryOptionsWithTheme } from "./product-category-icons";

interface ProductBasicInfoProps {
  product: ProductWithFoodOut;
  onEdit: () => void;
}

export const ProductBasicInfo: FC<ProductBasicInfoProps> = ({
  product,
  onEdit,
}) => {
  const api = useTRPC();

  // Mutation for inline editing (price, category, etc.)
  const updateProductMutation = useActionMutation({
    mutationFn: api.product.update.mutationOptions,
    // Surface the eager recompute (dependent recipes / inventory valuations).
    success: (data) => savedWithRecompute(data.sideEffects),
    // location.all: a price change recomputes persisted per-location valuations.
    invalidateKeys: [
      queryKeys.product.all,
      queryKeys.recipe.list,
      queryKeys.location.all,
    ],
    error: (err) => getErrorMessage(err) || "Failed to update product",
  });

  const { DeleteButton, DeleteDialog } = useEntityDelete({
    id: product.id,
    name: product.name,
    entityLabel: "Product",
    mutationOptions: (callbacks) =>
      api.product.delete.mutationOptions(callbacks),
    invalidateKeys: [queryKeys.product.all],
    redirectTo: "/products",
  });

  const fields: BasicInfoField[] = [
    { label: "Name", value: product.name },
    // Shortcode (if assigned)
    ...(product.shortcode
      ? [
          {
            label: "Shortcode",
            value: (
              <span className="font-mono text-xs">{product.shortcode}</span>
            ),
          },
        ]
      : []),
    { label: "Manufacturer", value: product.manufacturer },
    { label: "Model", value: product.model },
    { label: "Notes", value: product.notes },
    {
      label: "Price",
      value: (
        <EditableCell
          value={product.price}
          onSave={async (newPrice) => {
            await updateProductMutation.mutateAsync({
              id: product.id,
              data: { price: newPrice },
            });
          }}
          config={{ type: "currency" }}
          renderValue={(v) => (v !== null ? formatCurrency(v) : <NoneState />)}
        />
      ),
    },
    {
      label: "Category",
      value: (
        <EditableCell
          value={product.category}
          onSave={async (newCategory) => {
            await updateProductMutation.mutateAsync({
              id: product.id,
              data: { category: newCategory },
            });
          }}
          config={{
            type: "select",
            options: productCategoryOptionsWithTheme,
            placeholder: "Select category...",
          }}
          renderValue={(cat) => <CategoryBadge category={cat} />}
        />
      ),
    },
    {
      label: "UPC",
      value: product.upc ? (
        <Link
          to="/usda/upc/$code"
          params={{ code: product.upc }}
          className="text-primary hover:underline"
        >
          {product.upc}
        </Link>
      ) : undefined,
    },
    {
      label: "USDA FDC ID",
      value: product.fdc_id ? (
        <Link
          to="/usda/$id"
          params={{ id: String(product.fdc_id) }}
          className="text-primary hover:underline"
        >
          {product.fdc_id}
        </Link>
      ) : undefined,
    },
    {
      label: "Ingredient",
      value: product.ingredient ? (
        <EntityPillLink
          entity="ingredient"
          data={{
            name: product.ingredient.name,
            id: product.ingredient.id,
          }}
        />
      ) : undefined,
    },
    {
      label: "USDA Food",
      value: product.food ? (
        <EntityPillLink entity="usda-food" data={product.food} />
      ) : undefined,
    },
    ...(product.externalIds && product.externalIds.length > 0
      ? [
          {
            label: "External IDs",
            value: (
              <div className="flex flex-wrap gap-x-2 gap-y-1 font-mono text-xs">
                {product.externalIds.map((eid) => {
                  const label = `${eid.source}: ${eid.externalId}`;
                  return eid.url ? (
                    <a
                      key={eid.id}
                      href={eid.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      {label}
                    </a>
                  ) : (
                    <span key={eid.id} className="text-muted-foreground">
                      {label}
                    </span>
                  );
                })}
              </div>
            ),
          },
        ]
      : []),
    {
      label: "Inventory Locations",
      value:
        product.inventoryEntry && product.inventoryEntry.length > 0 ? (
          <Row gap="xs" wrap className="mt-1">
            <EntityPillLinkList
              entity="location"
              items={product.inventoryEntry.map((entry) => ({
                id: entry.location.id,
                name: entry.location.name,
                type: entry.location.type,
              }))}
            />
          </Row>
        ) : undefined,
    },
  ];

  return (
    <>
      <BasicInfo
        fields={fields}
        actions={
          <Row gap="sm">
            <Button onClick={onEdit}>Edit</Button>
            <Button
              variant="outline"
              render={
                <Link
                  to="/inventory/quick-capture"
                  search={{ productId: product.id }}
                />
              }
              nativeButton={false}
            >
              <Package className="mr-2 h-4 w-4" />
              Add to Inventory
            </Button>
            <PrintLabelButton shortcode={product.shortcode} />
            <DeleteButton />
          </Row>
        }
      />
      <DeleteDialog />
    </>
  );
};
