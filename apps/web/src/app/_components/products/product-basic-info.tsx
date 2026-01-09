import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download } from "lucide-react";
import type { FC } from "react";
import { toast } from "sonner";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { downloadLabel } from "~/lib/label-generator";
import { queryKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { syncPriceToMappings } from "~/schemas/price-mapping-utils";
import type { ProductWithFoodOut } from "~/server/services/product.service";
import { useTRPC } from "~/trpc/react";
import { EditableCell } from "../data-table/editable-cell";
import { EntityPillLink } from "../EntityPill";
import { EntityPillLinkList } from "../EntityPillLinkList";
import { useEntityDelete } from "../hooks/useEntityDelete";
import { NoneState } from "../NoneState";
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
  const queryClient = useQueryClient();

  // Mutation for inline editing (price, category, etc.)
  const updateProductMutation = useMutation(
    api.product.update.mutationOptions({
      onSuccess: () => {
        toast.success("Product updated");
        void queryClient.invalidateQueries({
          queryKey: queryKeys.product.list,
        });
      },
      onError: (err) => {
        toast.error(err.message || "Failed to update product");
      },
    }),
  );

  const { DeleteButton, DeleteDialog } = useEntityDelete({
    id: product.id,
    name: product.name,
    entityLabel: "Product",
    mutationOptions: (callbacks) =>
      api.product.delete.mutationOptions(callbacks),
    invalidateKeys: [queryKeys.product.list],
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
              <Badge variant="secondary" className="font-mono">
                {product.shortcode}
              </Badge>
            ),
          },
        ]
      : []),
    { label: "Manufacturer", value: product.manufacturer },
    { label: "Model", value: product.model },
    {
      label: "Price",
      value: (
        <EditableCell
          value={product.price}
          onSave={async (newPrice) => {
            // Sync price to unitMappings (canonical way to set price)
            const updatedMappings = syncPriceToMappings(
              product.unitMappings,
              newPrice !== null ? { value: newPrice, unit: "dollar" } : null,
              "inline-edit",
            );
            await updateProductMutation.mutateAsync({
              id: product.id,
              data: { unitMappings: updatedMappings },
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
      label: "NDB Number",
      value: product.ndb_number ? (
        <Link
          to="/usda/ndb/$code"
          params={{ code: String(product.ndb_number) }}
          className="text-primary hover:underline"
        >
          {product.ndb_number}
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
    {
      label: "Inventory Locations",
      value:
        product.inventoryEntry && product.inventoryEntry.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            <EntityPillLinkList
              entity="location"
              items={product.inventoryEntry.map((entry) => ({
                id: entry.location.id,
                name: entry.location.name,
                type: entry.location.type,
              }))}
            />
          </div>
        ) : undefined,
    },
  ];

  return (
    <>
      <BasicInfo
        fields={fields}
        actions={
          <div className="flex gap-2">
            <Button onClick={onEdit}>Edit</Button>
            {product.shortcode && (
              <Button
                variant="outline"
                onClick={() =>
                  downloadLabel({
                    shortcode: product.shortcode!,
                    name: product.name,
                  })
                }
              >
                <Download className="mr-2 h-4 w-4" />
                Download Label
              </Button>
            )}
            <DeleteButton />
          </div>
        }
      />
      <DeleteDialog />
    </>
  );
};
