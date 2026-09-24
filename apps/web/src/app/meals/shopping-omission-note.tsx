import type { ShoppingListOut, UnexpandedSubRecipe } from "@cubby/schemas/meal";
import { MEAL_KIND_LABELS } from "@cubby/schemas/meal-classification";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { Link } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";

import { Row, Stack } from "~/components/layout";
import { entityDetailLink } from "~/entities/entities";
import { blockReasonText } from "~/lib/sub-recipe-reason";

/**
 * Honesty footnotes for the shopping list — two omissions, deliberately
 * different in tone because they differ in severity:
 *
 *   - **Unexpanded sub-recipes** are a fault: their ingredients are missing
 *     from a list that otherwise looks complete. Warning-toned, and it names
 *     the fix rather than just the fact, since every reason is correctable.
 *   - **Kind-omitted meals** are not a fault at all: you aren't shopping for a
 *     night you're eating out, and a leftovers night was already shopped for.
 *     Stated plainly so the range still reads as accounted-for, but it must
 *     not look like something went wrong.
 *
 * Both are data omissions rather than renderer ones, so every renderer shows
 * them. Same dotted-underline "here's what you're not seeing" idiom as
 * `TreePaginationNote`, with an escape hatch to the entity itself.
 */
export function ShoppingOmissionNote({
  unexpanded,
  omittedMeals,
}: {
  unexpanded: UnexpandedSubRecipe[];
  omittedMeals: ShoppingListOut["omittedMeals"];
}) {
  if (unexpanded.length === 0 && omittedMeals.length === 0) return null;

  // One entry per sub-recipe: the same dough planned in three meals is one
  // thing to fix, not three warnings.
  const byRecipe = new Map<string, UnexpandedSubRecipe>();
  for (const u of unexpanded)
    if (!byRecipe.has(u.recipeId)) byRecipe.set(u.recipeId, u);
  const unique = [...byRecipe.values()];

  return (
    <Stack gap="sm">
      {unique.length > 0 && (
        <Stack
          gap="tight"
          className="border border-warning/40 bg-warning/5 px-2 py-2 text-2xs"
        >
          <Row gap="xs" align="center" className="text-warning-ink">
            <WarningIcon className="size-3" />
            <span className="font-medium">
              {unique.length} sub-recipe{unique.length === 1 ? "" : "s"}{" "}
              couldn't be broken down — {unique.length === 1 ? "its" : "their"}{" "}
              ingredients aren't counted below.
            </span>
          </Row>
          {unique.map((u) => (
            <Row
              key={u.recipeId}
              gap="xs"
              wrap
              className="text-muted-foreground"
            >
              <Link
                {...entityDetailLink("recipe", u.recipeId)}
                className="underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                {u.name}
              </Link>
              <span>
                {blockReasonText(u.reason)} · used by {u.parentRecipeName}
              </span>
            </Row>
          ))}
        </Stack>
      )}

      {omittedMeals.length > 0 && (
        <Stack
          gap="tight"
          className="border border-[var(--border)] bg-muted/30 px-2 py-2 text-2xs"
        >
          <Row gap="xs" align="center" className="text-muted-foreground">
            <InfoIcon className="size-3" />
            <span className="font-medium">
              {omittedMeals.length} meal{omittedMeals.length === 1 ? "" : "s"}{" "}
              in this range {omittedMeals.length === 1 ? "isn't" : "aren't"}{" "}
              cooked, so nothing was added for{" "}
              {omittedMeals.length === 1 ? "it" : "them"}.
            </span>
          </Row>
          {omittedMeals.map((m) => (
            <Row key={m.id} gap="xs" wrap className="text-muted-foreground">
              <Link
                {...entityDetailLink("meal", m.id)}
                className="underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                {m.name || format(parseISO(m.date), "EEE, MMM d")}
              </Link>
              <span>{MEAL_KIND_LABELS[m.mealKind]}</span>
            </Row>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
