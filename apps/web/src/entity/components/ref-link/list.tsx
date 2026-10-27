import { useMemo } from "react";

import {
  entityDisplayImageKey,
  useEntityDisplayImageMap,
  useEntityDisplayImages,
} from "~/entity/entity-media/entity-display-images";
import { EmptyState } from "~/ui/feedback/empty-state";
import { Stack } from "~/ui/layout";
import { NoneValue } from "~/ui/primitives/none-value";
import { TruncatedList } from "~/ui/truncated-list";

import type { InlineRefLinkProps } from "./inline";
import { InlineRefLink } from "./inline";

type ListRefLinkProps = {
  /** Compact mode: truncates long names with max-width */
  compact?: boolean;
  /** Maximum items to show before truncating with "+N more". undefined = show all */
  maxItems?: number;
  /** Resolve missing images here. Table cells set this false because the table
   * owner already batches every visible row into one canonical request. */
  resolveImages?: boolean;
} & (
  | { entity: "ingredient"; items?: { name: string; id: string }[] }
  | {
      entity: "product";
      items?: Extract<InlineRefLinkProps, { entity: "product" }>["data"][];
    }
  | { entity: "recipe"; items?: { name: string; id: string }[] }
  | {
      entity: "location";
      items?: Extract<InlineRefLinkProps, { entity: "location" }>["data"][];
    }
  | {
      entity: "usda-food";
      items?: { foodInfo: { description: string | null }; fdc_id: number }[];
    }
);

export function ListRefLink(props: ListRefLinkProps) {
  const { items, compact, maxItems, resolveImages = true } = props;
  const inheritedImages = useEntityDisplayImageMap();

  const refs = useMemo(
    () =>
      props.entity === "usda-food"
        ? []
        : (items ?? []).flatMap((item) =>
            "id" in item
              ? [{ entityKind: props.entity, entityId: item.id }]
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
    return <EmptyState size="inline">No items linked yet.</EmptyState>;
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
    const key = getKey(item, index);
    const imageOf = (
      entityKind: "location" | "product" | "ingredient" | "recipe",
      id: string,
    ) => images[entityDisplayImageKey({ entityKind, entityId: id })] ?? null;
    if (props.entity === "usda-food" && "fdc_id" in item)
      return (
        <InlineRefLink
          key={key}
          entity="usda-food"
          data={item}
          displayImage={null}
        />
      );
    if (props.entity === "location" && "name" in item)
      return (
        <InlineRefLink
          key={key}
          entity="location"
          data={item}
          displayImage={imageOf("location", item.id)}
        />
      );
    if (props.entity === "product" && "name" in item)
      return (
        <InlineRefLink
          key={key}
          entity="product"
          data={item}
          displayImage={imageOf("product", item.id)}
        />
      );
    if (
      (props.entity === "ingredient" || props.entity === "recipe") &&
      "name" in item
    )
      return (
        <InlineRefLink
          key={key}
          entity={props.entity}
          data={item}
          displayImage={imageOf(props.entity, item.id)}
        />
      );
    throw new Error(`Unexpected ${props.entity} inline-link item shape`);
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
}
