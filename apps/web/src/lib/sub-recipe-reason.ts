import type { SubRecipeBlockReason } from "@cubby/schemas/availability";
import { match } from "ts-pattern";

/**
 * Why the engine couldn't scale a sub-recipe, in words.
 *
 * Shared by the shopping list (which omits the sub-recipe and discloses it) and
 * the prep/spec views (which fall back to an estimate and flag it), so the two
 * surfaces describe the same gap the same way. Each phrase names the *fix*, not
 * just the fact — every reason here is something you can go and correct.
 */
export const blockReasonText = (reason: SubRecipeBlockReason): string =>
  match(reason)
    .with("missingYield", () => "needs a yield before it can be scaled")
    .with(
      "unscalable",
      () => "is measured in units that don't convert to its yield",
    )
    .with("cycle", () => "refers back to a recipe that contains it")
    .with("unknownRecipe", () => "has been deleted")
    .with("noAmount", () => "is used without an amount")
    .exhaustive();
