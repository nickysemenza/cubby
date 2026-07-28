import type { ImageOut } from "@cubby/schemas/image";
import type { ProductWithFoodOut } from "@cubby/schemas/product";
import { Link } from "@tanstack/react-router";
import type { FC } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import {
  productMutationInvalidateKeys,
  productValuationMutationInvalidateKeys,
} from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { formatCurrency } from "~/lib/utils";
import { EditableCell } from "../data-table/editable-cell";
import { EntityInlineLink } from "../EntityInlineLink";
import { useEntityDelete } from "../hooks/useEntityDelete";
import { PrintLabelButton } from "../print-label-button";
import { CategoryLabel } from "./CategoryLabel";
import { PriceSuggestion } from "./price-suggestion";
import { productCategoryOptionsWithTheme } from "./product-category-icons";
import { ProductNotesMarkdown } from "./product-notes-markdown";

interface ProductBasicInfoProps {
  product: ProductWithFoodOut;
  onEdit: () => void;
  /** Attached PDF manuals, for resolving [[wiki links]] in the notes. */
  documents?: ImageOut[];
  /** Notes wiki-link click → jump the inline Manuals viewer to that page. */
  onManualLink?: (documentId: string, page: number) => void;
}

const NO_DOCUMENTS: ImageOut[] = [];

export const ProductBasicInfo: FC<ProductBasicInfoProps> = ({
  product,
  onEdit,
  documents = NO_DOCUMENTS,
  onManualLink,
}) => {
  const api = useTRPC();

  // Mutation for inline editing (price, category, etc.)
  const updateProductMutation = useActionMutation({
    mutationFn: api.product.update.mutationOptions,
    // Surface the eager recompute (dependent recipes / inventory valuations).
    success: (data) => savedWithBackgroundWork(data.sideEffects),
    invalidateKeys: productValuationMutationInvalidateKeys,
    error: (err) => getErrorMessage(err) || "Failed to update product",
  });

  const { DeleteButton, DeleteDialog } = useEntityDelete({
    id: product.id,
    name: product.name,
    entityLabel: "Product",
    mutationOptions: (callbacks) =>
      api.product.delete.mutationOptions(callbacks),
    invalidateKeys: productMutationInvalidateKeys,
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
          renderValue={(v) => (v !== null ? formatCurrency(v) : <NoneValue />)}
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
          renderValue={(cat) => <CategoryLabel category={cat} />}
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
        <EntityInlineLink
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
        <EntityInlineLink entity="usda-food" data={product.food} />
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
  ];

  return (
    <>
      <BasicInfo
        fields={fields}
        // Notes and the price suggestion render as blocks below the fact rows —
        // InfoRow's right-aligned value span is hostile to multi-line markdown
        // and to anything with its own action button.
        footer={
          <Stack gap="sm">
            {product.notes ? (
              <Stack gap="xs">
                <p className="eyebrow my-0">Notes</p>
                <ProductNotesMarkdown
                  notes={product.notes}
                  documents={documents}
                  onManualLink={onManualLink}
                />
              </Stack>
            ) : null}
            <PriceSuggestion
              product={product}
              isPending={updateProductMutation.isPending}
              onAccept={async (price) => {
                await updateProductMutation.mutateAsync({
                  id: product.id,
                  data: { price },
                });
              }}
            />
          </Stack>
        }
        actions={
          // Add to Inventory lives on the Stocked At section header now —
          // this cluster is product-record actions only.
          <Row gap="sm">
            <Button onClick={onEdit}>Edit</Button>
            <PrintLabelButton shortcode={product.shortcode} />
            <DeleteButton />
          </Row>
        }
      />
      <DeleteDialog />
    </>
  );
};
