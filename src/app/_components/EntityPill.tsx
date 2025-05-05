import Link from "next/link";
import type React from "react";
import { entities } from "~/entities/entities";
import { type Entity } from "~/entities/types";

interface PillProps {
  text: string;
  entity?: Entity;
  label?: string;
}

const EntityPill: React.FC<PillProps> = ({ text, entity, label }) => {
  return (
    <span className="inline-flex items-center truncate rounded-full bg-green-100 px-2 py-0.5 text-sm font-medium text-green-900 transition-colors hover:bg-green-600">
      <span className="truncate">{text}</span>
      {entity && (
        <span className="text-primary py-0.3 ml-1 rounded-full bg-blue-200 px-1 text-xs font-semibold">
          {entities[entity].label}
          {entities[entity].icon}
        </span>
      )}
      {label && (
        <span className="text-primary py-0.3 ml-1 rounded-full bg-purple-300 px-1 text-xs font-semibold">
          {label}
        </span>
      )}
    </span>
  );
};
export const IngredientPillLink: React.FC<{ name: string; id: string }> = ({
  name,
  id,
}) => <PillLink href={`/ingredients/${id}`} text={name} entity="ingredient" />;
export const LocationPillLink: React.FC<{
  location: { name: string; id: string; type: string };
}> = ({ location: { name, id, type } }) => (
  <PillLink
    href={`/locations/${id}`}
    text={name}
    entity={"location"}
    label={type}
  />
);
export const InventoryEntryPIllLink: React.FC<{
  inventoryEntry: { name: string; id: string };
}> = ({ inventoryEntry: { name, id } }) => (
  <PillLink href={`/inventory/${id}`} text={name} entity={"inventory-item"} />
);
export const RecipePillLink: React.FC<{
  recipe: { name: string; id: string };
}> = ({ recipe: { name, id } }) => (
  <PillLink href={`/recipes/${id}`} text={name} entity={"recipe"} />
);
export const ProductPillLink: React.FC<{
  product: { name: string; id: string; manufacturer: string };
}> = ({ product: { name, id, manufacturer } }) => (
  <PillLink
    href={`/products/${id}`}
    text={name}
    label={manufacturer}
    entity={"product"}
  />
);
export const FoodPillLink: React.FC<{
  food: { foodInfo: { description: string }; fdc_id: number };
}> = ({ food }) => (
  <PillLink
    href={`/usda/fdc/${food.fdc_id}`}
    text={food.foodInfo.description}
    entity={"usda-food"}
  />
);

const PillLink: React.FC<PillProps & { href: string }> = ({
  href,
  ...pillProps
}) => (
  <Link href={href}>
    <EntityPill {...pillProps} />
  </Link>
);
