import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import type { LocationType } from "@cubby/schemas/location";
import type {
  ProjectKind,
  ProjectStatus,
  TaskStatus,
} from "@cubby/schemas/project";
import type { ProductCategory } from "@cubby/shared";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";
import type { DataType } from "@cubby/usda-schemas";
import type { ReactNode } from "react";
import { match } from "ts-pattern";

import { LocationIcon } from "~/app/_components/locations/location-icons";
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

import { PreviewRefLink } from "./leaf";

// Minimal data shape - just id and name
type MinimalEntityData = { id: string; name: string };

// Discriminated union for entity-specific data shapes
export type InlineRefLinkProps = {
  variant?: "inline";
  openInNewTab?: boolean;
  /** Optional sizing/layout classes applied to the actual anchor. */
  className?: string;
  /** Compact mode: truncates long names with max-width */
  compact?: boolean;
  /** Truncate the name to the available flex width (no fixed cap). Parent must be min-w-0. */
  truncate?: boolean;
  /** An adjacent dedicated image/mark already identifies this record. */
  showIdentityMark?: boolean;
  /** Canonical backend-resolved cover; null intentionally renders the mark. */
  displayImage: ImageUrlSummary | null;
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
      // `product.category` is declared because `LocationIcon` reads it; image
      // selection is supplied only by the canonical display-image contract.
      data: MinimalEntityData & {
        type?: LocationType | null;
        product?: { category: ProductCategory | null } | null;
      };
    }
  | { entity: "inventory"; data: MinimalEntityData }
  // Neither has a `name` column — callers pass the computed `displayName`
  // ("<ingredient> · <variety>" / "<Kind> · <date> · <location>") as `name`.
  | { entity: "planting"; data: MinimalEntityData }
  | { entity: "gardenEntry"; data: MinimalEntityData }
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
  | { entity: "vendor"; data: MinimalEntityData }
  | { entity: "financialAccount"; data: MinimalEntityData }
  | {
      entity: "financialTransaction";
      data: { id: string; displayName: string };
    }
  | { entity: "wish"; data: MinimalEntityData }
  | { entity: "image"; data: { id: string; filename: string } }
);

/** What the shared link body needs from one entity's data shape. */
type InlineSpec = {
  id: string;
  name: string;
  metadata?: string;
  /** Overrides the default coloured entity icon. */
  mark?: ReactNode;
  trailing?: ReactNode;
};

const inlineSpec = (props: InlineRefLinkProps): InlineSpec =>
  match(props)
    .with(
      { entity: "ingredient" },
      { entity: "recipe" },
      { entity: "inventory" },
      { entity: "planting" },
      { entity: "gardenEntry" },
      { entity: "vendor" },
      { entity: "financialAccount" },
      { entity: "wish" },
      ({ data }) => ({ id: data.id, name: data.name }),
    )
    .with({ entity: "cookbook" }, ({ data }) => ({
      id: data.id,
      name: data.name,
      metadata: data.authors?.length ? data.authors.join(", ") : undefined,
    }))
    .with({ entity: "meal" }, ({ data }) => ({
      id: data.id,
      name: data.name,
      metadata: data.date ?? undefined,
    }))
    .with({ entity: "location" }, ({ data }) => ({
      id: data.id,
      name: data.name,
      metadata: data.type ?? undefined,
      mark: data.type ? (
        <LocationIcon
          type={data.type}
          product={data.product ?? null}
          size={12}
          colored
        />
      ) : undefined,
    }))
    .with({ entity: "product" }, ({ data }) => {
      const isMisc = isMiscProduct(data.name);
      return {
        id: data.id,
        name: isMisc ? getMiscDisplayName(data.name) : data.name,
        metadata: isMisc ? "misc" : data.manufacturer,
      };
    })
    .with({ entity: "usda-food" }, ({ data }) => {
      const dataType = data.foodInfo.data_type;
      return {
        // usda-food has no shortcode — fdc_id IS its public id.
        id: usdaRouteId(data.fdc_id),
        name: data.foodInfo.description || "Unnamed Food",
        // Tint the apple + trail a dot by data_type so the source quality reads
        // at a glance in dense lists (terracotta SR Legacy = richest, plum =
        // branded).
        mark: dataType ? (
          <EntityIcon
            entity="usda-food"
            size={12}
            style={{ color: dataTypeColor(dataType) }}
          />
        ) : undefined,
        trailing: dataType ? (
          <UsdaDataTypeDot dataType={dataType} />
        ) : undefined,
      };
    })
    .with({ entity: "project" }, ({ data }) => ({
      id: data.id,
      name: data.name,
      metadata: data.kind
        ? capitalize(data.kind)
        : data.status
          ? PROJECT_STATUS_LABELS[data.status]
          : undefined,
      mark: <ProjectMarkById projectId={data.id} icon={data.icon} size={12} />,
    }))
    .with({ entity: "task" }, ({ data }) => ({
      id: data.id,
      name: data.name,
      metadata: data.projectName ?? undefined,
    }))
    .with({ entity: "expense" }, ({ data }) => ({
      id: data.id,
      name: data.name,
      metadata:
        data.cost != null
          ? formatCurrency(data.cost)
          : (data.projectName ?? undefined),
    }))
    .with({ entity: "purchase" }, ({ data }) => ({
      id: data.id,
      name: purchaseLabel(data),
      // Only when the label is the order id — otherwise the fallback label
      // already leads with the vendor and this would print it twice.
      metadata: purchaseLabelUsedVendor(data)
        ? undefined
        : (data.vendorName ?? undefined),
    }))
    .with({ entity: "financialTransaction" }, ({ data }) => ({
      id: data.id,
      name: data.displayName,
    }))
    .with({ entity: "image" }, ({ data }) => ({
      id: data.id,
      name: data.filename,
    }))
    .exhaustive();

// Crisp entity link: a colored wayfinding icon + the name as a
// dotted-underlined text link, with optional muted metadata.
const linkClass =
  "group inline-flex max-w-full items-baseline gap-2 align-baseline text-foreground transition-colors hover:text-primary";

export function InlineRefLink(props: InlineRefLinkProps) {
  const {
    entity,
    displayImage,
    showIdentityMark,
    openInNewTab,
    className,
    compact,
    truncate,
  } = props;
  const { id, name, metadata, mark, trailing } = inlineSpec(props);

  return (
    <PreviewRefLink
      entity={entity}
      id={id}
      displayImage={displayImage}
      fallbackMark={mark ?? <EntityIcon entity={entity} size={12} colored />}
      showIdentityMark={showIdentityMark}
      openInNewTab={openInNewTab}
      className={cn(linkClass, truncate && "min-w-0", className)}
    >
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
    </PreviewRefLink>
  );
}
