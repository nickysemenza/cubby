"use client";

import type { FC } from "react";
import { Button } from "~/components/ui/button";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import { NoneState } from "../NoneState";

interface IngredientBasicInfoProps {
  ingredient: IngredientWithFoodOut;
  onEdit: () => void;
}

export const IngredientBasicInfo: FC<IngredientBasicInfoProps> = ({
  ingredient,
  onEdit,
}) => {
  return (
    <div className="space-y-2">
      <div>
        <span className="font-medium">Name:</span> {ingredient.name}
      </div>
      <div>
        <span className="font-medium">Aliases:</span>{" "}
        {ingredient.aliases.length > 0 ? (
          ingredient.aliases.join(", ")
        ) : (
          <NoneState />
        )}
      </div>
      <div className="pt-2">
        <Button onClick={onEdit} variant="outline" size="sm">
          Edit Ingredient
        </Button>
      </div>
    </div>
  );
};
