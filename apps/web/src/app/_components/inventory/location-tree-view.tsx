import type {
  InfLocation,
  InventoryItemForTree,
} from "@cubby/schemas/location";
import { ArrowsInLineVerticalIcon as ChevronsDownUp } from "@phosphor-icons/react/dist/csr/ArrowsInLineVertical";
import { CaretRightIcon as ChevronRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CaretUpDownIcon as ChevronsUpDown } from "@phosphor-icons/react/dist/csr/CaretUpDown";
import { MagnifyingGlassIcon as Search } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import { Link } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";

import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { EntityIcon } from "~/entities/entities";
import { useLocationTree } from "~/hooks/useLocationTree";
import { cn } from "~/lib/utils";

import { LocationVisual } from "../locations/location-visual";

interface LocationTreeProps {
  data: InfLocation[];
}

interface VisibleLocation {
  location: InfLocation;
  children: VisibleLocation[];
  inventoryItems: InventoryItemForTree[];
}

interface TreeMeta {
  branchIds: Set<string>;
  directCounts: Map<string, number>;
  totalCounts: Map<string, number>;
  locationCount: number;
  inventoryCount: number;
}

function buildTreeMeta(locations: InfLocation[]): TreeMeta {
  const branchIds = new Set<string>();
  const directCounts = new Map<string, number>();
  const totalCounts = new Map<string, number>();
  let locationCount = 0;
  let inventoryCount = 0;

  function visit(location: InfLocation): number {
    locationCount += 1;
    const children = location.children ?? [];
    const items = location.inventoryItems ?? [];
    inventoryCount += items.length;
    if (children.length > 0 || items.length > 0) branchIds.add(location.id);

    const direct = location.directItemCount ?? items.length;
    const descendants = children.reduce(
      (total, child) => total + visit(child),
      0,
    );
    const total = location.totalItemCount ?? direct + descendants;
    directCounts.set(location.id, direct);
    totalCounts.set(location.id, total);
    return total;
  }

  for (const location of locations) visit(location);
  return {
    branchIds,
    directCounts,
    totalCounts,
    locationCount,
    inventoryCount,
  };
}

function visibleSubtree(
  location: InfLocation,
  includeInventory: boolean,
): VisibleLocation {
  return {
    location,
    children: (location.children ?? []).map((child) =>
      visibleSubtree(child, includeInventory),
    ),
    inventoryItems: includeInventory ? (location.inventoryItems ?? []) : [],
  };
}

function filterLocation(
  location: InfLocation,
  query: string,
  includeInventory: boolean,
): VisibleLocation | null {
  if (location.name.toLocaleLowerCase().includes(query)) {
    // A direct location match reveals the whole branch. A descendant-only
    // match below keeps just its lineage, so search is useful both for finding
    // a named area and for locating one deeply nested record.
    return visibleSubtree(location, includeInventory);
  }

  const children = (location.children ?? [])
    .map((child) => filterLocation(child, query, includeInventory))
    .filter((child): child is VisibleLocation => child !== null);
  const inventoryItems = includeInventory
    ? (location.inventoryItems ?? []).filter((item) =>
        item.productName.toLocaleLowerCase().includes(query),
      )
    : [];

  if (children.length === 0 && inventoryItems.length === 0) return null;
  return { location, children, inventoryItems };
}

function visibleTree(
  locations: InfLocation[],
  rawQuery: string,
  includeInventory: boolean,
): VisibleLocation[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) {
    return locations.map((location) =>
      visibleSubtree(location, includeInventory),
    );
  }
  return locations
    .map((location) => filterLocation(location, query, includeInventory))
    .filter((location): location is VisibleLocation => location !== null);
}

function visibleLocationCount(locations: VisibleLocation[]): number {
  return locations.reduce(
    (total, node) => total + 1 + visibleLocationCount(node.children),
    0,
  );
}

