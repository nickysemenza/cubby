import type { FC } from "react";
import { InfoRow } from "~/components/common/info-row";
import { Button } from "~/components/ui/button";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";

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
      <InfoRow label="Name">{ingredient.name}</InfoRow>
      <InfoRow label="Aliases">
        {ingredient.aliases.length > 0
          ? ingredient.aliases.join(", ")
          : undefined}
      </InfoRow>
      <div className="pt-2">
        <Button onClick={onEdit} variant="outline" size="sm">
          Edit Ingredient
        </Button>
      </div>
    </div>
  );
};
