import { Link } from "@tanstack/react-router";
import type React from "react";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { assertNever } from "~/lib/assert";
import { getMiscDisplayName, isMiscProduct } from "~/lib/constants";
import type { LocationType } from "~/schemas/location";

// Minimal data shape - just id and name
type MinimalEntityData = { id: string; name: string };

// Discriminated union for entity-specific data shapes
type EntityPillLinkProps = {
  openInNewTab?: boolean;
} & (
  | { entity: "ingredient"; data: MinimalEntityData }
  | {
      entity: "product";
      data: MinimalEntityData & { manufacturer?: string };
    }
  | { entity: "recipe"; data: MinimalEntityData }
  | {
      entity: "location";
      data: MinimalEntityData & { type?: LocationType };
    }
  | {
      entity: "usda-food";
      data: { foodInfo: { description: string | null }; fdc_id: number };
    }
);

const linkClass =
  "inline-flex items-center gap-1 rounded border border-border/50 px-1 py-px text-sm text-primary hover:border-border hover:bg-muted/50";

export const EntityPillLink: React.FC<EntityPillLinkProps> = (props) => {
  const { openInNewTab } = props;
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
          className={linkClass}
        >
          {data.name}
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
          className={linkClass}
        >
          {data.name}
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
          className={linkClass}
        >
          {data.type && (
            <LocationIcon type={data.type} size={12} className="shrink-0" />
          )}
          <span>{data.name}</span>
          {data.type && (
            <span className="text-[10px] text-muted-foreground">
              ({data.type})
            </span>
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
          className={linkClass}
        >
          <span>{displayName}</span>
          {label && (
            <span className="text-[10px] text-muted-foreground">({label})</span>
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
          className={linkClass}
        >
          {text}
        </Link>
      );
    }

    default:
      return assertNever(props);
  }
};
