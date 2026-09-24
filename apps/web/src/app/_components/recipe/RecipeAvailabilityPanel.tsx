import type { IngredientAvailability } from "@cubby/schemas/availability";
import type { RecipeShortcode } from "@cubby/schemas/identifiers";
import { ChefHatIcon as ChefHat } from "@phosphor-icons/react/dist/csr/ChefHat";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import {
  formatAmount,
  statusClass,
  statusLabel,
} from "~/app/meals/meal-format";
import { suggestions } from "~/app/recipes/recipe.functions";
import { Row, Stack } from "~/components/layout";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

const SHELL = "border border-[var(--border)] px-4 py-2 print:hidden";

/** Planning coverage can include a household staple assumption. Keep that
 * separate from the inventory verdict so callers never present an assumption
 * as a recorded count. */
export function recipeAvailabilityPresentation(
  rows: readonly IngredientAvailability[],
  unexpandedSubRecipes: number,
) {
  const assumedNames = [
    ...new Set(
      rows
        .filter((row) => row.availabilitySource === "assumed")
        .map((row) => row.name),
    ),
  ];
  const hasQuantityIssues = rows.some((row) => row.quantityIssues.length > 0);
  const shortfalls = rows.filter(
    (row) => row.status !== "subrecipe" && !row.covered,
  );

  return {
    assumedNames,
    hasQuantityIssues,
    shortfalls,
    ready:
      shortfalls.length === 0 &&
      !hasQuantityIssues &&
      unexpandedSubRecipes === 0,
  };
}

/** Name + status colour; links through to the ingredient when the row resolved
 * to one (sub-recipe rows carry no ingredient id). */
function IngredientStatusLink({ row }: { row: IngredientAvailability }) {
  const className = cn("truncate", statusClass(row.status));
  return row.ingredientId ? (
    <Link
      to="/ingredients/$shortcode"
      params={{ shortcode: row.ingredientId }}
      className={cn(className, "hover:underline")}
      title={row.name}
    >
      {row.name}
    </Link>
  ) : (
    // Sub-recipe rows carry no id at all (see `ingredientAvailabilityOut`), so
    // the title attribute is the only full-name recovery available here.
    <span className={className} title={row.name}>
      {row.name}
    </span>
  );
}

/**
 * "Can I make this?" — the recipe-detail read of `suggestions.getRecipeAvailability`
 * (the same engine behind /meals/suggestions and the shopping list).
 *
 * Deliberately its own non-suspense query with its own skeleton: the service does
 * a recipe + ingredient + inventory load plus a WASM availability pass, and the
 * recipe itself must never wait on that. Rendered from the route (not inside
 * `RecipeDetail`) so the search hover-preview, which embeds `RecipeDetail`, does
 * not fire it.
 *
 * Baseline (1×) only — scaling the recipe doesn't rescale these needs; the panel
 * answers "do I have the ingredients", not "how much for 3×".
 */
