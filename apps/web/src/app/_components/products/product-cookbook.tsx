import type { ProductCookbookRefOut } from "@cubby/schemas/product";

import { Row, Stack } from "~/components/layout";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { countLabel } from "~/lib/pluralize";

import { EntityInlineLink } from "../EntityInlineLink";

/**
 * The cookbooks whose physical copies this product is.
 *
 * No query of its own: the link arrives embedded in the product detail payload
 * (see `productWithFoodOut.cookbooks`), so the panel can't contradict the page
 * around it while a second request is in flight.
 *
 * The recipe count is the whole point of the panel — it is what turns "a book
 * I own" into "194 recipes I can cook from" — so it doubles as the filter link
 * into the recipe list, the same deep link `RecipeHero` uses from the other
 * side.
 */
export function ProductCookbook({
  cookbooks,
}: {
  cookbooks: ProductCookbookRefOut[];
}) {
  if (cookbooks.length === 0) return null;
  return (
    <Stack gap="sm">
      {cookbooks.map((cookbook) => (
        <Row key={cookbook.id} className="items-center justify-between gap-2">
          <EntityInlineLink
            displayImage={undefined}
            entity="cookbook"
            data={{ id: cookbook.id, name: cookbook.name }}
          />
          <EntityFilterLink
            variant="value"
            to="/recipes"
            search={{ source: cookbook.id }}
            label={`Show all ${countLabel(cookbook.recipeCount, "recipe")} from ${cookbook.name}`}
          >
            {countLabel(cookbook.recipeCount, "recipe")}
          </EntityFilterLink>
        </Row>
      ))}
    </Stack>
  );
}
