import { Link } from "@tanstack/react-router";
import type React from "react";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { Badge } from "~/components/ui/badge";
import { entities } from "~/entities/entities";
import type { Entity } from "~/entities/types";
import { getMiscDisplayName, isMiscProduct } from "~/lib/constants";
import type { LocationType } from "~/schemas/location";

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
    to="/ingredients/$id"
    params={{ id }}
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
    to="/locations/$id"
    params={{ id }}
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
    to="/locations/$id"
    params={{ id }}
    target={openInNewTab ? "_blank" : undefined}
    rel={openInNewTab ? "noopener noreferrer" : undefined}
    className="inline-block min-w-0 max-w-full"
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
    to="/recipes/$id"
    params={{ id }}
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
      to="/products/$id"
      params={{ id }}
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
    to="/usda/$id"
    params={{ id: String(food.fdc_id) }}
    text={food.foodInfo.description || "Unnamed Food"}
    entity={"usda-food"}
    openInNewTab={openInNewTab}
  />
);

const PillLink: React.FC<
  PillProps & {
    to: string;
    params: Record<string, string>;
    openInNewTab?: boolean;
  }
> = ({ to, params, openInNewTab, ...pillProps }) => (
  <Link
    // Type assertion needed because PillLink is used with dynamic entity routes
    to={to as "/products/$id"}
    params={params as { id: string }}
    target={openInNewTab ? "_blank" : undefined}
    rel={openInNewTab ? "noopener noreferrer" : undefined}
    className="inline-block min-w-0 max-w-full"
  >
    <EntityPill {...pillProps} />
  </Link>
);
