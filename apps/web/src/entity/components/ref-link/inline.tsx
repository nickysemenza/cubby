import {
  fieldEnvelopeFor,
  fieldValueOf,
  type ReadableFieldEnvelope,
} from "@cubby/schemas/field-envelope";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import type { LocationType } from "@cubby/schemas/location";
import type {
  ProjectKind,
  ProjectStatus,
  TaskStatus,
} from "@cubby/schemas/project";
import { PROJECT_STATUS_LABELS } from "@cubby/schemas/project-fields";
import type { ProductCategory } from "@cubby/shared";
import { getMiscDisplayName, isMiscProduct, capitalize } from "@cubby/shared";
import type { DataType } from "@cubby/usda";
import { match } from "ts-pattern";
import { z } from "zod";

import { usdaRouteId } from "~/entity/entity-query";
import { formatCurrency } from "~/lib/number-format";
import { purchaseLabel, purchaseLabelUsedVendor } from "~/lib/purchase-label";

import { ChipRefLink } from "./leaf";

// Minimal data shape - just id and name
type MinimalEntityData = {
  id: string;
  name: string;
  emoji?: string | null;
  fields?: Record<string, ReadableFieldEnvelope>;
};

// Discriminated union for entity-specific data shapes
export type InlineRefLinkProps = {
  openInNewTab?: boolean;
  /** Optional sizing/layout classes applied to the actual anchor. */
  className?: string;
  /** Text only; primary table names select this centrally. */
  bare?: boolean;
  /** Muted context leading the metadata ("1 each" for a stocked location). */
  context?: string;
  /** Canonical backend-resolved cover; the shared context fills absent images. */
  displayImage?: ImageUrlSummary | null;
} & (
  | { entity: "ingredient"; data: MinimalEntityData }
  | {
      entity: "product";
      data: MinimalEntityData & { brandName?: string | null };
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
        product?: {
          category: ProductCategory | null;
          fields?: Record<string, ReadableFieldEnvelope>;
        } | null;
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
        emoji?: string | null;
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
    .with({ entity: "location" }, ({ data }) => {
      const type = fieldEnvelopeFor(data, "type");
      return {
        id: data.id,
        name: data.name,
        metadata: type
          ? (z.string().nullable().parse(fieldValueOf(type)) ?? undefined)
          : (data.type ?? undefined),
      };
    })
    .with({ entity: "product" }, ({ data }) => {
      const isMisc = isMiscProduct(data.name);
      const brand = fieldEnvelopeFor(data, "brandName");
      return {
        id: data.id,
        name: isMisc ? getMiscDisplayName(data.name) : data.name,
        metadata: isMisc
          ? "misc"
          : brand
            ? z.string().nullable().parse(fieldValueOf(brand))
            : data.brandName,
      };
    })
    .with({ entity: "usda-food" }, ({ data }) => {
      return {
        id: usdaRouteId(data.fdc_id),
        name: data.foodInfo.description || "Unnamed Food",
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

/** Entity-specific data supplies a name; the shared record link owns appearance. */
export function InlineRefLink(props: InlineRefLinkProps) {
  const { id, name, metadata } = inlineSpec(props);
  const emoji = z
    .object({ emoji: z.string().nullish() })
    .parse(props.data).emoji;
  return (
    <ChipRefLink
      entity={props.entity}
      id={id}
      name={name}
      displayImage={props.displayImage}
      emoji={emoji}
      bare={props.bare}
      className={props.className}
      openInNewTab={props.openInNewTab}
      context={[props.context, metadata].filter(Boolean).join(" · ")}
    />
  );
}
