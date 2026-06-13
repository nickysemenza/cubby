import type { LocationType } from "@cubby/schemas/location";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { match } from "ts-pattern";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { EntityIcon } from "~/entities/entities";
import { cn } from "~/lib/utils";
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

// Crisp entity link (2026-06-12 pill diet): a colored wayfinding icon + the
// name as a dotted-underlined text link, with optional muted metadata. Replaces
// the old bordered pill so dense lists/tables read as text, not chips.
const linkClass =
  "group inline-flex max-w-full items-baseline gap-1.5 align-baseline text-foreground transition-colors hover:text-primary";

function EntityLinkBody({
  icon,
  name,
  metadata,
  compact,
}: {
  icon: ReactNode;
  name: string;
  metadata?: string;
  compact?: boolean;
}) {
  return (
    <>
      <span className="shrink-0 self-center">{icon}</span>
      <span
        className={cn(
          "min-w-0 font-medium underline decoration-border/70 decoration-dotted underline-offset-2 group-hover:decoration-primary group-hover:decoration-solid",
          compact && "max-w-32 truncate",
        )}
      >
        {name}
      </span>
      {metadata && (
        <span className="shrink-0 text-2xs text-muted-foreground">
          · {metadata}
        </span>
      )}
    </>
  );
}

export const EntityPillLink: React.FC<EntityPillLinkProps> = (props) => {
  const { openInNewTab, compact } = props;
  const linkTarget = openInNewTab ? "_blank" : undefined;
  const linkRel = openInNewTab ? "noopener noreferrer" : undefined;

  return match(props)
    .with({ entity: "ingredient" }, ({ data }) => (
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
          <EntityLinkBody
            icon={<EntityIcon entity="ingredient" size={12} colored />}
            name={data.name}
            compact={compact}
          />
        </TooltipTrigger>
        <TooltipContent className="max-w-lg">{data.name}</TooltipContent>
      </Tooltip>
    ))
    .with({ entity: "recipe" }, ({ data }) => (
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
          <EntityLinkBody
            icon={<EntityIcon entity="recipe" size={12} colored />}
            name={data.name}
            compact={compact}
          />
        </TooltipTrigger>
        <TooltipContent className="max-w-lg">{data.name}</TooltipContent>
      </Tooltip>
    ))
    .with({ entity: "location" }, ({ data }) => {
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
            <EntityLinkBody
              icon={
                data.type ? (
                  <LocationIcon type={data.type} size={12} colored />
                ) : (
                  <EntityIcon entity="location" size={12} colored />
                )
              }
              name={data.name}
              metadata={data.type}
              compact={compact}
            />
          </TooltipTrigger>
          <TooltipContent className="max-w-lg">{fullText}</TooltipContent>
        </Tooltip>
      );
    })
    .with({ entity: "product" }, ({ data }) => {
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
            <EntityLinkBody
              icon={<EntityIcon entity="product" size={12} colored />}
              name={displayName}
              metadata={metadata}
              compact={compact}
            />
          </TooltipTrigger>
          <TooltipContent className="max-w-lg">{fullText}</TooltipContent>
        </Tooltip>
      );
    })
    .with({ entity: "usda-food" }, ({ data }) => {
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
            <EntityLinkBody
              icon={<EntityIcon entity="usda-food" size={12} colored />}
              name={text}
              compact={compact}
            />
          </TooltipTrigger>
          <TooltipContent className="max-w-lg">{text}</TooltipContent>
        </Tooltip>
      );
    })
    .exhaustive();
};
