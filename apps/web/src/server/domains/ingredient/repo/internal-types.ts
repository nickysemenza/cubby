import { inArray, isNull, or, sql } from "drizzle-orm";

import { buildSearchConditions, formatSearchTerm } from "~/server/db/helpers";
import { ingredient } from "~/server/db/schema";

// Case-insensitive alias match: compare lower(each alias) against the lowercased
// list. Plain `arrayOverlaps` is case-sensitive, which would disagree with the
// case-insensitive name match (and the lower(name) unique index) — e.g. an alias
// "Scallion" wouldn't match a "scallion" lookup.
const aliasMatchesCaseInsensitive = (list: string[]) => {
  const lowered = list.map((n) => n.toLowerCase());
  return sql`EXISTS (SELECT 1 FROM unnest(${ingredient.aliases}) AS t(val) WHERE lower(t.val) IN (${sql.join(
    lowered.map((v) => sql`${v}`),
    sql`, `,
  )}))`;
};

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
    ? // Exact (case-insensitive) match: lower(name) IN list OR any alias matches
      or(
        inArray(
          sql`lower(${ingredient.name})`,
          list.map((n) => n.toLowerCase()),
        ),
        aliasMatchesCaseInsensitive(list),
      )
    : // Search on name (ilike), case-insensitive match on aliases
      or(
        formatSearchTerm(ingredient.name, name),
        aliasMatchesCaseInsensitive(list),
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
