import type {
  SearchDestination,
  SearchHit,
  SearchInventoryPlacement,
  SearchResultGroup,
} from "@cubby/schemas/search";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin";
import { type ReactNode, useCallback, useState } from "react";

import { entities } from "~/entity/entities";
import { enumFieldLabel } from "~/entity/enum-field-display";
import { tryFormatAmount } from "~/features/inventory/format-amount";
import { cn } from "~/lib/utils";

import {
  entityKindMap,
  getSearchMatchText,
  SearchResultMedia,
} from "./search-utils";

/**
 * One Product family as both the full search page and the command menu show
 * it: the parent's summary and its typed child rows. Each surface keeps its
 * own outer element (`Link` or `CommandItem`), parent row, and limits; the
 * wording, destinations, and keys come only from here.
 */
export type ProductSearchGroup = Extract<
  SearchResultGroup,
  { kind: "product" }
>;

interface ProductFamilyChild {
  /** Stable and unique within the family; also the command menu's item value. */
  key: string;
  /** Inventory children open the placement record, kit contents included. */
  destination: SearchDestination;
  /** Placements show a pin; kit contents and matched records their media. */
  media: SearchDestination | null;
  title: string;
  detail: string;
  /** The placement's shortcode; matched records already name theirs. */
  code: string | null;
  match: SearchHit | null;
}

const placementDetail = (placement: SearchInventoryPlacement) =>
  `${tryFormatAmount(placement.amount)} · ${enumFieldLabel("inventory", "placement", placement.placement)}`;

export const productFamilyHasChildren = (group: ProductSearchGroup) =>
  group.placements.length > 0 ||
  group.componentPlacements.length > 0 ||
  group.matchedActivity.length > 0;

const productFamilyRegionLabel = (group: ProductSearchGroup) =>
  `${group.primary.title} placements and matching records`;

/** Counts, kit presence, up to two distinct locations, and matched records. */
export function productFamilySummary(group: ProductSearchGroup) {
  const placements = group.placements.length;
  const componentPlacements = group.componentPlacements.length;
  const activity = group.matchedActivity.length;
  const locationPaths = [
    ...new Set([
      ...group.placements.map((placement) => placement.locationPath),
      ...group.componentPlacements.map(
        ({ placement }) => placement.locationPath,
      ),
    ]),
  ].slice(0, 2);
  const parts: string[] = [];
  if (placements > 0)
    parts.push(
      `${placements} ${componentPlacements > 0 ? "direct " : ""}${placements === 1 ? "placement" : "placements"}`,
    );
  else if (componentPlacements === 0) parts.push("0 placements");
  if (componentPlacements > 0) parts.push("Kit contents placed");
  // Paths join with commas: they already contain "›", and they are one fact
  // among the "·"-separated facts.
  if (locationPaths.length > 0) parts.push(locationPaths.join(", "));
  if (activity > 0)
    parts.push(`${activity} matching ${activity === 1 ? "record" : "records"}`);
  return parts.join(" · ");
}

/**
 * The family's children in display order. `limit` caps placements (direct
 * first, then kit contents) and matched records separately; `hiddenCount`
 * is what the cap left out. The full page passes no limit.
 */
