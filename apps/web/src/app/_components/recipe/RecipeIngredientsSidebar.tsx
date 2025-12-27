"use client";

import { useState } from "react";
import { Checkbox } from "~/components/ui/checkbox";
import type { RecipeOut, SectionIngredientOut } from "~/schemas/recipe";
import { tryFormatAmount } from "../inventory/format-amount";

interface RecipeIngredientsSidebarProps {
  recipe: RecipeOut;
}

export function RecipeIngredientsSidebar({
  recipe,
}: RecipeIngredientsSidebarProps) {
  // Track checked ingredients
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const toggleIngredient = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const getIngredientName = (ing: SectionIngredientOut): string => {
    if (ing.type === "ingredient") {
      return ing.ingredient.name;
    } else {
      return ing.recipe.name;
    }
  };

  const formatAmounts = (amounts: SectionIngredientOut["amounts"]): string => {
    return amounts.map((a) => tryFormatAmount(a)).join(" + ");
  };

  return (
    <div className="space-y-6">
      {recipe.sections.map((section, sectionIndex) => (
        <div key={section.id}>
          {/* Section header - only show if there are multiple sections or section has a name */}
          {(recipe.sections.length > 1 || section.name) && (
            <h4 className="mb-3 font-medium text-muted-foreground text-sm uppercase tracking-wide">
              {section.name || `Part ${sectionIndex + 1}`}
            </h4>
          )}

          {/* Ingredients list */}
          <ul className="my-0 ml-0 list-none space-y-2">
            {section.ingredients.map((ing) => {
              const isChecked = checked.has(ing.id);
              return (
                <li key={ing.id} className="flex items-start gap-3">
                  <Checkbox
                    id={ing.id}
                    checked={isChecked}
                    onCheckedChange={() => toggleIngredient(ing.id)}
                    className="mt-0.5"
                  />
                  <label
                    htmlFor={ing.id}
                    className={`cursor-pointer text-sm leading-relaxed ${isChecked ? "text-muted-foreground line-through" : ""}`}
                  >
                    <span className="font-medium">
                      {formatAmounts(ing.amounts)}
                    </span>{" "}
                    {getIngredientName(ing)}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
