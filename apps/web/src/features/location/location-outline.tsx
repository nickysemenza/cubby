import type {
  InfLocation,
  InventoryItemForTree,
} from "@cubby/schemas/location";
import { Link } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";

import { EntityIcon } from "~/entity/entities";
import { LocationIcon } from "~/entity/presentation/location-icons";
import { TreeOutline, type OutlineNode } from "~/ui/common/tree-outline";

import { LocationVisual } from "./location-visual";

type LocationOutlineData =
  | { kind: "location"; location: InfLocation }
  | { kind: "inventory"; item: InventoryItemForTree };

const NO_CONTENTS = new Set<string>();

function locationAction(
  node: OutlineNode<LocationOutlineData>,
  name: ReactNode,
) {
  return node.data.kind === "location" ? (
    <Link
      data-tree-action
      tabIndex={-1}
      to="/locations/$shortcode"
      params={{ shortcode: node.id }}
      aria-label={node.name}
      title={node.name}
      className="hover:underline"
    >
      <span className="truncate">{name}</span>
    </Link>
  ) : (
    <Link
      data-tree-action
      tabIndex={-1}
      to="/inventory/$shortcode"
      params={{ shortcode: node.id }}
      aria-label={node.name}
      title={node.name}
      className="text-muted-foreground hover:underline"
    >
      <span className="truncate">{name}</span>
    </Link>
  );
}

function locationMark(node: OutlineNode<LocationOutlineData>) {
  if (node.data.kind === "inventory")
    return (
      <EntityIcon
        entity="inventory"
        size={14}
        className="shrink-0 text-muted-foreground"
      />
    );
  const { location } = node.data;
  return location.images.length > 0 || location.product?.coverImage ? (
    <LocationVisual
      location={location}
      variant="compact"
      size={16}
      showChildCount={false}
    />
  ) : (
    <LocationIcon
      type={location.type}
      product={location.product}
      size={14}
      className="shrink-0 text-muted-foreground"
    />
  );
}

/** Locations supply identity and contents; TreeOutline owns the interaction. */
export function LocationOutline({
  locations,
  expandedIds,
  onToggle,
  selectedId,
  onSelect,
  query = "",
  showInventory = false,
  openContents = NO_CONTENTS,
  onToggleContents,
  label = "Locations",
  revealMatches = false,
}: {
  locations: InfLocation[];
  expandedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  selectedId?: string;
  onSelect?: (id: string) => void;
  query?: string;
  showInventory?: boolean;
  openContents?: ReadonlySet<string>;
  onToggleContents?: (id: string) => void;
  label?: string;
  revealMatches?: boolean;
}) {
  const searching = Boolean(query.trim());
  const nodes = useMemo(() => {
    const visit = (
      location: InfLocation,
    ): OutlineNode<LocationOutlineData> => ({
      id: location.id,
      name: location.name,
      data: { kind: "location", location },
      children: [
        ...(location.children ?? []).map(visit),
        ...(showInventory && (searching || openContents.has(location.id))
          ? (location.inventoryItems ?? []).map(
              (item): OutlineNode<LocationOutlineData> => ({
                id: item.id,
                name: item.productName,
                data: { kind: "inventory", item },
              }),
            )
          : []),
      ],
    });
    return locations.map(visit);
  }, [locations, openContents, searching, showInventory]);

  return (
    <TreeOutline
      nodes={nodes}
      label={label}
      expandedIds={expandedIds}
      onToggle={onToggle}
      selectedId={selectedId}
      onSelect={onSelect}
      query={query}
      locked={searching || revealMatches}
      renderIcon={locationMark}
      renderAction={onSelect ? undefined : locationAction}
      renderTrailing={(node) => {
        if (node.data.kind === "inventory")
          return (
            <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
              {node.data.item.amount.value} {node.data.item.amount.unit}
            </span>
          );
        const { location } = node.data;
        const direct =
          location.directItemCount ?? location.inventoryItems?.length ?? 0;
        const total = location.totalItemCount ?? direct;
        return (
          <span className="flex shrink-0 items-center gap-2 text-2xs text-muted-foreground tabular-nums">
            {total > 0 && (
              <span
                aria-label={`${direct} ${direct === 1 ? "item" : "items"} here, ${total} total`}
                title={`${direct} here · ${total} including descendants`}
              >
                {total}
              </span>
            )}
            {showInventory &&
              !searching &&
              (location.inventoryItems?.length ?? 0) > 0 &&
              onToggleContents && (
                <button
                  type="button"
                  aria-expanded={openContents.has(location.id)}
                  aria-label={`${openContents.has(location.id) ? "Hide" : "Show"} contents in ${location.name}`}
                  onClick={() => onToggleContents(location.id)}
                  onKeyDown={(event) => event.stopPropagation()}
                  className="min-h-11 px-1 underline underline-offset-2 sm:min-h-7 [@media(pointer:coarse)]:min-h-11"
                >
                  Contents
                </button>
              )}
          </span>
        );
      }}
    />
  );
}
