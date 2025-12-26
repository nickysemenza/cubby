"use client";

import Link from "next/link";
import type React from "react";
import { entities } from "~/entities/entities";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import type { LocationType } from "~/schemas/location";
import { isMiscProduct, getMiscDisplayName } from "~/lib/constants";
import { type Entity } from "~/entities/types";
import { Badge } from "~/components/ui/badge";

interface PillProps {
  text: string;
  entity?: Entity;
  label?: string;
}

export const EntityPill: React.FC<PillProps> = ({ text, entity, label }) => {
  return (
    <Badge variant="outline" className="max-w-full gap-1 font-medium">
      <span className="min-w-0 truncate">{text}</span>
      {entity && (
        <Badge
          variant="default"
          className="ml-0.5 h-4 shrink-0 gap-0.5 rounded-sm px-1 py-0 text-[10px]"
        >
          {entities[entity].icon}
          <span>{entities[entity].label}</span>
        </Badge>
      )}
      {label && (
        <Badge
          variant="secondary"
          className="ml-0.5 h-4 shrink-0 rounded-sm px-1 py-0 text-[10px]"
        >
          {label}
        </Badge>
      )}
    </Badge>
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

/** Compact location pill for tree views: type icon + name + type label */
export const LocationPillLinkCompact: React.FC<{
  location: { name: string; id: string; type: LocationType };
  openInNewTab?: boolean;
}> = ({ location: { name, id, type }, openInNewTab }) => (
  <Link
    href={`/${entities.location.basePath}/${id}`}
    target={openInNewTab ? "_blank" : undefined}
    rel={openInNewTab ? "noopener noreferrer" : undefined}
    className="inline-block max-w-full min-w-0"
  >
    <Badge variant="outline" className="max-w-full gap-1 font-medium">
      <LocationIcon type={type} size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{name}</span>
      <Badge
        variant="secondary"
        className="ml-0.5 h-4 shrink-0 rounded-sm px-1 py-0 text-[10px]"
      >
        {type}
      </Badge>
    </Badge>
  </Link>
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
}> = ({ product: { name, id, manufacturer }, openInNewTab }) => {
  const isMisc = isMiscProduct(name);
  return (
    <PillLink
      href={`/${entities.product.basePath}/${id}`}
      text={isMisc ? getMiscDisplayName(name) : name}
      label={isMisc ? "misc" : manufacturer}
      entity={"product"}
      openInNewTab={openInNewTab}
    />
  );
};
export const FoodPillLink: React.FC<{
  food: { foodInfo: { description: string | null }; fdc_id: number };
  openInNewTab?: boolean;
}> = ({ food, openInNewTab }) => (
  <PillLink
    href={`/usda/${food.fdc_id}`}
    text={food.foodInfo.description || "Unnamed Food"}
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
