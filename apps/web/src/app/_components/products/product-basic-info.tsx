import type { ImageOut } from "@cubby/schemas/image";
import type { ProductWithFoodOut } from "@cubby/schemas/product";
import {
  collectionSlugFromTag,
  formatCollectionLabel,
} from "@cubby/shared/collection-tag";
import { Link } from "@tanstack/react-router";
import type { FC } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import {
  productMutationInvalidateKeys,
  productValuationMutationInvalidateKeys,
} from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import {
  describeProductPricingSource,
  productPriceClearLabel,
  renderProductPriceValue,
} from "../data-table/columnHelpers";
import { EditableCell } from "../data-table/editable-cell";
import { EntityInlineLink } from "../EntityInlineLink";
import { useEntityDelete } from "../hooks/useEntityDelete";
import { PrintLabelButton } from "../print-label-button";
import { CategoryLabel } from "./CategoryLabel";
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
    entity: "product",
    operation: "update",
    intent: "full",
    mutationFn: api.product.update.mutationOptions,
    // Surface the eager recompute (dependent recipes / inventory valuations).
    success: (data) => savedWithBackgroundWork(data.sideEffects),
    invalidateKeys: productValuationMutationInvalidateKeys,
    error: (err) => getErrorMessage(err) || "Failed to update product",
  });

  const { deleteButton, deleteDialog } = useEntityDelete({
    id: product.id,
    name: product.name,
    entityLabel: "Product",
    entity: "product",
    mutationOptions: (callbacks) =>
      api.product.delete.mutationOptions(callbacks),
    invalidateKeys: productMutationInvalidateKeys,
    redirectTo: "/products",
  });

  const fields: BasicInfoField[] = [
    { label: "Name", value: product.name },
    // Shortcode (if assigned)
    ...(product.id
      ? [
          {
            label: "Shortcode",
            value: <span className="font-mono text-xs">{product.id}</span>,
          },
        ]
      : []),
    {
      label: "Manufacturer",
      value: product.manufacturer ? (
        <EntityFilterLink
          to="/products"
          search={{ view: "table", manufacturer: product.manufacturer }}
          label={`Show all products by ${product.manufacturer}`}
          variant="value"
        >
          {product.manufacturer}
        </EntityFilterLink>
      ) : undefined,
    },
    {
      label: "Model",
      value: product.model ? (
        <EntityFilterLink
          to="/products"
          search={{ view: "table", model: product.model }}
          label={`Show all products matching model ${product.model}`}
          variant="value"
        >
          {product.model}
        </EntityFilterLink>
      ) : undefined,
    },
    {
      label: "Valuation price",
      value: (
        <Stack gap="xs">
          <EditableCell
            value={product.price}
            onSave={async (newPrice) => {
              await updateProductMutation.mutateAsync({
                id: product.id,
                data: { price: newPrice },
              });
            }}
            config={{
              type: "currency",
              clearable: { label: productPriceClearLabel(product.pricing) },
            }}
            renderValue={() => renderProductPriceValue(product.pricing)}
          />
          <span className="text-muted-foreground text-xs">
            {describeProductPricingSource(product.pricing)}
          </span>
        </Stack>
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
      filterAction: product.category ? (
        <EntityFilterLink
          to="/products"
          search={{ view: "table", category: product.category }}
          label={`Show all products in ${product.category}`}
        />
      ) : undefined,
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
      filterAction: product.ingredient ? (
        <EntityFilterLink
          to="/products"
          search={{ view: "table", ingredient: product.ingredient.id }}
          label={`Show all products for ${product.ingredient.name}`}
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
                  const label = `${eid.source} (${eid.kind.replaceAll("_", " ")}): ${eid.externalId}`;
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
    ...(product.tags.length > 0
      ? [
          {
            label: "Tags",
            value: (
              <Row gap="xs" wrap justify="end">
                {product.tags.map((tag) => {
                  const collection = collectionSlugFromTag(tag);
                  return collection ? (
                    <Link
                      key={tag}
                      to="/collections/$collection"
                      params={{ collection }}
                      aria-label={`Open ${formatCollectionLabel(collection)} Collection`}
                    >
                      <Badge variant="secondary">
                        {formatCollectionLabel(collection)}
                      </Badge>
                    </Link>
                  ) : (
                    <EntityFilterLink
                      key={tag}
                      to="/products"
                      search={{ view: "table", tags: tag }}
                      label={`Show all products tagged ${tag}`}
                      variant="value"
                      className="no-underline"
                    >
                      <Badge variant="outline">{tag}</Badge>
                    </EntityFilterLink>
                  );
                })}
              </Row>
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
          </Stack>
        }
        actions={
          // Add to Inventory lives on the Stocked At section header now —
          // this cluster is product-record actions only.
          <Row gap="sm">
            <DetailEditAction onClick={onEdit} />
            <PrintLabelButton shortcode={product.id} />
            {deleteButton}
          </Row>
        }
      />
      {deleteDialog}
    </>
  );
};
