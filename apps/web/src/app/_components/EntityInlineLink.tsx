import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import type { LocationType } from "@cubby/schemas/location";
import type { ProductCategory } from "@cubby/schemas/product";
import type {
  ProjectKind,
  ProjectStatus,
  TaskStatus,
} from "@cubby/schemas/project";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";
import type { DataType } from "@cubby/usda-schemas";
import type { ReactNode } from "react";
import { match } from "ts-pattern";
import {
  capitalize,
  PROJECT_STATUS_LABELS,
} from "~/app/projects/project-formatting";
import { ProjectMarkById } from "~/app/projects/project-mark";
import { EntityIcon } from "~/entities/entities";
import { usdaRouteId } from "~/entities/entity-query";
import { purchaseLabel, purchaseLabelUsedVendor } from "~/lib/purchase-label";
import { dataTypeColor, UsdaDataTypeDot } from "~/lib/usda-data-type";
import { cn, formatCurrency } from "~/lib/utils";
import { EntityPreviewLink } from "./EntityPreviewLink";
import { LocationIcon } from "./locations/location-icons";
import type { HoverPreviewEntity } from "./preview/preview-entities";

// Minimal data shape - just id and name
type MinimalEntityData = { id: string; name: string };

// Discriminated union for entity-specific data shapes
type EntityInlineLinkProps = {
  openInNewTab?: boolean;
  /** Compact mode: truncates long names with max-width */
  compact?: boolean;
  /** Truncate the name to the available flex width (no fixed cap). Parent must be min-w-0. */
  truncate?: boolean;
  /** An adjacent dedicated image/mark already identifies this record. */
  showIdentityMark?: boolean;
  /**
   * Backend-enriched canonical image. Null explicitly suppresses inline media;
   * undefined derives from an established enriched projection during rollout.
   */
  displayImage: ImageUrlSummary | null | undefined;
} & (
  | { entity: "ingredient"; data: MinimalEntityData }
  | {
      entity: "product";
      data: MinimalEntityData & { manufacturer?: string };
    }
  | { entity: "recipe"; data: MinimalEntityData }
  | { entity: "cookbook"; data: MinimalEntityData & { authors?: string[] } }
  | { entity: "meal"; data: MinimalEntityData & { date?: string | null } }
  | {
      entity: "location";
      data: MinimalEntityData & {
        type?: LocationType | null;
        product?: { category: ProductCategory | null } | null;
      };
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
      entity: "expense";
      data: MinimalEntityData & {
        cost?: number | null;
        projectName?: string | null;
      };
    }
  // A purchase has NO `name` — its identity is (vendor, orderId, date), with an
  // optional human display label, so the visible text comes from
  // `purchaseLabel`. Deliberately not `MinimalEntityData`: accepting an
  // invented name would collapse vendor identity and human context together.
  | {
      entity: "purchase";
      data: {
        id: string;
        orderId: string | null;
        displayLabel?: string | null;
        vendorName?: string | null;
        date?: string | null;
      };
    }
  | {
      entity: "vendor";
      data: MinimalEntityData;
    }
);

// Crisp entity link: a colored wayfinding icon + the name as a
// dotted-underlined text link, with optional muted metadata.
const linkClass =
  "group inline-flex max-w-full items-baseline gap-2 align-baseline text-foreground transition-colors hover:text-primary";

interface EntityLinkBodyProps {
  name: string;
  metadata?: string;
  compact?: boolean;
  truncate?: boolean;
  trailing?: ReactNode;
}

