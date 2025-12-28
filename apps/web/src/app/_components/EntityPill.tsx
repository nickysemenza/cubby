import { Link } from "@tanstack/react-router";
import type React from "react";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { Badge } from "~/components/ui/badge";
import { entities } from "~/entities/entities";
import type { Entity } from "~/entities/types";
import { assertNever } from "~/lib/assert";
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

// Entities that don't have pill links (no detail pages or special handling)
type ExcludedFromPillLink = "inventory-item" | "image";

// Discriminated union for entity-specific data shapes
type EntityPillLinkProps = {
  openInNewTab?: boolean;
  minimal?: boolean;
} & (
  | { entity: "ingredient"; data: { name: string; id: string } }
  | {
      entity: "product";
      data: { name: string; id: string; manufacturer: string };
    }
  | { entity: "recipe"; data: { name: string; id: string } }
  | {
      entity: "location";
      data: { name: string; id: string; type: LocationType };
    }
  | {
      entity: "usda-food";
      data: { foodInfo: { description: string | null }; fdc_id: number };
    }
);

// Compile-time check: ensure all Entity types are either handled or explicitly excluded
// If this errors, add the missing entity to EntityPillLinkProps or ExcludedFromPillLink
type _MissingEntities = Exclude<
  Entity,
  EntityPillLinkProps["entity"] | ExcludedFromPillLink
>;
// biome-ignore lint/complexity/noBannedTypes: compile-time check pattern
type _AssertAllEntitiesCovered = _MissingEntities extends never
  ? {}
  : _MissingEntities;
declare const _ensureExhaustive: _AssertAllEntitiesCovered;

const minimalLinkClass =
  "inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline";
const fullLinkClass = "inline-block min-w-0 max-w-full";

export const EntityPillLink: React.FC<EntityPillLinkProps> = (props) => {
  const { openInNewTab, minimal } = props;
  const linkTarget = openInNewTab ? "_blank" : undefined;
  const linkRel = openInNewTab ? "noopener noreferrer" : undefined;

  switch (props.entity) {
    case "ingredient": {
      const { data } = props;
      return (
        <Link
          to="/ingredients/$id"
          params={{ id: data.id }}
          target={linkTarget}
          rel={linkRel}
          className={minimal ? minimalLinkClass : fullLinkClass}
        >
          {minimal ? (
            data.name
          ) : (
            <EntityPill text={data.name} entity="ingredient" />
          )}
        </Link>
      );
    }

    case "recipe": {
      const { data } = props;
      return (
        <Link
          to="/recipes/$id"
          params={{ id: data.id }}
          target={linkTarget}
          rel={linkRel}
          className={minimal ? minimalLinkClass : fullLinkClass}
        >
          {minimal ? (
            data.name
          ) : (
            <EntityPill text={data.name} entity="recipe" />
          )}
        </Link>
      );
    }

    case "location": {
      const { data } = props;
      return (
        <Link
          to="/locations/$id"
          params={{ id: data.id }}
          target={linkTarget}
          rel={linkRel}
          className={minimal ? minimalLinkClass : fullLinkClass}
        >
          {minimal ? (
            <>
              <LocationIcon type={data.type} size={12} className="shrink-0" />
              <span>{data.name}</span>
              <span className="text-[10px] text-muted-foreground">
                ({data.type})
              </span>
            </>
          ) : (
            <EntityPill text={data.name} entity="location" label={data.type} />
          )}
        </Link>
      );
    }

    case "product": {
      const { data } = props;
      const isMisc = isMiscProduct(data.name);
      const displayName = isMisc ? getMiscDisplayName(data.name) : data.name;
      const label = isMisc ? "misc" : data.manufacturer;

      return (
        <Link
          to="/products/$id"
          params={{ id: data.id }}
          target={linkTarget}
          rel={linkRel}
          className={minimal ? minimalLinkClass : fullLinkClass}
        >
          {minimal ? (
            <>
              <span>{displayName}</span>
              {label && (
                <span className="text-[10px] text-muted-foreground">
                  ({label})
                </span>
              )}
            </>
          ) : (
            <EntityPill text={displayName} entity="product" label={label} />
          )}
        </Link>
      );
    }

    case "usda-food": {
      const { data } = props;
      const text = data.foodInfo.description || "Unnamed Food";

      return (
        <Link
          to="/usda/$id"
          params={{ id: String(data.fdc_id) }}
          target={linkTarget}
          rel={linkRel}
          className={minimal ? minimalLinkClass : fullLinkClass}
        >
          {minimal ? text : <EntityPill text={text} entity="usda-food" />}
        </Link>
      );
    }

    default:
      return assertNever(props);
  }
};
