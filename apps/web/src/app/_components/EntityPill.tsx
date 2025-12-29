import { Link } from "@tanstack/react-router";
import type React from "react";
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

const linkClass =
  "inline-flex items-center gap-1 rounded border border-border/50 px-1 py-px text-[11px] hover:border-border hover:bg-muted/50";

/** Internal helper to render pill content consistently */
function PillContent({
  name,
  metadata,
  icon,
  compact,
}: {
  name: string;
  metadata?: string;
  icon: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <>
      <span className="shrink-0">{icon}</span>
      <span
        className={cn("min-w-0 text-primary", compact && "max-w-32 truncate")}
      >
        {name}
      </span>
      {metadata && (
        <>
          <span className="shrink-0 text-muted-foreground/40">|</span>
          <span className="shrink-0 text-[9px] text-muted-foreground">
            {metadata}
          </span>
        </>
      )}
    </>
  );
}

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
            <PillContent
              name={data.name}
              icon={<EntityIcon entity="ingredient" size={12} colored />}
              compact={compact}
            />
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
            <PillContent
              name={data.name}
              icon={<EntityIcon entity="recipe" size={12} colored />}
              compact={compact}
            />
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
            <PillContent
              name={data.name}
              metadata={data.type}
              icon={
                data.type ? (
                  <LocationIcon type={data.type} size={12} colored />
                ) : (
                  <EntityIcon entity="location" size={12} colored />
                )
              }
              compact={compact}
            />
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
            <PillContent
              name={displayName}
              metadata={metadata}
              icon={<EntityIcon entity="product" size={12} colored />}
              compact={compact}
            />
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
            <PillContent
              name={text}
              icon={<EntityIcon entity="usda-food" size={12} colored />}
              compact={compact}
            />
          </TooltipTrigger>
          <TooltipContent className="max-w-lg">{text}</TooltipContent>
        </Tooltip>
      );
    }

    default:
      return assertNever(props);
  }
};
