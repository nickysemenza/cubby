import type { FC } from "react";
import { type Control, useWatch } from "react-hook-form";
import { MarkdownText } from "~/components/markdown";
import { Eyebrow } from "~/components/ui/eyebrow";
import { cn } from "~/lib/utils";
import { tryFormatAmount } from "../../inventory/format-amount";
import {
  type DisplayQuantity,
  IngredientQuantities,
  ingredientRowGridNarrow,
} from "../IngredientQuantities";
import { buildRecipeKicker } from "../recipe-utils";
import { SectionHeading } from "../section-heading";
import type { RecipeFormValues } from "./types";

/** Safe quantity formatting over possibly-partial draft amounts. */
function formatDraftQty(
  amounts: Array<{ value?: number | null; unit?: string | null }> | undefined,
): DisplayQuantity[] {
  if (!amounts) return [];
  return amounts
    .filter((a) => a?.value != null)
    .map((a) => ({
      text: tryFormatAmount({ value: a.value ?? 0, unit: a.unit ?? "" }),
      derived: false,
      estimated: false,
    }));
}

/**
 * Live cookbook-spread preview of the recipe form: kicker, ingredient ledger,
 * serif step numerals — the read view's language, fed straight from form
 * state. Read-only; renders draft data defensively (rows may be half-typed).
 */
export const RecipeLivePreview: FC<{
  control: Control<RecipeFormValues>;
}> = ({ control }) => {
  const values = useWatch({ control }) as Partial<RecipeFormValues>;

  const sections = values.sections ?? [];
  const kicker = buildRecipeKicker({
    yield: values.yield,
    servings: values.servings,
  }).join(" · ");

  let stepNumber = 0;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="my-0 break-words font-bold font-heading text-lg tracking-tight">
          {values.name?.trim() || "Untitled recipe"}
        </h3>
        {kicker && (
          <Eyebrow className="mt-1 border-foreground border-b pb-1 tracking-[0.12em]">
            {kicker}
          </Eyebrow>
        )}
      </div>

      {/* Notes markdown, headnote-style — mirrors the detail view's placement. */}
      {values.notes?.trim() && (
        <MarkdownText className="text-muted-foreground text-xs">
          {values.notes}
        </MarkdownText>
      )}

      {sections.map((section, sectionIndex) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: preview of positional draft sections
          key={sectionIndex}
          className="space-y-2"
        >
          <SectionHeading
            sectionName={section?.name}
            index={sectionIndex}
            total={sections.length}
          />

          {(section?.ingredients?.length ?? 0) > 0 && (
            <ul className="my-0 ml-0 list-none divide-y divide-dashed divide-border">
              {section?.ingredients?.map((ing, i) => {
                const name =
                  (ing?.type === "recipe"
                    ? ing?.recipe?.name
                    : ing?.ingredient?.name) || "…";
                return (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional draft rows
                    key={i}
                    className={cn(ingredientRowGridNarrow, "py-1")}
                  >
                    <IngredientQuantities
                      quantities={formatDraftQty(ing?.amounts)}
                      className="text-2xs"
                    />
                    <span className="truncate text-sm">{name}</span>
                  </li>
                );
              })}
            </ul>
          )}

          {(section?.instructions?.length ?? 0) > 0 && (
            <ol className="my-0 ml-0 list-none space-y-2">
              {section?.instructions?.map((inst, i) => {
                stepNumber += 1;
                return (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional draft rows
                    key={i}
                    className="flex gap-2"
                  >
                    <span className="w-5 shrink-0 text-right font-heading font-medium text-base text-primary italic leading-snug">
                      {stepNumber}
                    </span>
                    <span className="min-w-0 text-xs/relaxed">
                      {inst?.instruction || "…"}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      ))}

      {sections.every(
        (s) =>
          (s?.ingredients?.length ?? 0) === 0 &&
          (s?.instructions?.length ?? 0) === 0,
      ) && (
        <p className="text-muted-foreground text-xs italic">
          The page builds itself as you type.
        </p>
      )}
    </div>
  );
};