export function LocationTree({ data }: LocationTreeProps) {
  const treeId = useId();
  const showInventoryId = useId();
  const [showInventory, setShowInventory] = useState(false);
  const [query, setQuery] = useState("");
  // Absence means expanded, so branches added by a live query refresh inherit
  // the promised all-open default without an effect that resets user choices.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const meta = useMemo(() => buildTreeMeta(data), [data]);
  const nodes = useMemo(
    () => visibleTree(data, query, showInventory),
    [data, query, showInventory],
  );
  const isSearching = query.trim().length > 0;
  const shownLocationCount = useMemo(
    () => visibleLocationCount(nodes),
    [nodes],
  );

  const toggleBranch = (id: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Stack gap="sm" className="min-w-0">
      <div className="border-y border-[var(--border)] bg-card">
        <Row
          align="center"
          wrap
          gap="sm"
          className="border-b border-[var(--border)] p-2"
        >
          <div className="relative min-w-48 flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={
                showInventory
                  ? "Find a location or inventory item"
                  : "Find a location"
              }
              placeholder={
                showInventory ? "Find a location or item" : "Find a location"
              }
              className="pr-6 pl-6"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear tree search"
                className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground transition-colors duration-100 ease-cozy hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <Label
            htmlFor={showInventoryId}
            className="min-h-10 cursor-pointer px-1 sm:min-h-7"
          >
            <Checkbox
              id={showInventoryId}
              checked={showInventory}
              onCheckedChange={(checked) => setShowInventory(checked === true)}
            />
            Show inventory
          </Label>

          <Row align="center" gap="tight" className="max-sm:w-full">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isSearching}
              onClick={() => setCollapsedIds(new Set())}
              className="max-sm:h-10 max-sm:flex-1"
            >
              <ChevronsUpDown />
              Expand all
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isSearching}
              onClick={() => setCollapsedIds(new Set(meta.branchIds))}
              className="max-sm:h-10 max-sm:flex-1"
            >
              <ChevronsDownUp />
              Collapse all
            </Button>
          </Row>
        </Row>

        <Row
          align="center"
          justify="between"
          gap="sm"
          className="min-h-7 border-b border-[var(--border)] bg-muted/30 px-2 py-1 font-mono text-2xs tracking-wider text-slate uppercase"
          aria-live="polite"
        >
          <span>
            {isSearching
              ? `${shownLocationCount} of ${meta.locationCount} locations`
              : `${meta.locationCount} location${meta.locationCount === 1 ? "" : "s"}`}
          </span>
          {showInventory && (
            <span>
              {meta.inventoryCount} inventory{" "}
              {meta.inventoryCount === 1 ? "entry" : "entries"}
            </span>
          )}
        </Row>

        {nodes.length > 0 ? (
          <ul aria-label="Household locations" className="min-w-0">
            {nodes.map((node) => (
              <LocationBranch
                key={node.location.id}
                node={node}
                treeId={treeId}
                searching={isSearching}
                collapsedIds={collapsedIds}
                directCounts={meta.directCounts}
                totalCounts={meta.totalCounts}
                onToggle={toggleBranch}
              />
            ))}
          </ul>
        ) : (
          <div className="px-4 py-8 text-center">
            <p className="text-sm font-medium">
              {isSearching ? "No matching locations" : "No locations yet"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {isSearching
                ? "Try a shorter name or clear the search to see the whole house."
                : "Locations will appear here once the household tree has been created."}
            </p>
          </div>
        )}
      </div>
    </Stack>
  );
}

interface LocationBranchProps {
  node: VisibleLocation;
  treeId: string;
  searching: boolean;
  collapsedIds: Set<string>;
  directCounts: Map<string, number>;
  totalCounts: Map<string, number>;
  onToggle: (id: string) => void;
}