function EntityLinkBody({
  name,
  metadata,
  compact,
  truncate,
  trailing,
}: EntityLinkBodyProps) {
  return (
    <>
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

function PreviewEntityLink({
  entity,
  id,
  displayImage,
  fallbackMark,
  showIdentityMark,
  openInNewTab,
  className,
  ...body
}: EntityLinkBodyProps & {
  entity: HoverPreviewEntity;
  id: string;
  displayImage: ImageUrlSummary | null;
  fallbackMark: ReactNode;
  showIdentityMark?: boolean;
  openInNewTab?: boolean;
  className: string;
}) {
  return (
    <EntityPreviewLink
      entity={entity}
      id={id}
      displayImage={displayImage}
      fallbackMark={fallbackMark}
      showIdentityMark={showIdentityMark}
      openInNewTab={openInNewTab}
      className={className}
    >
      <EntityLinkBody {...body} />
    </EntityPreviewLink>
  );
}

export const EntityInlineLink: React.FC<EntityInlineLinkProps> = (props) => {
  const { openInNewTab, compact, truncate, showIdentityMark } = props;
  const displayImage =
    props.displayImage === undefined
      ? displayImageFromData(props.data)
      : props.displayImage;
  const wrapperClass = cn(linkClass, truncate && "min-w-0");

  return match(props)
    .with({ entity: "ingredient" }, ({ data }) => (
      <PreviewEntityLink
        entity="ingredient"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
        displayImage={displayImage}
        showIdentityMark={showIdentityMark}
        fallbackMark={<EntityIcon entity="ingredient" size={12} colored />}
        name={data.name}
        compact={compact}
        truncate={truncate}
      />
    ))
    .with({ entity: "recipe" }, ({ data }) => (
      <PreviewEntityLink
        entity="recipe"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
        displayImage={displayImage}
        showIdentityMark={showIdentityMark}
        fallbackMark={<EntityIcon entity="recipe" size={12} colored />}
        name={data.name}
        compact={compact}
        truncate={truncate}
      />
    ))
    .with({ entity: "cookbook" }, ({ data }) => (
      <PreviewEntityLink
        entity="cookbook"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
        displayImage={displayImage}
        showIdentityMark={showIdentityMark}
        fallbackMark={<EntityIcon entity="cookbook" size={12} colored />}
        name={data.name}
        metadata={data.authors?.length ? data.authors.join(", ") : undefined}
        compact={compact}
        truncate={truncate}
      />
    ))
    .with({ entity: "meal" }, ({ data }) => (
      <PreviewEntityLink
        entity="meal"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
        displayImage={displayImage}
        showIdentityMark={showIdentityMark}
        fallbackMark={<EntityIcon entity="meal" size={12} colored />}
        name={data.name}
        metadata={data.date ?? undefined}
        compact={compact}
        truncate={truncate}
      />
    ))
    .with({ entity: "location" }, ({ data }) => (
      <PreviewEntityLink
        entity="location"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
        displayImage={displayImage}
        showIdentityMark={showIdentityMark}
        fallbackMark={
          data.type ? (
            <LocationIcon
              type={data.type}
              product={data.product ?? null}
              size={12}
              colored
            />
          ) : (
            <EntityIcon entity="location" size={12} colored />
          )
        }
        name={data.name}
        metadata={data.type ?? undefined}
        compact={compact}
        truncate={truncate}
      />
    ))
    .with({ entity: "product" }, ({ data }) => {
      const isMisc = isMiscProduct(data.name);
      const displayName = isMisc ? getMiscDisplayName(data.name) : data.name;
      const metadata = isMisc ? "misc" : data.manufacturer;

      return (
        <PreviewEntityLink
          entity="product"
          id={data.id}
          openInNewTab={openInNewTab}
          className={wrapperClass}
          displayImage={displayImage}
          showIdentityMark={showIdentityMark}
          fallbackMark={<EntityIcon entity="product" size={12} colored />}
          name={displayName}
          metadata={metadata}
          compact={compact}
          truncate={truncate}
        />
      );
    })
    .with({ entity: "inventory" }, ({ data }) => (
      <PreviewEntityLink
        entity="inventory"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
        displayImage={displayImage}
        showIdentityMark={showIdentityMark}
        fallbackMark={<EntityIcon entity="inventory" size={12} colored />}
        name={data.name}
        compact={compact}
        truncate={truncate}
      />
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
        <PreviewEntityLink
          entity="usda-food"
          // usda-food has no shortcode — fdc_id IS its public id.
          id={usdaRouteId(data.fdc_id)}
          openInNewTab={openInNewTab}
          className={wrapperClass}
          displayImage={displayImage}
          showIdentityMark={showIdentityMark}
          fallbackMark={icon}
          name={text}
          compact={compact}
          truncate={truncate}
          trailing={
            dataType ? <UsdaDataTypeDot dataType={dataType} /> : undefined
          }
        />
      );
    })
    .with({ entity: "project" }, ({ data }) => (
      <PreviewEntityLink
        entity="project"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
        displayImage={displayImage}
        showIdentityMark={showIdentityMark}
        fallbackMark={
          <ProjectMarkById projectId={data.id} icon={data.icon} size={12} />
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
    ))
    .with({ entity: "task" }, ({ data }) => (
      <PreviewEntityLink
        entity="task"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
        displayImage={displayImage}
        showIdentityMark={showIdentityMark}
        fallbackMark={<EntityIcon entity="task" size={12} colored />}
        name={data.name}
        metadata={data.projectName ?? undefined}
        compact={compact}
        truncate={truncate}
      />
    ))
    .with({ entity: "expense" }, ({ data }) => (
      <PreviewEntityLink
        entity="expense"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
        displayImage={displayImage}
        showIdentityMark={showIdentityMark}
        fallbackMark={<EntityIcon entity="expense" size={12} colored />}
        name={data.name}
        metadata={
          data.cost != null
            ? formatCurrency(data.cost)
            : (data.projectName ?? undefined)
        }
        compact={compact}
        truncate={truncate}
      />
    ))
    .with({ entity: "purchase" }, ({ data }) => (
      <PreviewEntityLink
        entity="purchase"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
        displayImage={displayImage}
        showIdentityMark={showIdentityMark}
        fallbackMark={<EntityIcon entity="purchase" size={12} colored />}
        name={purchaseLabel(data)}
        // Only when the label is the order id — otherwise the fallback label
        // already leads with the vendor and this would print it twice.
        metadata={
          purchaseLabelUsedVendor(data)
            ? undefined
            : (data.vendorName ?? undefined)
        }
        compact={compact}
        truncate={truncate}
      />
    ))
    .with({ entity: "vendor" }, ({ data }) => (
      <PreviewEntityLink
        entity="vendor"
        id={data.id}
        openInNewTab={openInNewTab}
        className={wrapperClass}
        displayImage={displayImage}
        showIdentityMark={showIdentityMark}
        fallbackMark={<EntityIcon entity="vendor" size={12} colored />}
        name={data.name}
        compact={compact}
        truncate={truncate}
      />
    ))
    .exhaustive();
};

/** Normalize established enriched projections while DTOs converge on one field. */
function displayImageFromData(data: unknown): ImageUrlSummary | null {
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  const direct = [
    value.displayImage,
    value.coverImage,
    value.logo,
    value.vendorLogo,
  ];
  for (const candidate of direct) {
    if (
      candidate &&
      typeof candidate === "object" &&
      "url" in candidate &&
      typeof candidate.url === "string"
    ) {
      return { url: candidate.url };
    }
  }
  for (const key of ["coverImageUrl", "coverUrl", "imageUrl"] as const) {
    if (typeof value[key] === "string") return { url: value[key] };
  }
  const images = value.images;
  if (Array.isArray(images)) {
    const first = images.find(
      (image) =>
        image && typeof image === "object" && typeof image.url === "string",
    );
    if (first) return { url: first.url as string };
  }
  return null;
}
