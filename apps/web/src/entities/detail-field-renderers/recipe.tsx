import { ExternalLinkText } from "~/app/_components/ExternalLink";
import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import {
  RecipeSourceLink,
  sourceLabel,
} from "~/app/_components/recipe/recipe-source";
import { Row } from "~/components/layout";
import { NoneValue } from "~/components/ui/none-value";
import { formatEstimate } from "~/lib/nutrition-format";
import { formatCurrency } from "~/lib/utils";

import type { EntityDetailFieldRenderers } from "./index";

const count = (value: number, noun: string) =>
  `${value} ${noun}${value === 1 ? "" : "s"}`;

export const recipeDetailFields = {
  "recipe-meta": (recipe) => ({
    label: "Source URL",
    value: recipe.meta?.url ? (
      <ExternalLinkText href={recipe.meta.url} truncate />
    ) : undefined,
  }),
  "recipe-yield": (recipe) => ({
    value: recipe.yield ? (
      <span className="font-mono tabular-nums">
        {tryFormatAmount(recipe.yield)}
      </span>
    ) : undefined,
  }),
  "recipe-source": (recipe) => ({
    value: sourceLabel(recipe.source) ? (
      <RecipeSourceLink source={recipe.source} />
    ) : undefined,
  }),
  // The body itself renders in the workflow slot; here the row is the
  // composition summary a reader scans before opening it.
  "recipe-sections": (recipe) => ({
    label: "Composition",
    value: (
      <span>
        {count(recipe.sections.length, "section")} ·{" "}
        {count(
          recipe.sections.reduce(
            (total, section) => total + section.ingredients.length,
            0,
          ),
          "ingredient",
        )}{" "}
        ·{" "}
        {count(
          recipe.sections.reduce(
            (total, section) => total + section.instructions.length,
            0,
          ),
          "step",
        )}
      </span>
    ),
  }),
  "recipe-totals": (recipe) => ({
    value: recipe.totals ? (
      <Row gap="sm" wrap>
        <span>{formatEstimate(recipe.totals.cost, formatCurrency)}</span>
        <span>
          {formatEstimate(
            recipe.totals.nutrition.kcal,
            (value) => `${Math.round(value)} kcal`,
          )}
        </span>
      </Row>
    ) : (
      <NoneValue />
    ),
  }),
} satisfies EntityDetailFieldRenderers<"recipe">;
