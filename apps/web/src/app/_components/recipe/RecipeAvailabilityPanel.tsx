import type { IngredientAvailability } from "@cubby/schemas/availability";
import type { RecipeId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChefHat } from "lucide-react";
import {
  formatAmount,
  statusClass,
  statusLabel,
} from "~/app/meals/meal-format";
import { Row, Stack } from "~/components/layout";
import { Skeleton } from "~/components/ui/skeleton";
import { useTRPC } from "~/integrations/trpc/react";
import { cn } from "~/lib/utils";

const SHELL = "rounded-lg border border-[var(--border)] px-4 py-2 print:hidden";

/** Name + status colour; links through to the ingredient when the row resolved
 * to one (sub-recipe rows carry no ingredient id). */
function IngredientStatusLink({ row }: { row: IngredientAvailability }) {
  const className = cn("truncate", statusClass(row.status));
  return row.ingredientId ? (
    <Link
      to="/ingredients/$id"
      params={{ id: row.ingredientId }}
      className={cn(className, "hover:underline")}
    >
      {row.name}
    </Link>
  ) : (
    <span className={className}>{row.name}</span>
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
export function RecipeAvailabilityPanel({ recipeId }: { recipeId: RecipeId }) {
  const api = useTRPC();
  const { data, isLoading, isError } = useQuery(
    api.suggestions.getRecipeAvailability.queryOptions({ recipeId }),
  );

  // Read-only nicety on someone else's page — a failed inventory cross-check
  // shouldn't plant an error banner above the recipe.
  if (isError) return null;

  if (isLoading || !data) {
    return (
      <Row align="center" justify="between" gap="sm" className={SHELL}>
        <Row align="center" gap="xs">
          <ChefHat className="size-3.5 text-slate" />
          <span className="eyebrow my-0">Can I make this?</span>
        </Row>
        <Skeleton className="h-4 w-28" />
      </Row>
    );
  }

  // Sub-recipes aren't expanded by the engine, so they're excluded from
  // coverage — keep them out of the "need to buy" line too (they show in the
  // full list below with their own label).
  const shortfalls = data.ingredients.filter(
    (row) => row.status !== "ok" && row.status !== "subrecipe",
  );
  const ready = shortfalls.length === 0;

  return (
    <Stack gap="snug" className={SHELL}>
      <Row align="center" justify="between" wrap gap="sm">
        <Row align="center" gap="xs">
          <ChefHat className="size-3.5 text-slate" />
          <span className="eyebrow my-0">Can I make this?</span>
        </Row>
        <span
          className={cn(
            "font-mono text-xs tabular-nums",
            ready ? "text-positive" : "text-warning",
          )}
        >
          {data.availableIngredients} of {data.totalIngredients} on hand
        </span>
      </Row>

      {ready ? (
        <span className="text-muted-foreground text-xs">
          Everything this recipe needs is in inventory.
        </span>
      ) : (
        <Row wrap align="center" gap="xs" className="text-xs">
          <span className="text-muted-foreground">Need</span>
          {shortfalls.map((row, i) => (
            <Row
              // biome-ignore lint/suspicious/noArrayIndexKey: a recipe can repeat an ingredient across sections; this list is positional (server order) and never reordered or spliced, so the index IS the identity.
              key={`${row.ingredientId ?? row.name}-${i}`}
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

      <details>
        <summary className="cursor-pointer text-muted-foreground text-xs marker:content-none hover:text-foreground">
          All ingredients ({data.ingredients.length})
        </summary>
        <Stack gap="tight" className="mt-2">
          {data.ingredients.map((row, i) => (
            <Row
              // biome-ignore lint/suspicious/noArrayIndexKey: positional server-ordered list — see the shortfall map above.
              key={`${row.ingredientId ?? row.name}-${i}`}
              align="center"
              justify="between"
              gap="sm"
              className="min-w-0 text-xs"
            >
              <IngredientStatusLink row={row} />
              <Row align="center" gap="xs" className="shrink-0">
                <span className="text-muted-foreground tabular-nums">
                  {row.needValue == null
                    ? "—"
                    : formatAmount(row.needValue, row.basisUnit)}
                  {row.haveValue != null &&
                    ` · have ${formatAmount(row.haveValue, row.basisUnit)}`}
                </span>
                <span className={statusClass(row.status)}>
                  {statusLabel(row.status)}
                </span>
              </Row>
            </Row>
          ))}
        </Stack>
      </details>
    </Stack>
  );
}