export function RecipeAvailabilityPanel({
  recipeId,
}: {
  recipeId: RecipeShortcode;
}) {
  const { data, isLoading, isError } = useQuery(
    suggestions.getRecipeAvailability.queryOptions({ recipeId }),
  );

  // Read-only nicety on someone else's page — a failed inventory cross-check
  // shouldn't plant an error banner above the recipe.
  if (isError) return null;

  if (isLoading || !data) {
    return (
      <Row align="center" justify="between" gap="sm" className={SHELL}>
        <Row align="center" gap="xs">
          <ChefHat className="size-3.5 text-slate" />
          <span className="my-0 eyebrow">Can I make this?</span>
        </Row>
        <Skeleton className="h-4 w-28" />
      </Row>
    );
  }

  // A `subrecipe` row is one the engine could NOT expand, so its ingredients
  // are unknown — excluded from coverage (you can't score what you can't see)
  // and from the "need to buy" line. An expandable sub-recipe leaves no row
  // here at all; its ingredients are counted like any other.
  const { assumedNames, hasQuantityIssues, shortfalls, ready } =
    recipeAvailabilityPresentation(data.ingredients, data.unexpandedSubRecipes);

  return (
    <Stack gap="snug" className={SHELL}>
      <Row align="center" justify="between" wrap gap="sm">
        <Row align="center" gap="xs">
          <ChefHat className="size-3.5 text-slate" />
          <span className="my-0 eyebrow">Can I make this?</span>
        </Row>
        <Row align="center" gap="xs">
          {/* The omitted count: coverage above is computed over what could be
              resolved, so say plainly when that isn't everything. */}
          {data.unexpandedSubRecipes > 0 && (
            <span
              className="font-mono text-2xs text-warning-ink tabular-nums"
              title="These sub-recipes couldn't be broken down, so their ingredients aren't counted"
            >
              +{data.unexpandedSubRecipes} not counted
            </span>
          )}
          <span
            className={cn(
              "font-mono text-xs tabular-nums",
              ready ? "text-positive" : "text-warning-ink",
            )}
          >
            {data.availableIngredients} of {data.totalIngredients} covered
          </span>
        </Row>
      </Row>

      {assumedNames.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">
            Staples assumed ({assumedNames.length})
          </summary>
          <span className="mt-1 block">{assumedNames.join(", ")}</span>
        </details>
      )}

      {ready ? (
        <span className="text-xs text-muted-foreground">
          {assumedNames.length > 0
            ? "All required ingredients are covered. Staples are assumed on hand; recorded inventory stays separate."
            : "Everything this recipe needs is in recorded inventory."}
        </span>
      ) : (
        <Stack gap="tight">
          {shortfalls.length > 0 && (
            <Row wrap align="center" gap="xs" className="text-xs">
              <span className="text-muted-foreground">Need</span>
              {shortfalls.map((row, i) => (
                <Row
                  // oxlint-disable-next-line react/no-array-index-key -- Recipes may repeat an ingredient across sections; this server-ordered list is positional and never reordered.
                  key={i}
                  as="span"
                  align="center"
                  gap="xs"
                >
                  <IngredientStatusLink row={row} />
                  {i < shortfalls.length - 1 && (
                    <span className="text-muted-foreground">·</span>
                  )}
                </Row>
              ))}
            </Row>
          )}
          {hasQuantityIssues && (
            <span className="text-xs text-warning-ink">
              Some required quantities need review.
            </span>
          )}
          {data.unexpandedSubRecipes > 0 && (
            <span className="text-xs text-warning-ink">
              Some sub-recipes could not be expanded.
            </span>
          )}
        </Stack>
      )}

      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground marker:content-none hover:text-foreground">
          All ingredients ({data.ingredients.length})
        </summary>
        <Stack gap="tight" className="mt-2">
          {data.ingredients.map((row, index) => (
            <Row
              // oxlint-disable-next-line react/no-array-index-key -- Recipes may repeat an ingredient across sections; this server-ordered list is positional and never reordered.
              key={index}
              align="center"
              justify="between"
              gap="sm"
              className="min-w-0 text-xs"
            >
              <IngredientStatusLink row={row} />
              <Row align="center" gap="xs" className="shrink-0">
                <span className="text-muted-foreground tabular-nums">
                  {row.needValue == null
                    ? "Quantity unresolved"
                    : `Required ${formatAmount(row.needValue, row.basisUnit)}`}
                  {row.haveValue != null &&
                    ` · Recorded ${formatAmount(row.haveValue, row.basisUnit)}`}
                </span>
                {row.availabilitySource === "assumed" && (
                  <span className="text-positive">Assumed on hand</span>
                )}
                <span className={statusClass(row.status)}>
                  {row.availabilitySource === "assumed"
                    ? `Recorded: ${statusLabel(row.status)}`
                    : statusLabel(row.status)}
                </span>
              </Row>
            </Row>
          ))}
        </Stack>
      </details>
    </Stack>
  );
}
