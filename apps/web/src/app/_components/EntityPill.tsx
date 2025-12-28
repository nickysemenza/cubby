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

/** Minimal link style - just text with optional label in parentheses */
const MinimalLink: React.FC<{
  to: string;
  params: Record<string, string>;
  text: string;
  label?: string;
  icon?: React.ReactNode;
  openInNewTab?: boolean;
}> = ({ to, params, text, label, icon, openInNewTab }) => (
  <Link
    to={to as "/products/$id"}
    params={params as { id: string }}
    target={openInNewTab ? "_blank" : undefined}
    rel={openInNewTab ? "noopener noreferrer" : undefined}
    className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
  >
    {icon}
    <span>{text}</span>
    {label && (
      <span className="text-[10px] text-muted-foreground">({label})</span>
    )}
  </Link>
);

export const IngredientPillLink: React.FC<{
  ingredient: { name: string; id: string };
  openInNewTab?: boolean;
  minimal?: boolean;
}> = ({ ingredient: { name, id }, openInNewTab, minimal }) => {
  if (minimal) {
    return (
      <MinimalLink
        to="/ingredients/$id"
        params={{ id }}
        text={name}
        openInNewTab={openInNewTab}
      />
    );
  }
  return (
    <PillLink
      to="/ingredients/$id"
      params={{ id }}
      text={name}
      entity="ingredient"
      openInNewTab={openInNewTab}
    />
  );
};

export const LocationPillLink: React.FC<{
  location: { name: string; id: string; type: LocationType };
  openInNewTab?: boolean;
  minimal?: boolean;
}> = ({ location: { name, id, type }, openInNewTab, minimal }) => {
  if (minimal) {
    return (
      <MinimalLink
        to="/locations/$id"
        params={{ id }}
        text={name}
        label={type}
        icon={<LocationIcon type={type} size={12} className="shrink-0" />}
        openInNewTab={openInNewTab}
      />
    );
  }
  return (
    <PillLink
      to="/locations/$id"
      params={{ id }}
      text={name}
      entity={"location"}
      label={type}
      openInNewTab={openInNewTab}
    />
  );
};

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
  minimal?: boolean;
}> = ({ recipe: { name, id }, openInNewTab, minimal }) => {
  if (minimal) {
    return (
      <MinimalLink
        to="/recipes/$id"
        params={{ id }}
        text={name}
        openInNewTab={openInNewTab}
      />
    );
  }
  return (
    <PillLink
      to="/recipes/$id"
      params={{ id }}
      text={name}
      entity={"recipe"}
      openInNewTab={openInNewTab}
    />
  );
};

export const ProductPillLink: React.FC<{
  product: { name: string; id: string; manufacturer: string };
  openInNewTab?: boolean;
  minimal?: boolean;
}> = ({ product: { name, id, manufacturer }, openInNewTab, minimal }) => {
  const isMisc = isMiscProduct(name);
  const displayName = isMisc ? getMiscDisplayName(name) : name;
  const label = isMisc ? "misc" : manufacturer;

  if (minimal) {
    return (
      <MinimalLink
        to="/products/$id"
        params={{ id }}
        text={displayName}
        label={label}
        openInNewTab={openInNewTab}
      />
    );
  }
  return (
    <PillLink
      to="/products/$id"
      params={{ id }}
      text={displayName}
      label={label}
      entity={"product"}
      openInNewTab={openInNewTab}
    />
  );
};

export const FoodPillLink: React.FC<{
  food: { foodInfo: { description: string | null }; fdc_id: number };
  openInNewTab?: boolean;
  minimal?: boolean;
}> = ({ food, openInNewTab, minimal }) => {
  const text = food.foodInfo.description || "Unnamed Food";

  if (minimal) {
    return (
      <MinimalLink
        to="/usda/$id"
        params={{ id: String(food.fdc_id) }}
        text={text}
        openInNewTab={openInNewTab}
      />
    );
  }
  return (
    <PillLink
      to="/usda/$id"
      params={{ id: String(food.fdc_id) }}
      text={text}
      entity={"usda-food"}
      openInNewTab={openInNewTab}
    />
  );
};

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
