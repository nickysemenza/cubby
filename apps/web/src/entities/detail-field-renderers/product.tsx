import { displayGtin } from "@cubby/schemas/external-id";
import {
  collectionSlugFromTag,
  formatCollectionLabel,
} from "@cubby/shared/collection-tag";
import { Link } from "@tanstack/react-router";

import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/app/_components/entity-media/entity-display-images";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { CategoryLabel } from "~/app/_components/products/CategoryLabel";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { wasm } from "~/lib/wasm";

import type { EntityDetailFieldRenderers } from "./index";

function ProductIngredientLink({
  ingredient,
}: {
  ingredient: { id: string; name: string };
}) {
  const displayImages = useEntityDisplayImages([
    { entityType: "ingredient", entityId: ingredient.id },
  ]);
  return (
    <EntityInlineLink
      displayImage={
        displayImages[
          entityDisplayImageKey({
            entityType: "ingredient",
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
  "product-id": (product) => ({
    value: <span className="font-mono text-xs">{product.id}</span>,
  }),
  // The full path ("Apparel / Clothes / Pants"), as the list column and the
  // picker show it — the reference link's bare leaf name loses the hierarchy
  // that is the whole point of the classification. `filterAction` is left
  // to the generic "Show all products with classification …" link.
  "product-category": (product) => ({
    value: product.category ? (
      <Link
        to="/product-categories/$shortcode"
        params={{ shortcode: product.category.id }}
      >
        <CategoryLabel category={product.category} />
      </Link>
    ) : undefined,
  }),
  // Rendered as the printed encoding, not the stored GTIN-14 — the operator
  // is comparing this against the barcode on the package, and the USDA page
  // is keyed the same way. A book barcode reads as its ISBN-13.
  "product-primary-gtin": (product) => {
    const isbn = product.primaryGtin
      ? wasm.isbn_from_gtin(product.primaryGtin)
      : null;
    return {
      label: isbn ? "ISBN-13" : "UPC",
      value: isbn ? (
        <span className="font-mono tabular-nums">{isbn.isbn13}</span>
      ) : product.primaryGtin ? (
        <Link
          to="/usda/upc/$code"
          params={{ code: displayGtin(product.primaryGtin) }}
          className="text-primary hover:underline"
        >
          {displayGtin(product.primaryGtin)}
        </Link>
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
  "product-ingredient": (product) => ({
    value: product.ingredient ? (
      <Row gap="sm" wrap>
        <ProductIngredientLink ingredient={product.ingredient} />
        {product.food ? (
          <EntityInlineLink
            displayImage={null}
            entity="usda-food"
            data={product.food}
          />
        ) : null}
      </Row>
    ) : undefined,
  }),
  // `{ source, kind, externalId, url }` rows, not the plain string list the
  // field kind implies — this renderer is what keeps the page from parsing
  // them as strings.
  "product-external-ids": (product) => ({
    value:
      product.externalIds.length > 0 ? (
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
  // A collection tag links to its collection page; every other tag is a
  // cohort link into the product list.
  "product-tags": (product) => ({
    filterAction: null,
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
                search={{ tags: tag }}
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
} satisfies EntityDetailFieldRenderers<"product">;
