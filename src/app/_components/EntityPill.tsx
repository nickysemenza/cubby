"use client";

import Link from "next/link";
import type React from "react";
import { cva } from "class-variance-authority";
import { entities } from "~/entities/entities";
import { type Entity } from "~/entities/types";

const pillVariants = cva(
  "inline-flex items-center truncate rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset transition-colors",
  {
    variants: {
      variant: {
        default: "bg-muted text-muted-foreground ring-border hover:bg-accent",
        entity: "bg-primary/10 text-primary ring-primary/20",
        label: "bg-secondary text-secondary-foreground ring-border",
      },
      size: {
        default: "px-1.5 py-0.5 text-xs",
        small: "px-1 py-0.5 text-xs",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

interface PillProps {
  text: string;
  entity?: Entity;
  label?: string;
}

export const EntityPill: React.FC<PillProps> = ({ text, entity, label }) => {
  return (
    <span
      className={pillVariants({ variant: "default", className: "max-w-full" })}
    >
      <span className="min-w-0 truncate">{text}</span>
      {entity && (
        <span
          className={pillVariants({
            variant: "entity",
            size: "small",
            className: "ml-1 flex-shrink-0 rounded-sm",
          })}
        >
          {entities[entity].icon}
          <span className="ml-0.5">{entities[entity].label}</span>
        </span>
      )}
      {label && (
        <span
          className={pillVariants({
            variant: "label",
            size: "small",
            className: "ml-1 flex-shrink-0 rounded-sm",
          })}
        >
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
    href={`/${entities.ingredient.basePath}/${id}`}
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
    href={`/${entities.location.basePath}/${id}`}
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
    href={`/${entities["inventory-item"].basePath}/${entry.id}`}
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
    href={`/${entities.recipe.basePath}/${id}`}
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
    href={`/${entities.product.basePath}/${id}`}
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
    className="inline-block max-w-full min-w-0"
  >
    <EntityPill {...pillProps} />
  </Link>
);
