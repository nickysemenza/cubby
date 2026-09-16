import type { IngredientWithFoodOut } from "@cubby/schemas/ingredient";
import type { FC } from "react";

import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  EntityBasicInfo,
  entitySectionFields,
} from "~/entities/entity-display";

interface IngredientBasicInfoProps {
  ingredient: IngredientWithFoodOut;
  onEdit: () => void;
}

export const IngredientBasicInfo: FC<IngredientBasicInfoProps> = ({
  ingredient,
  onEdit,
}) => {
  return (
    <EntityBasicInfo
      entity="ingredient"
      fields={entitySectionFields("ingredient", "basic-information")}
      record={ingredient}
      overrides={{
        aliases: (record) => ({
          value: record.aliases.length ? record.aliases.join(", ") : undefined,
        }),
        usuallyOnHand: (record) => ({
          value: record.usuallyOnHand
            ? "Yes — assumed covered for planning"
            : "No",
        }),
      }}
      actions={
        <Row gap="sm">
          <Button onClick={onEdit} variant="outline" size="sm">
            Edit Ingredient
          </Button>
        </Row>
      }
    />
  );
};