function LocationBranch({
  node,
  treeId,
  searching,
  collapsedIds,
  directCounts,
  totalCounts,
  onToggle,
}: LocationBranchProps) {
  const { location } = node;
  const hasVisibleChildren =
    node.children.length > 0 || node.inventoryItems.length > 0;
  const expanded = searching || !collapsedIds.has(location.id);
  const groupId = `${treeId}-${location.id}-contents`;
  const directCount = directCounts.get(location.id) ?? 0;
  const totalCount = totalCounts.get(location.id) ?? directCount;

  return (
    <li className="min-w-0">
      <Row
        align="center"
        gap="xs"
        className="group min-h-10 min-w-0 border-b border-[var(--border)] px-2 py-1 transition-colors duration-100 ease-cozy hover:bg-muted/40 sm:min-h-7"
      >
        {hasVisibleChildren ? (
          <button
            type="button"
            disabled={searching}
            onClick={() => onToggle(location.id)}
            aria-expanded={expanded}
            aria-controls={groupId}
            aria-label={
              searching
                ? `${location.name} is expanded for search`
                : `${expanded ? "Collapse" : "Expand"} ${location.name}`
            }
            className="flex size-10 shrink-0 items-center justify-center text-muted-foreground transition-colors duration-100 ease-cozy hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary disabled:text-muted-foreground/60 sm:size-5"
          >
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform duration-100 ease-cozy motion-reduce:transition-none",
                expanded && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span aria-hidden className="size-10 shrink-0 sm:size-5" />
        )}

        <Link
          to="/locations/$shortcode"
          params={{ shortcode: location.id }}
          aria-label={location.name}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 py-1 text-sm font-medium text-foreground underline-offset-2 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:min-h-0 sm:text-xs"
          title={location.name}
        >
          <LocationVisual
            location={location}
            variant="compact"
            size={24}
            className="transition-colors duration-100 ease-cozy group-hover:border-foreground/30"
          />
          <span className="truncate">{location.name}</span>
        </Link>

        <Row align="center" gap="tight" className="ml-auto shrink-0">
          {directCount > 0 && (
            <Badge
              variant="secondary"
              aria-label={`${directCount} ${directCount === 1 ? "item" : "items"} here`}
            >
              {directCount} here
            </Badge>
          )}
          {totalCount > directCount && (
            <Badge
              variant="outline"
              aria-label={`${totalCount} ${totalCount === 1 ? "item" : "items"} total`}
            >
              {totalCount} total
            </Badge>
          )}
        </Row>
      </Row>

      {hasVisibleChildren && (
        <ul
          id={groupId}
          hidden={!expanded}
          className="ml-2 min-w-0 border-l border-[var(--border)] pl-2 sm:ml-4 sm:pl-4"
        >
          {node.inventoryItems.map((item) => (
            <InventoryRow key={item.id} item={item} />
          ))}
          {node.children.map((child) => (
            <LocationBranch
              key={child.location.id}
              node={child}
              treeId={treeId}
              searching={searching}
              collapsedIds={collapsedIds}
              directCounts={directCounts}
              totalCounts={totalCounts}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function InventoryRow({ item }: { item: InventoryItemForTree }) {
  return (
    <li className="min-w-0">
      <Row
        align="center"
        gap="sm"
        className="min-h-10 min-w-0 border-b border-dashed border-[var(--border)] px-2 py-1 text-muted-foreground transition-colors duration-100 ease-cozy hover:bg-muted/30 hover:text-foreground sm:min-h-7"
      >
        <span aria-hidden className="size-10 shrink-0 sm:size-5" />
        <EntityIcon entity="inventory" size={14} className="shrink-0" />
        <Link
          to="/inventory/$shortcode"
          params={{ shortcode: item.id }}
          className="flex min-h-10 min-w-0 flex-1 items-center truncate text-sm underline-offset-2 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:min-h-0 sm:text-xs"
          title={item.productName}
        >
          {item.productName}
        </Link>
        <span className="shrink-0 font-mono text-2xs text-slate uppercase tabular-nums">
          {item.amount.value} {item.amount.unit}
        </span>
      </Row>
    </li>
  );
}

const LocationTreeView = () => {
  const locations = useLocationTree();

  if (!locations.data) return null;

  return <LocationTree data={locations.data} />;
};

export default LocationTreeView;