export function productFamilyChildren(
  group: ProductSearchGroup,
  limit = Number.POSITIVE_INFINITY,
) {
  const placements = group.placements.slice(0, limit);
  const componentPlacements = group.componentPlacements.slice(
    0,
    Math.max(0, limit - placements.length),
  );
  const activity = group.matchedActivity.slice(0, limit);
  const children: ProductFamilyChild[] = [
    ...placements.map((placement) => ({
      key: `placement-${placement.id}`,
      destination: {
        id: placement.id,
        entityKind: "inventory" as const,
        title: group.primary.title,
        subtitle: placement.locationPath,
        typeHint: group.primary.typeHint,
        imageUrl: group.primary.imageUrl,
      },
      media: null,
      title: placement.locationPath,
      detail: placementDetail(placement),
      code: placement.id,
      match: null,
    })),
    ...componentPlacements.map(
      ({ component, componentQuantity, placement }) => ({
        key: `component-placement-${component.id}-${placement.id}`,
        destination: {
          ...component,
          id: placement.id,
          entityKind: "inventory" as const,
          subtitle: placement.locationPath,
        },
        media: component,
        title: component.title,
        detail: [
          componentQuantity > 1
            ? `${componentQuantity}× kit content`
            : "Kit content",
          placement.locationPath,
          placementDetail(placement),
        ].join(" · "),
        code: placement.id,
        match: null,
      }),
    ),
    ...activity.map((item) => ({
      key: `activity-${item.entityKind}-${item.id}`,
      destination: item,
      media: item,
      title: item.title,
      detail: `${entities[entityKindMap[item.entityKind]].label} · ${item.id} · Linked to ${group.primary.title}`,
      code: null,
      match: item,
    })),
  ];
  const shown =
    placements.length + componentPlacements.length + activity.length;
  const total =
    group.placements.length +
    group.componentPlacements.length +
    group.matchedActivity.length;
  return { children, hiddenCount: total - shown };
}

/** A child row's interior; the surface supplies the interactive element. */
export function ProductFamilyChildContent({
  child,
  showMatch = false,
}: {
  child: ProductFamilyChild;
  /** The wide search page explains why a matched record joined the family. */
  showMatch?: boolean;
}) {
  return (
    <>
      {child.media ? (
        <SearchResultMedia item={child.media} />
      ) : (
        <MapPinIcon className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">
          {child.title}
        </span>
        <span className="block truncate text-2xs text-muted-foreground">
          {child.detail}
        </span>
      </span>
      {child.code ? (
        <span className="font-mono text-2xs text-muted-foreground tabular-nums">
          {child.code}
        </span>
      ) : showMatch && child.match ? (
        <span className="max-w-36 truncate text-2xs text-muted-foreground">
          {getSearchMatchText(child.match)}
        </span>
      ) : null}
    </>
  );
}

export function ProductFamilyRegion({
  id,
  group,
  className,
  children,
}: {
  id: string;
  group: ProductSearchGroup;
  className?: string;
  children: ReactNode;
}) {
  return (
    <fieldset
      id={id}
      aria-label={productFamilyRegionLabel(group)}
      className={cn("border-border bg-muted/25 py-1", className)}
    >
      {children}
    </fieldset>
  );
}

/** Which families are open, by group key. `toggle(key, next)` forces a state. */
export function useExpandedFamilies() {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggle = useCallback(
    (key: string, next?: boolean) =>
      setExpanded((current) => {
        const updated = new Set(current);
        if (next ?? !updated.has(key)) updated.add(key);
        else updated.delete(key);
        return updated;
      }),
    [],
  );
  const collapseAll = useCallback(() => setExpanded(new Set()), []);
  return {
    isExpanded: (key: string) => expanded.has(key),
    toggle,
    collapseAll,
  };
}

export type ExpandedFamilies = ReturnType<typeof useExpandedFamilies>;

/** The pointer disclosure beside a family's parent row. */
export function ProductFamilyToggle({
  group,
  expanded,
  regionId,
  onToggle,
  className,
}: {
  group: ProductSearchGroup;
  expanded: boolean;
  regionId: string;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={`${expanded ? "Collapse" : "Expand"} ${productFamilyRegionLabel(group)}`}
      aria-expanded={expanded}
      aria-controls={regionId}
      onClick={onToggle}
      className={cn(
        "flex shrink-0 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary",
        className,
      )}
    >
      <CaretRightIcon
        className={cn(
          "size-4 transition-transform motion-reduce:transition-none",
          expanded && "rotate-90",
        )}
      />
    </button>
  );
}
