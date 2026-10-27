import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { Link } from "@tanstack/react-router";

import {
  EntityRefLink,
  EntityFilterLink,
} from "~/entity/components/entity-ref-link";
import { ProductExternalIds } from "~/entity/components/product-external-ids";
import {
  ProductGtin,
  productGtinLabel,
} from "~/entity/components/product-gtin";
import { ProductCostValue } from "~/entity/display/product-cost-value";
import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/entity/entity-media/entity-display-images";
import { CategoryLabel } from "~/entity/presentation/category-label";
import { Row } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";

import type { EntityDetailFieldRenderers } from "./index";

function ProductIngredientLink({
  ingredient,
}: {
  ingredient: { id: string; name: string };
}) {
  const displayImages = useEntityDisplayImages([
    { entityKind: "ingredient", entityId: ingredient.id },
  ]);
  return (
    <EntityRefLink
      displayImage={
        displayImages[
          entityDisplayImageKey({
            entityKind: "ingredient",
            entityId: ingredient.id,
          })
        ] ?? null
      }
      entity="ingredient"
      data={ingredient}
    />
  );
}

export const productDetailFields = {
  "product-cost": (product) => ({
    value: <ProductCostValue envelope={product.fields.cost} />,
  }),
  "product-id": (product) => ({
    value: <span className="font-mono text-xs">{product.id}</span>,
  }),
  // The full path ("Apparel / Clothes / Pants"), as the list column and the
  // picker show it — the reference link's bare leaf name loses the hierarchy
  // that is the whole point of the classification. `filterAction` is left
  // to the generic "Show all products with classification …" link.
  "product-category": (product) => ({
    value: product.category ? (
      <CategoryLabel category={product.category} />
    ) : undefined,
  }),
  "product-primary-gtin": (product) => {
    const effectiveProductPrimaryGtin = fieldValueOf(
      product.fields.primaryGtin,
    );
    return {
      label: productGtinLabel(effectiveProductPrimaryGtin),
      value: effectiveProductPrimaryGtin ? (
        <ProductGtin gtin={effectiveProductPrimaryGtin} />
      ) : undefined,
    };
  },
  "product-fdc-id": (product) => ({
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
  "product-ingredient": (product) => {
    const effectiveProductFood = fieldValueOf(product.fields.food);
    return {
      value: product.ingredient ? (
        <Row gap="sm" wrap>
          <ProductIngredientLink ingredient={product.ingredient} />
          {effectiveProductFood ? (
            <EntityRefLink entity="usda-food" data={effectiveProductFood} />
          ) : null}
        </Row>
      ) : undefined,
    };
  },
  // `{ source, kind, externalId, url }` rows, not the plain string list the
  // field kind implies — this renderer is what keeps the page from parsing
  // them as strings.
  "product-external-ids": (product) => ({
    value:
      product.externalIds.length > 0 ? (
        <ProductExternalIds identifiers={product.externalIds} />
      ) : undefined,
  }),
  "product-tags": (product) => {
    const tags = fieldValueOf(product.fields.tags) ?? [];
    return {
      filterAction: null,
      value:
        tags.length > 0 ? (
          <Row gap="xs" wrap justify="end">
            {tags.map((tag) => (
              <EntityFilterLink
                key={tag}
                to="/products"
                search={{ tags: tag }}
                label={`Show all products tagged ${tag}`}
                display="value"
                className="no-underline"
              >
                <Badge variant="outline">{tag}</Badge>
              </EntityFilterLink>
            ))}
          </Row>
        ) : undefined,
    };
  },
} satisfies EntityDetailFieldRenderers<"product">;
