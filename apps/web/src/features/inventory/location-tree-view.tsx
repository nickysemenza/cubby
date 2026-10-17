import type { InfLocation } from "@cubby/schemas/location";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useId, useMemo, useState } from "react";

import { useLocationTree } from "~/entity/hooks/use-location-tree";
import {
  filterLocationTree,
  indexLocations,
} from "~/features/location/location-browser-model";
import { LocationOutline } from "~/features/location/location-outline";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Row } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import { Input } from "~/ui/primitives/input";
import { Label } from "~/ui/primitives/label";
import {
  Visualization,
  visualizationState,
} from "~/ui/visualizations/visualization";

export function LocationTree({ data }: { data: InfLocation[] }) {
  const inventoryId = useId();
  const [query, setQuery] = useState("");
  const [showInventory, setShowInventory] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => indexLocations(data).initiallyExpanded,
  );
  const [openContents, setOpenContents] = useState<Set<string>>(
    () => new Set(),
  );
  const index = useMemo(() => indexLocations(data), [data]);
  const filtered = useMemo(
    () => filterLocationTree(data, { query, includeInventory: showInventory }),
    [data, query, showInventory],
  );
  const searchIndex = useMemo(
    () => indexLocations(filtered.locations),
    [filtered.locations],
  );
  const searching = Boolean(query.trim());
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleContents = (id: string) => {
    setOpenContents((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setExpanded((current) => new Set([...current, id]));
  };

  return (
    <div className="min-w-0 border-y border-border">
      <Row align="center" gap="sm" wrap className="border-b border-border py-1">
        <div className="relative min-w-40 flex-1">
          <MagnifyingGlassIcon
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
            className="pr-8 pl-7"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear tree search"
              className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground"
            >
              <XIcon aria-hidden className="size-3.5" />
            </button>
          )}
        </div>
        <Label
          htmlFor={inventoryId}
          className="min-h-11 cursor-pointer sm:min-h-7"
        >
          <Checkbox
            id={inventoryId}
            checked={showInventory}
            onCheckedChange={(checked) => setShowInventory(checked === true)}
          />
          Show inventory
        </Label>
        <Button
          variant="ghost"
          size="sm"
          disabled={searching}
          onClick={() => setExpanded(new Set(index.branchIds))}
        >
          Expand all
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={searching}
          onClick={() => setExpanded(new Set())}
        >
          Collapse all
        </Button>
        <span
          aria-live="polite"
          className="pr-2 text-2xs text-muted-foreground tabular-nums"
        >
          {searching ? `${searchIndex.byId.size} of ` : ""}
          {index.byId.size} locations
        </span>
      </Row>
      {filtered.locations.length ? (
        <LocationOutline
          locations={filtered.locations}
          expandedIds={searching ? searchIndex.branchIds : expanded}
          onToggle={toggle}
          query={query}
          showInventory={showInventory}
          openContents={openContents}
          onToggleContents={toggleContents}
          label="Household locations"
        />
      ) : (
        <div className="px-2 py-6 text-center text-xs text-muted-foreground">
          <p className="font-medium text-foreground">
            {searching ? "No matching locations" : "No locations yet"}
          </p>
          <p className="mt-1">
            {searching
              ? "Try a shorter name or clear the search."
              : "Create a location to start the household tree."}
          </p>
        </div>
      )}
    </div>
  );
}

const LocationTreeView = () => {
  const hydrated = useHydrated();
  const locations = useLocationTree();
  const state = visualizationState({
    data: locations.data,
    isLoading: locations.isLoading,
    error: hydrated ? locations.error : null,
    empty: locations.data?.length === 0,
    onRetry: () => void locations.refetch(),
  });
  return (
    <Visualization
      state={state}
      title="Tree View"
      message="No locations to display."
    >
      {locations.data && <LocationTree data={locations.data} />}
    </Visualization>
  );
};
export default LocationTreeView;
