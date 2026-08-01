import { isDisplayableImageFile } from "@cubby/schemas/image";
import type { IngredientWithFoodOut } from "@cubby/schemas/ingredient";
import type { FC } from "react";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { formatCurrency } from "~/lib/utils";
import { ShelfCard, ShelfEmpty, ShelfGrid } from "../data-table/shelf";

/**
 * The products realizing an ingredient, as photo shelf cards (same visual
 * language as location contents) — products have images; link chips wasted
 * them. Caption is the one mono line: `$price · manufacturer`.
 */
export const IngredientProductShelf: FC<{
  products: IngredientWithFoodOut["product"];
}> = ({ products }) => {
  if (products.length === 0) {
    return (
      <ShelfEmpty
        entity="product"
        label="No products linked yet — enrich to add pricing and nutrition"
      />
    );
  }

  return (
    <ShelfGrid
      items={products}
      renderCard={(product) => {
        const images = product.images.filter(isDisplayableImageFile);
        return (
          <ShelfCard
            key={product.id}
            to="/products/$shortcode"
            params={{ shortcode: product.id }}
            image={images[0]?.url}
            extraCount={images.length - 1}
            title={product.name}
            subtitle={[
              product.price != null ? formatCurrency(product.price) : null,
              isUnspecifiedManufacturer(product.manufacturer)
                ? null
                : product.manufacturer,
            ]
              .filter(Boolean)
              .join(" · ")}
            entity="product"
          />
        );
      }}
    />
  );
};
