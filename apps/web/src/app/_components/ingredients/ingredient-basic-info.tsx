import type { FC } from "react";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
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
  const fields: BasicInfoField[] = [
    { label: "Name", value: ingredient.name },
    {
      label: "Aliases",
      value:
        ingredient.aliases.length > 0
          ? ingredient.aliases.join(", ")
          : undefined,
    },
  ];

  return (
    <BasicInfo
      fields={fields}
      actions={
        <Button onClick={onEdit} variant="outline" size="sm">
          Edit Ingredient
        </Button>
      }
    />
  );
};
