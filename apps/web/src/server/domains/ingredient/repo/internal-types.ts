import { isNull, or } from "drizzle-orm";

import { buildSearchConditions, formatSearchTerm } from "~/server/db/helpers";
import { ingredient } from "~/server/db/schema";
import {
  nameMatchesAnySql,
  nameOrAliasSql,
  textArraySomeSql,
} from "~/server/lib/name-alias-match";

// exact:
//  true -> case-insensitive match on name or aliases
//  false -> search on name, case-insensitive match on aliases
export const buildIngredientWhere = (
  exact: boolean,
  name: string,
  otherSearchNames?: string[],
) => {
  const list = [name, ...(otherSearchNames ?? [])];

  // Name or aliases condition: an OR of two shapes, so it can't be expressed
  // as one of buildSearchConditions' per-column search filters — it goes in
  // via `extraConditions` instead, alongside notDeleted (which the helper
  // adds itself).
  const nameOrAliasCondition = exact
    ? nameOrAliasSql({
        name: ingredient.name,
        aliases: ingredient.aliases,
        names: list,
      })
    : // Search on name (ilike), case-insensitive match on aliases
      or(
        formatSearchTerm(ingredient.name, name),
        textArraySomeSql(ingredient.aliases, (value) =>
          nameMatchesAnySql(value, list),
        ),
      );

  return buildSearchConditions(
    ingredient,
    [],
    [
      nameOrAliasCondition,
      // Filter for standalone ingredients only, not recipe ingredients
      isNull(ingredient.recipeId),
    ],
  );
};
