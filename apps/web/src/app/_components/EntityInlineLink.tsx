import type { LocationType } from "@cubby/schemas/location";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";
import type { DataType } from "@cubby/usda-schemas";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { match } from "ts-pattern";
import { EntityIcon } from "~/entities/entities";
import { usdaRouteId } from "~/entities/entity-query";
import { dataTypeColor, UsdaDataTypeDot } from "~/lib/usda-data-type";
import { cn } from "~/lib/utils";
import { EntityPreviewLink } from "./EntityPreviewLink";
import { LocationIcon } from "./locations/location-icons";

// Minimal data shape - just id and name
type MinimalEntityData = { id: string; name: string };

// Discriminated union for entity-specific data shapes
type EntityInlineLinkProps = {
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
  | { entity: "inventory"; data: MinimalEntityData }
  | {
      entity: "usda-food";
      data: {
        foodInfo: { description: string | null; data_type?: DataType };
        fdc_id: number;
      };
    }
);

// Crisp entity link: a colored wayfinding icon + the name as a
// dotted-underlined text link, with optional muted metadata.
const linkClass =
  "group inline-flex max-w-full items-baseline gap-2 align-baseline text-foreground transition-colors hover:text-primary";

function EntityLinkBody({
  icon,
  name,
  metadata,
  compact,
  trailing,
}: {
  icon: ReactNode;
  name: string;
  metadata?: string;
  compact?: boolean;
  trailing?: ReactNode;
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
      {trailing && <span className="shrink-0 self-center">{trailing}</span>}
    </>
  );
}

export const EntityInlineLink: React.FC<EntityInlineLinkProps> = (props) => {
  const { openInNewTab, compact } = props;

  return match(props)
    .with({ entity: "ingredient" }, ({ data }) => (
      <EntityPreviewLink
        entity="ingredient"
        id={data.id}
        openInNewTab={openInNewTab}
        className={linkClass}
      >
        <EntityLinkBody
          icon={<EntityIcon entity="ingredient" size={12} colored />}
          name={data.name}
          compact={compact}
        />
      </EntityPreviewLink>
    ))
    .with({ entity: "recipe" }, ({ data }) => (
      <EntityPreviewLink
        entity="recipe"
        id={data.id}
        openInNewTab={openInNewTab}
        className={linkClass}
      >
        <EntityLinkBody
          icon={<EntityIcon entity="recipe" size={12} colored />}
          name={data.name}
          compact={compact}
        />
      </EntityPreviewLink>
    ))
    .with({ entity: "location" }, ({ data }) => (
      <EntityPreviewLink
        entity="location"
        id={data.id}
        openInNewTab={openInNewTab}
        className={linkClass}
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
      </EntityPreviewLink>
    ))
    .with({ entity: "product" }, ({ data }) => {
      const isMisc = isMiscProduct(data.name);
      const displayName = isMisc ? getMiscDisplayName(data.name) : data.name;
      const metadata = isMisc ? "misc" : data.manufacturer;

      return (
        <EntityPreviewLink
          entity="product"
          id={data.id}
          openInNewTab={openInNewTab}
          className={linkClass}
        >
          <EntityLinkBody
            icon={<EntityIcon entity="product" size={12} colored />}
            name={displayName}
            metadata={metadata}
            compact={compact}
          />
        </EntityPreviewLink>
      );
    })
    .with({ entity: "inventory" }, ({ data }) => (
      <Link
        to="/inventory/$id"
        params={{ id: data.id }}
        target={openInNewTab ? "_blank" : undefined}
        rel={openInNewTab ? "noopener noreferrer" : undefined}
        className={linkClass}
      >
        <EntityLinkBody
          icon={<EntityIcon entity="inventory" size={12} colored />}
          name={data.name}
          compact={compact}
        />
      </Link>
    ))
    .with({ entity: "usda-food" }, ({ data }) => {
      const text = data.foodInfo.description || "Unnamed Food";
      const dataType = data.foodInfo.data_type;

      // Tint the apple + trail a dot by data_type so the source quality reads at
      // a glance in dense lists (terracotta SR Legacy = richest, plum = branded).
      const icon = dataType ? (
        <EntityIcon
          entity="usda-food"
          size={12}
          style={{ color: dataTypeColor(dataType) }}
        />
      ) : (
        <EntityIcon entity="usda-food" size={12} colored />
      );

      return (
        <EntityPreviewLink
          entity="usda-food"
          id={usdaRouteId(data.fdc_id)}
          openInNewTab={openInNewTab}
          className={linkClass}
        >
          <EntityLinkBody
            icon={icon}
            name={text}
            compact={compact}
            trailing={
              dataType ? <UsdaDataTypeDot dataType={dataType} /> : undefined
            }
          />
        </EntityPreviewLink>
      );
    })
    .exhaustive();
};
