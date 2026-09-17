import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import type { LocationType } from "@cubby/schemas/location";
import React from "react";
import { useMemo } from "react";

import {
  entityDisplayImageKey,
  useEntityDisplayImageMap,
  useEntityDisplayImages,
} from "~/app/_components/entity-media/entity-display-images";
import { Stack } from "~/components/layout";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { NoneValue } from "~/components/ui/none-value";

import { EntityInlineLink } from "./EntityInlineLink";
import { TruncatedList } from "./TruncatedList";

// Base props shared across all entity types
type BaseProps = {
  /** Compact mode: truncates long names with max-width */
  compact?: boolean;
  /** Maximum items to show before truncating with "+N more". undefined = show all */
  maxItems?: number;
  /** Resolve missing images here. Table cells set this false because the table
   * owner already batches every visible row into one canonical request. */
  resolveImages?: boolean;
};

// Discriminated union for entity-specific list data
type EntityInlineLinkListProps = BaseProps &
  (
    | {
        entity: "ingredient";
        items?: { name: string; id: string }[];
      }
    | {
        entity: "product";
        items?: { name: string; id: string; manufacturer: string }[];
      }
    | {
        entity: "recipe";
        items?: { name: string; id: string }[];
      }
    | {
        entity: "location";
        items?: { name: string; id: string; type: LocationType | null }[];
      }
    | {
        entity: "usda-food";
        items?: { foodInfo: { description: string | null }; fdc_id: number }[];
      }
  );

type InlineLinkItem =
  | { name: string; id: string }
  | { name: string; id: string; manufacturer: string }
  | { name: string; id: string; type: LocationType | null }
  | { foodInfo: { description: string | null }; fdc_id: number };

function renderInlineLink(
  entity: "ingredient" | "recipe",
  item: { name: string; id: string },
  compact: boolean | undefined,
  displayImage: ImageUrlSummary | null,
): React.ReactElement;
function renderInlineLink(
  entity: "product",
  item: { name: string; id: string; manufacturer: string },
  compact: boolean | undefined,
  displayImage: ImageUrlSummary | null,
): React.ReactElement;
function renderInlineLink(
  entity: "location",
  item: { name: string; id: string; type: LocationType | null },
  compact: boolean | undefined,
  displayImage: ImageUrlSummary | null,
): React.ReactElement;
function renderInlineLink(
  entity: "usda-food",
  item: { foodInfo: { description: string | null }; fdc_id: number },
  compact: boolean | undefined,
  displayImage: null,
): React.ReactElement;
function renderInlineLink(
  entity: EntityInlineLinkListProps["entity"],
  item: InlineLinkItem,
  compact: boolean | undefined,
  displayImage: ImageUrlSummary | null,
) {
  if (entity === "usda-food" && "fdc_id" in item) {
    return (
      <EntityInlineLink
        displayImage={null}
        entity={entity}
        data={item}
        compact={compact}
      />
    );
  }
  if (entity === "location" && "type" in item) {
    return (
      <EntityInlineLink
        displayImage={displayImage}
        entity={entity}
        data={item}
        compact={compact}
      />
    );
  }
  if (entity === "product" && "manufacturer" in item) {
    return (
      <EntityInlineLink
        displayImage={displayImage}
        entity={entity}
        data={item}
        compact={compact}
      />
    );
  }
  if ((entity === "ingredient" || entity === "recipe") && "name" in item) {
    return (
      <EntityInlineLink
        displayImage={displayImage}
        entity={entity}
        data={item}
        compact={compact}
      />
    );
  }
  throw new Error(`Unexpected ${entity} inline-link item shape`);
}

export const EntityInlineLinkList: React.FC<EntityInlineLinkListProps> = (
  props,
) => {
  const { items, compact, maxItems, resolveImages = true } = props;
  const inheritedImages = useEntityDisplayImageMap();

  const refs = useMemo(
    () =>
      props.entity === "usda-food"
        ? []
        : (items ?? []).flatMap((item) =>
            "id" in item
              ? [{ entityType: props.entity, entityId: item.id }]
              : [],
          ),
    [items, props.entity],
  );
  const images = useEntityDisplayImages(
    resolveImages ? refs : [],
    inheritedImages,
  );

  if (!items || items.length === 0) {
    if (compact) {
      return <NoneValue />;
    }
    return (
      <Empty variant="minimal" className="py-2">
        <EmptyTitle className="text-sm">None</EmptyTitle>
        <EmptyDescription className="text-xs">
          No items linked yet
        </EmptyDescription>
      </Empty>
    );
  }

  const getKey = (item: (typeof items)[number], index: number) => {
    if ("id" in item) return item.id;
    if ("fdc_id" in item) return item.fdc_id;
    return index;
  };

  // Dispatch on the DECLARED entity, with the shape check only as a guard.
  // Inferring the entity from shape is wrong here: a product row carries an
  // `fdc_id` key whenever it is USDA-linked, so shape-first dispatch rendered
  // every linked product on a USDA food page through the usda-food branch
  // (which reads `foodInfo`) and crashed the page.
  const renderItem = (item: (typeof items)[number], index: number) => {
    let link: React.ReactElement;
    if (props.entity === "usda-food" && "fdc_id" in item)
      link = renderInlineLink("usda-food", item, compact, null);
    else if (props.entity === "location" && "type" in item)
      link = renderInlineLink(
        "location",
        item,
        compact,
        images[
          entityDisplayImageKey({ entityType: "location", entityId: item.id })
        ] ?? null,
      );
    else if (props.entity === "product" && "manufacturer" in item)
      link = renderInlineLink(
        "product",
        item,
        compact,
        images[
          entityDisplayImageKey({ entityType: "product", entityId: item.id })
        ] ?? null,
      );
    else if (
      (props.entity === "ingredient" || props.entity === "recipe") &&
      "name" in item
    )
      link = renderInlineLink(
        props.entity,
        item,
        compact,
        images[
          entityDisplayImageKey({ entityType: props.entity, entityId: item.id })
        ] ?? null,
      );
    else throw new Error(`Unexpected ${props.entity} inline-link item shape`);
    return React.cloneElement(link, { key: getKey(item, index) });
  };

  // When maxItems is set, use TruncatedList for horizontal truncation
  if (maxItems !== undefined) {
    return (
      <TruncatedList
        items={items}
        maxItems={maxItems}
        renderItem={renderItem}
        gap="gap-1"
      />
    );
  }

  // Default: show all items vertically (for detail pages)
  return (
    <Stack gap="xs">
      {items.map((item, index) => (
        <div key={getKey(item, index)}>{renderItem(item, index)}</div>
      ))}
    </Stack>
  );
};
