import type { IngredientWithFoodOut } from "@cubby/schemas/ingredient";
import type { FC } from "react";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";
import { ingredientMutationInvalidateKeys } from "~/lib/query-keys";
import { useEntityDelete } from "../hooks/useEntityDelete";

interface IngredientBasicInfoProps {
  ingredient: IngredientWithFoodOut;
  onEdit: () => void;
}

export const IngredientBasicInfo: FC<IngredientBasicInfoProps> = ({
  ingredient,
  onEdit,
}) => {
  const api = useTRPC();
  const { deleteButton, deleteDialog } = useEntityDelete({
    id: ingredient.id,
    name: ingredient.name,
    entityLabel: "Ingredient",
    mutationOptions: (callbacks) =>
      api.ingredient.delete.mutationOptions(callbacks),
    invalidateKeys: ingredientMutationInvalidateKeys,
    redirectTo: "/ingredients",
  });

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
    <>
      <BasicInfo
        fields={fields}
        actions={
          <Row gap="sm">
            <Button onClick={onEdit} variant="outline" size="sm">
              Edit Ingredient
            </Button>
            {deleteButton}
          </Row>
        }
      />
      {deleteDialog}
    </>
  );
};
