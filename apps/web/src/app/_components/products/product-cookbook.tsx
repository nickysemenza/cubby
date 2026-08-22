import type { ProductCookbookRefOut } from "@cubby/schemas/product";
import { Row } from "~/components/layout/row";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { EntityInlineLink } from "../EntityInlineLink";

/**
 * The cookbook whose physical copy this product is.
 *
 * No query of its own: the link arrives embedded in the product detail payload
 * (see `productWithFoodOut.cookbook`), so the panel can't contradict the page
 * around it while a second request is in flight.
 *
 * The recipe count is the whole point of the panel — it is what turns "a book
 * I own" into "194 recipes I can cook from" — so it doubles as the filter link
 * into the recipe list, the same deep link `RecipeHero` uses from the other
 * side.
 */
export function ProductCookbook({
  cookbook,
}: {
  cookbook: ProductCookbookRefOut;
}) {
  return (
    <Row className="items-center justify-between gap-3">
      <EntityInlineLink
        displayImage={undefined}
        entity="cookbook"
        data={{ id: cookbook.id, name: cookbook.name }}
      />
      <EntityFilterLink
        variant="value"
        to="/recipes"
        search={{ source: cookbook.id }}
        label={`Show all ${cookbook.recipeCount} recipes from ${cookbook.name}`}
      >
        {cookbook.recipeCount} recipes
      </EntityFilterLink>
    </Row>
  );
}
