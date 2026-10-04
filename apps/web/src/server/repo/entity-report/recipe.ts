import {
  AVAILABILITY_STATUS_LABELS,
  type IngredientAvailability,
} from "@cubby/schemas/availability";
import type { ReportBlock } from "@cubby/schemas/entity-report";
import { recipeShortcode } from "@cubby/schemas/identifiers";

import { deriveRecipeTotalsGaps } from "~/lib/recipe-totals-gaps";
import {
  suggestionFor,
  TOTALS_MISSING_MEASURES,
} from "~/lib/recipe-totals-gaps";
import type { Database } from "~/server/db";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import type { RequestServices } from "~/server/request-services";

import { amountFormatter } from "./records";

type Records = Extract<ReportBlock, { kind: "records" }>;
type Services = RequestServices["services"];
type Tone = "positive" | "warning" | "destructive" | "muted";

const STATUS_TONE = {
  ok: "positive",
  short: "warning",
  missing: "destructive",
  unconvertible: "muted",
  subrecipe: "muted",
} as const satisfies Record<IngredientAvailability["status"], Tone>;

/**
 * What "can I make this?" comes to, from the engine's per-ingredient verdicts. Planning coverage
 * can include a household staple assumption; that stays apart from the inventory verdict so a
 * client never presents an assumption as a recorded count. A `subrecipe` row is one the engine
 * could not expand, so its ingredients are unknown: it is left out of coverage and out of the
 * "need to buy" list (you cannot score what you cannot see).
 */
