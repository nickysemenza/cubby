import type { IngredientWithFoodOut } from "@cubby/schemas/ingredient-responses";
import type { FC } from "react";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";
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
  const { DeleteButton, DeleteDialog } = useEntityDelete({
    id: ingredient.id,
    name: ingredient.name,
    entityLabel: "Ingredient",
    mutationOptions: (callbacks) =>
      api.ingredient.delete.mutationOptions(callbacks),
    invalidateKeys: [queryKeys.ingredient.list],
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
            <DeleteButton size="sm" />
          </Row>
        }
      />
      <DeleteDialog />
    </>
  );
};
