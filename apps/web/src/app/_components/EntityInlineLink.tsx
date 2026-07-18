import type { LocationType } from "@cubby/schemas/location";
import type {
  ProjectKind,
  ProjectStatus,
  TaskStatus,
} from "@cubby/schemas/project";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";
import type { DataType } from "@cubby/usda-schemas";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { match } from "ts-pattern";
import { capitalize, PROJECT_STATUS_LABELS } from "~/app/projects/shared";
import { EntityIcon } from "~/entities/entities";
import { usdaRouteId } from "~/entities/entity-query";
import { dataTypeColor, UsdaDataTypeDot } from "~/lib/usda-data-type";
import { cn, formatCurrency } from "~/lib/utils";
import { EntityPreviewLink } from "./EntityPreviewLink";
import { LocationIcon } from "./locations/location-icons";

// Minimal data shape - just id and name
type MinimalEntityData = { id: string; name: string };

// Discriminated union for entity-specific data shapes
type EntityInlineLinkProps = {
  openInNewTab?: boolean;
  /** Compact mode: truncates long names with max-width */
  compact?: boolean;
  /** Truncate the name to the available flex width (no fixed cap). Parent must be min-w-0. */
  truncate?: boolean;
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
  | {
      entity: "project";
      data: MinimalEntityData & {
        icon?: string | null;
        status?: ProjectStatus;
        kind?: ProjectKind | null;
      };
    }
  | {
      entity: "task";
      data: MinimalEntityData & {
        status?: TaskStatus;
        projectName?: string | null;
      };
    }
  | {
      entity: "purchase";
      data: MinimalEntityData & {
        cost?: number | null;
        projectName?: string | null;
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
  truncate,
  trailing,
}: {
  icon: ReactNode;
  name: string;
  metadata?: string;
  compact?: boolean;
  truncate?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <>
      <span className="shrink-0 self-center">{icon}</span>
      <span
        className={cn(
          "min-w-0 font-medium underline decoration-border/70 decoration-dotted underline-offset-2 group-hover:decoration-primary group-hover:decoration-solid",
          compact && "max-w-32 truncate",
          truncate && "truncate",
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
  const { openInNewTab, compact, truncate } = props;
  const wrapperClass = cn(linkClass, truncate && "min-w-0");

  return match(props)
    .with({ entity: "ingredient" }, ({ data }) => (
      <EntityPreviewLink
        entity="ingredient"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
      >
        <EntityLinkBody
          icon={<EntityIcon entity="ingredient" size={12} colored />}
          name={data.name}
          compact={compact}
          truncate={truncate}
        />
      </EntityPreviewLink>
    ))
    .with({ entity: "recipe" }, ({ data }) => (
      <EntityPreviewLink
        entity="recipe"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
      >
        <EntityLinkBody
          icon={<EntityIcon entity="recipe" size={12} colored />}
          name={data.name}
          compact={compact}
          truncate={truncate}
        />
      </EntityPreviewLink>
    ))
    .with({ entity: "location" }, ({ data }) => (
      <EntityPreviewLink
        entity="location"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
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
          truncate={truncate}
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
          className={wrapperClass}
        >
          <EntityLinkBody
            icon={<EntityIcon entity="product" size={12} colored />}
            name={displayName}
            metadata={metadata}
            compact={compact}
            truncate={truncate}
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
        className={wrapperClass}
      >
        <EntityLinkBody
          icon={<EntityIcon entity="inventory" size={12} colored />}
          name={data.name}
          compact={compact}
          truncate={truncate}
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
          className={wrapperClass}
        >
          <EntityLinkBody
            icon={icon}
            name={text}
            compact={compact}
            truncate={truncate}
            trailing={
              dataType ? <UsdaDataTypeDot dataType={dataType} /> : undefined
            }
          />
        </EntityPreviewLink>
      );
    })
    .with({ entity: "project" }, ({ data }) => (
      <EntityPreviewLink
        entity="project"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
      >
        <EntityLinkBody
          icon={
            data.icon ? (
              <span className="text-xs leading-none">{data.icon}</span>
            ) : (
              <EntityIcon entity="project" size={12} colored />
            )
          }
          name={data.name}
          metadata={
            data.kind
              ? capitalize(data.kind)
              : data.status
                ? PROJECT_STATUS_LABELS[data.status]
                : undefined
          }
          compact={compact}
          truncate={truncate}
        />
      </EntityPreviewLink>
    ))
    .with({ entity: "task" }, ({ data }) => (
      <EntityPreviewLink
        entity="task"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
      >
        <EntityLinkBody
          icon={<EntityIcon entity="task" size={12} colored />}
          name={data.name}
          metadata={data.projectName ?? undefined}
          compact={compact}
          truncate={truncate}
        />
      </EntityPreviewLink>
    ))
    .with({ entity: "purchase" }, ({ data }) => (
      <EntityPreviewLink
        entity="purchase"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
      >
        <EntityLinkBody
          icon={<EntityIcon entity="purchase" size={12} colored />}
          name={data.name}
          metadata={
            data.cost != null
              ? formatCurrency(data.cost)
              : (data.projectName ?? undefined)
          }
          compact={compact}
          truncate={truncate}
        />
      </EntityPreviewLink>
    ))
    .exhaustive();
};