export function recipeAvailabilityVerdict(
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

/**
 * "Can I make this?": the recipe's ingredient availability at 1x (scaling does not change what
 * you have, and the panel answers "do I have the ingredients", not "how much for 3x"), worded
 * once for web and native. The same engine as /meals/suggestions and the shopping list.
 */
export async function recipeAvailabilityReport(
  db: Database,
  code: string,
  services: Services,
): Promise<ReportBlock[]> {
  await resolveOrThrow(db, "recipe", code);
  const availability = await services.availability.getRecipeAvailability(
    recipeShortcode.parse(code),
  );
  const formatAmount = await amountFormatter();
  const { assumedNames, hasQuantityIssues, shortfalls, ready } =
    recipeAvailabilityVerdict(
      availability.ingredients,
      availability.unexpandedSubRecipes,
    );
  const row = (entry: IngredientAvailability): Records["rows"][number] => ({
    entity: entry.ingredientId ? "ingredient" : null,
    id: entry.ingredientId,
    title: entry.name,
    subtitle:
      entry.needValue == null
        ? "Quantity unresolved"
        : [
            `Required ${formatAmount({ value: entry.needValue, unit: entry.basisUnit || "whole" })}`,
            ...(entry.haveValue == null
              ? []
              : [
                  `Recorded ${formatAmount({ value: entry.haveValue, unit: entry.basisUnit || "whole" })}`,
                ]),
          ].join(" · "),
    trailing: null,
    statuses: [
      ...(entry.availabilitySource === "assumed"
        ? [{ label: "Assumed on hand", tone: "positive" as const }]
        : []),
      {
        label:
          entry.availabilitySource === "assumed"
            ? `Recorded: ${AVAILABILITY_STATUS_LABELS[entry.status]}`
            : AVAILABILITY_STATUS_LABELS[entry.status],
        tone: STATUS_TONE[entry.status],
      },
    ],
  });
  return [
    {
      kind: "stats",
      figures: [
        {
          label: "Can I make this?",
          value: availability.availableIngredients,
          format: "text",
          text: `${availability.availableIngredients} of ${availability.totalIngredients} covered`,
          tone: ready ? "positive" : "warning",
        },
        ...(availability.unexpandedSubRecipes > 0
          ? [
              {
                label: "Not counted",
                value: availability.unexpandedSubRecipes,
                format: "text" as const,
                text: `+${availability.unexpandedSubRecipes} not counted`,
                tone: "warning" as const,
              },
            ]
          : []),
      ],
    },
    ...(ready
      ? [
          {
            kind: "note" as const,
            text:
              assumedNames.length > 0
                ? "All required ingredients are covered. Staples are assumed on hand; recorded inventory stays separate."
                : "Everything this recipe needs is in recorded inventory.",
          },
        ]
      : [
          ...(hasQuantityIssues
            ? [
                {
                  kind: "note" as const,
                  tone: "warning" as const,
                  text: "Some required quantities need review.",
                },
              ]
            : []),
          ...(availability.unexpandedSubRecipes > 0
            ? [
                {
                  kind: "note" as const,
                  tone: "warning" as const,
                  text: "Some sub-recipes could not be expanded, so their ingredients are not counted.",
                },
              ]
            : []),
        ]),
    ...(assumedNames.length > 0
      ? [
          {
            kind: "note" as const,
            tone: "muted" as const,
            text: `Staples assumed (${assumedNames.length}): ${assumedNames.join(", ")}`,
          },
        ]
      : []),
    ...(shortfalls.length > 0
      ? [
          {
            kind: "records" as const,
            title: "Need",
            rows: shortfalls.map(row),
            empty: "",
          },
        ]
      : []),
    {
      kind: "records",
      title: `All ingredients (${availability.ingredients.length})`,
      rows: availability.ingredients.map(row),
      empty: "This recipe lists no ingredients.",
    },
  ];
}

/**
 * Why a recipe's cost, weight or nutrition totals are incomplete, and the one fix that most
 * advances each blocking ingredient or sub-recipe. The gaps are `deriveRecipeTotalsGaps` over the
 * engine's per-row results, the same derivation web's coverage popover and missing-cost cells
 * use; the figure with id `weightGrams` is the unscaled total weight that the total-weight scale
 * anchor measures a target against (`scale_factor_for_total_weight`).
 */
export async function recipeCostingCoverageReport(
  db: Database,
  code: string,
  services: Services,
): Promise<ReportBlock[]> {
  const id = await resolveOrThrow(db, "recipe", code);
  const { costing, ingMap } =
    await services.recipeCosting.costingWithContext(id);
  const gaps = deriveRecipeTotalsGaps(costing, ingMap);
  const weight = costing.totals.weight;
  const counts = TOTALS_MISSING_MEASURES.map((measure) => ({
    label: measure.label,
    count: gaps.filter((gap) => gap.missing[measure.key]).length,
  })).filter((entry) => entry.count > 0);
  return [
    {
      kind: "stats",
      figures: [
        {
          id: "weightGrams",
          label: "Total weight",
          value: weight > 0 ? weight : null,
          format: "text",
          text: weight > 0 ? `${Math.round(weight)} g` : "—",
        },
        {
          label: "Totals",
          value: gaps.length,
          format: "text",
          text: gaps.length === 0 ? "Complete" : `${gaps.length} block totals`,
          tone: gaps.length === 0 ? "positive" : "warning",
        },
        ...counts.map((entry) => ({
          label: `Missing ${entry.label}`,
          value: entry.count,
          format: "text" as const,
          text: String(entry.count),
          tone: "warning" as const,
        })),
      ],
    },
    ...(gaps.length === 0
      ? []
      : [
          {
            kind: "records" as const,
            title: "Why aren't these totals complete?",
            rows: gaps.map((gap) => {
              const { lead, cta } = suggestionFor(gap);
              return {
                // An ingredient gap is fixed on the ingredient; a sub-recipe gap on the child
                // recipe, or on this recipe for a missing amount.
                entity: gap.source === "ingredient" ? "ingredient" : "recipe",
                id:
                  gap.source === "ingredient"
                    ? gap.ingredientShortcode
                    : gap.kind === "set-subrecipe-amount"
                      ? code
                      : gap.recipeShortcode,
                title: gap.name,
                subtitle: lead,
                trailing: cta,
                badges: TOTALS_MISSING_MEASURES.filter(
                  (measure) => gap.missing[measure.key],
                ).map((measure) => measure.label),
              };
            }),
            empty: "",
          },
        ]),
  ];
}
