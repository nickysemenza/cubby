import type { UnexpandedSubRecipe } from "@cubby/schemas/meal";
import { Link } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { Row, Stack } from "~/components/layout";
import { entityDetailLink } from "~/entities/entities";
import { blockReasonText } from "~/lib/sub-recipe-reason";

/**
 * Honesty footnote for the shopping list: these sub-recipes' ingredients are
 * NOT in the list below. A data omission, not a renderer one, so both
 * renderers show it — and it names the fix rather than just the fact, since
 * every reason here is something you can actually go and correct.
 *
 * Same dotted-underline "here's what you're not seeing" idiom as
 * `TreePaginationNote`, with an escape hatch to the sub-recipe itself.
 */
export function ShoppingOmissionNote({
  unexpanded,
}: {
  unexpanded: UnexpandedSubRecipe[];
}) {
  if (unexpanded.length === 0) return null;

  // One entry per sub-recipe: the same dough planned in three meals is one
  // thing to fix, not three warnings.
  const byRecipe = new Map<string, UnexpandedSubRecipe>();
  for (const u of unexpanded)
    if (!byRecipe.has(u.recipeId)) byRecipe.set(u.recipeId, u);
  const unique = [...byRecipe.values()];

  return (
    <Stack
      gap="tight"
      className="border border-warning/40 bg-warning/5 px-2 py-2 text-2xs"
    >
      <Row gap="xs" align="center" className="text-warning">
        <TriangleAlert className="size-3" />
        <span className="font-medium">
          {unique.length} sub-recipe{unique.length === 1 ? "" : "s"} couldn't be
          broken down — {unique.length === 1 ? "its" : "their"} ingredients
          aren't counted below.
        </span>
      </Row>
      {unique.map((u) => (
        <Row key={u.recipeId} gap="xs" wrap className="text-muted-foreground">
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
  );
}
