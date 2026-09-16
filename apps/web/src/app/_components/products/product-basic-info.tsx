import { displayGtin } from "@cubby/schemas/external-id";
import type { ImageOut } from "@cubby/schemas/image";
import {
  productCategory,
  type ProductWithFoodOut,
} from "@cubby/schemas/product";
import {
  collectionSlugFromTag,
  formatCollectionLabel,
} from "@cubby/shared/collection-tag";
import { Link } from "@tanstack/react-router";
import type { FC } from "react";

import { useEntityActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import {
  EntityBasicInfo,
  entitySectionFields,
} from "~/entities/entity-display";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { wasm } from "~/lib/wasm";

import {
  describeProductPricingSource,
  productPriceClearLabel,
  renderProductPriceValue,
} from "../data-table/columnHelpers";
import { EditableCell } from "../data-table/editable-cell";
import { EntityInlineLink } from "../EntityInlineLink";
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
const productUpdateMutationOptions = entityMutationOptionsFactory(
  "product",
  "update",
);

export const ProductBasicInfo: FC<ProductBasicInfoProps> = ({
  product,
  onEdit,
  documents = NO_DOCUMENTS,
  onManualLink,
}) => {
  const category = productCategory
    .nullable()
    .catch(null)
    .parse(product.category);
  const primaryIsbn = product.primaryGtin
    ? wasm.isbn_from_gtin(product.primaryGtin)
    : null;

  // Mutation for inline editing (price, category, etc.)
  const updateProductMutation = useEntityActionMutation({
    entity: "product",
    operation: "update",
    intent: "full",
    mutationFn: productUpdateMutationOptions,
    // Surface the eager recompute (dependent recipes / inventory valuations).
    success: (data) => savedWithBackgroundWork(data.sideEffects),
    error: (err) => getErrorMessage(err) || "Failed to update product",
  });

  const overrides = {
    id: () => ({
      value: product.id ? (
        <span className="font-mono text-xs">{product.id}</span>
      ) : undefined,
    }),
    manufacturer: () => ({
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
    }),
    model: () => ({
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
    }),
    price: () => ({
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
          <span className="text-xs text-muted-foreground">
            {describeProductPricingSource(product.pricing)}
          </span>
        </Stack>
      ),
    }),
    category: () => ({
      value: (
        <EditableCell
          value={category}
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
      filterAction: category ? (
        <EntityFilterLink
          to="/products"
          search={{ view: "table", category }}
          label={`Show all products in ${category}`}
        />
      ) : undefined,
    }),
    primaryGtin: () => ({
      label: primaryIsbn ? "ISBN-13" : "UPC",
      // Rendered as the printed encoding, not the stored GTIN-14 — the operator
      // is comparing this against the barcode on the package, and the USDA page
      // is keyed the same way.
      value: primaryIsbn ? (
        <span className="font-mono tabular-nums">{primaryIsbn.isbn13}</span>
      ) : product.primaryGtin ? (
        <Link
          to="/usda/upc/$code"
          params={{ code: displayGtin(product.primaryGtin) }}
          className="text-primary hover:underline"
        >
          {displayGtin(product.primaryGtin)}
        </Link>
      ) : undefined,
    }),
    fdc_id: () => ({
      value: product.fdc_id ? (
        <Link
          to="/usda/$id"
          params={{ id: String(product.fdc_id) }}
          className="text-primary hover:underline"
        >
          {product.fdc_id}
        </Link>
      ) : undefined,
    }),
    ingredientId: () => ({
      value: product.ingredient ? (
        <EntityInlineLink
          displayImage={undefined}
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
    }),
    externalIds: () => ({
      value:
        product.externalIds && product.externalIds.length > 0 ? (
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
        ) : undefined,
    }),
    tags: () => ({
      value:
        product.tags.length > 0 ? (
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
        ) : undefined,
    }),
  };

  return (
    <EntityBasicInfo
      entity="product"
      fields={entitySectionFields("product", "basic-information")}
      record={product}
      overrides={overrides}
      afterFields={{
        ingredientId: [
          {
            label: "USDA Food",
            value: product.food ? (
              <EntityInlineLink
                displayImage={undefined}
                entity="usda-food"
                data={product.food}
              />
            ) : undefined,
          },
        ],
      }}
      // Notes and the price suggestion render as blocks below the fact rows —
      // InfoRow's right-aligned value span is hostile to multi-line markdown
      // and to anything with its own action button.
      footer={
        <Stack gap="sm">
          {product.notes ? (
            <Stack gap="xs">
              <p className="my-0 eyebrow">Notes</p>
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
        // Inventory and lifecycle verbs live in the shared detail command
        // strip; this local action only edits the Product record itself.
        <Row gap="sm">
          <DetailEditAction onClick={onEdit} />
        </Row>
      }
    />
  );
};
