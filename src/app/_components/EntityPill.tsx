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
    <span className="inline-flex items-center truncate rounded-md bg-gray-50 px-2.5 py-1 text-sm font-medium text-gray-800 ring-1 ring-gray-200 transition-colors ring-inset hover:bg-gray-100">
      <span className="truncate">{text}</span>
      {entity && (
        <span className="ml-1.5 inline-flex items-center rounded-sm bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-blue-200 ring-inset">
          {entities[entity].icon}
          <span className="ml-1">{entities[entity].label}</span>
        </span>
      )}
      {label && (
        <span className="ml-1.5 rounded-sm bg-purple-50 px-1.5 py-0.5 text-xs font-medium text-purple-700 ring-1 ring-purple-200 ring-inset">
          {label}
        </span>
      )}
    </span>
  );
};
export const IngredientPillLink: React.FC<{
  name: string;
  id: string;
  openInNewTab?: boolean;
}> = ({ name, id, openInNewTab }) => (
  <PillLink
    href={`/ingredients/${id}`}
    text={name}
    entity="ingredient"
    openInNewTab={openInNewTab}
  />
);
export const LocationPillLink: React.FC<{
  location: { name: string; id: string; type: string };
  openInNewTab?: boolean;
}> = ({ location: { name, id, type }, openInNewTab }) => (
  <PillLink
    href={`/locations/${id}`}
    text={name}
    entity={"location"}
    label={type}
    openInNewTab={openInNewTab}
  />
);
export const InventoryEntryPillLink: React.FC<{
  entry: { product: { name: string }; id: string };
  openInNewTab?: boolean;
}> = ({ entry, openInNewTab }) => (
  <PillLink
    href={`/inventory/${entry.id}`}
    text={entry.product.name}
    entity={"inventory-item"}
    openInNewTab={openInNewTab}
  />
);
export const RecipePillLink: React.FC<{
  recipe: { name: string; id: string };
  openInNewTab?: boolean;
}> = ({ recipe: { name, id }, openInNewTab }) => (
  <PillLink
    href={`/recipes/${id}`}
    text={name}
    entity={"recipe"}
    openInNewTab={openInNewTab}
  />
);
export const ProductPillLink: React.FC<{
  product: { name: string; id: string; manufacturer: string };
  openInNewTab?: boolean;
}> = ({ product: { name, id, manufacturer }, openInNewTab }) => (
  <PillLink
    href={`/products/${id}`}
    text={name}
    label={manufacturer}
    entity={"product"}
    openInNewTab={openInNewTab}
  />
);
export const FoodPillLink: React.FC<{
  food: { foodInfo: { description: string }; fdc_id: number };
  openInNewTab?: boolean;
}> = ({ food, openInNewTab }) => (
  <PillLink
    href={`/usda/${food.fdc_id}`}
    text={food.foodInfo.description}
    entity={"usda-food"}
    openInNewTab={openInNewTab}
  />
);

const PillLink: React.FC<
  PillProps & { href: string; openInNewTab?: boolean }
> = ({ href, openInNewTab, ...pillProps }) => (
  <Link
    href={href}
    target={openInNewTab ? "_blank" : undefined}
    rel={openInNewTab ? "noopener noreferrer" : undefined}
  >
    <EntityPill {...pillProps} />
  </Link>
);
