import { Link } from "@tanstack/react-router";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { EntityIcon } from "~/entities/entities";
import { assertNever } from "~/lib/assert";
import { getMiscDisplayName, isMiscProduct } from "~/lib/constants";
import { cn } from "~/lib/utils";
import type { LocationType } from "~/schemas/location";
import { LocationIcon } from "./locations/location-icons";
import { Pill, pillClassName } from "./Pill";

// Minimal data shape - just id and name
type MinimalEntityData = { id: string; name: string };

// Discriminated union for entity-specific data shapes
type EntityPillLinkProps = {
  openInNewTab?: boolean;
  /** Compact mode: truncates long names with max-width */
  compact?: boolean;
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

const linkClass = cn(pillClassName, "hover:border-border hover:bg-muted/50");

export const EntityPillLink: React.FC<EntityPillLinkProps> = (props) => {
  const { openInNewTab, compact } = props;
  const linkTarget = openInNewTab ? "_blank" : undefined;
  const linkRel = openInNewTab ? "noopener noreferrer" : undefined;

  switch (props.entity) {
    case "ingredient": {
      const { data } = props;
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                to="/ingredients/$id"
                params={{ id: data.id }}
                target={linkTarget}
                rel={linkRel}
                className={linkClass}
              />
            }
          >
            <Pill
              icon={<EntityIcon entity="ingredient" size={12} colored />}
              compact={compact}
              className="border-0 p-0"
            >
              {data.name}
            </Pill>
          </TooltipTrigger>
          <TooltipContent className="max-w-lg">{data.name}</TooltipContent>
        </Tooltip>
      );
    }

    case "recipe": {
      const { data } = props;
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                to="/recipes/$id"
                params={{ id: data.id }}
                target={linkTarget}
                rel={linkRel}
                className={linkClass}
              />
            }
          >
            <Pill
              icon={<EntityIcon entity="recipe" size={12} colored />}
              compact={compact}
              className="border-0 p-0"
            >
              {data.name}
            </Pill>
          </TooltipTrigger>
          <TooltipContent className="max-w-lg">{data.name}</TooltipContent>
        </Tooltip>
      );
    }

    case "location": {
      const { data } = props;
      const fullText = data.type ? `${data.name} (${data.type})` : data.name;
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                to="/locations/$id"
                params={{ id: data.id }}
                target={linkTarget}
                rel={linkRel}
                className={linkClass}
              />
            }
          >
            <Pill
              icon={
                data.type ? (
                  <LocationIcon type={data.type} size={12} colored />
                ) : (
                  <EntityIcon entity="location" size={12} colored />
                )
              }
              metadata={data.type}
              compact={compact}
              className="border-0 p-0"
            >
              {data.name}
            </Pill>
          </TooltipTrigger>
          <TooltipContent className="max-w-lg">{fullText}</TooltipContent>
        </Tooltip>
      );
    }

    case "product": {
      const { data } = props;
      const isMisc = isMiscProduct(data.name);
      const displayName = isMisc ? getMiscDisplayName(data.name) : data.name;
      const metadata = isMisc ? "misc" : data.manufacturer;
      const fullText = metadata ? `${displayName} (${metadata})` : displayName;

      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                to="/products/$id"
                params={{ id: data.id }}
                target={linkTarget}
                rel={linkRel}
                className={linkClass}
              />
            }
          >
            <Pill
              icon={<EntityIcon entity="product" size={12} colored />}
              metadata={metadata}
              compact={compact}
              className="border-0 p-0"
            >
              {displayName}
            </Pill>
          </TooltipTrigger>
          <TooltipContent className="max-w-lg">{fullText}</TooltipContent>
        </Tooltip>
      );
    }

    case "usda-food": {
      const { data } = props;
      const text = data.foodInfo.description || "Unnamed Food";

      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                to="/usda/$id"
                params={{ id: String(data.fdc_id) }}
                target={linkTarget}
                rel={linkRel}
                className={linkClass}
              />
            }
          >
            <Pill
              icon={<EntityIcon entity="usda-food" size={12} colored />}
              compact={compact}
              className="border-0 p-0"
            >
              {text}
            </Pill>
          </TooltipTrigger>
          <TooltipContent className="max-w-lg">{text}</TooltipContent>
        </Tooltip>
      );
    }

    default:
      return assertNever(props);
  }
};
