import type { InfLocation } from "@cubby/schemas/location";
import { ArrowLineDownIcon } from "@phosphor-icons/react/dist/csr/ArrowLineDown";
import { FolderSimplePlusIcon } from "@phosphor-icons/react/dist/csr/FolderSimplePlus";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { useState } from "react";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { cn } from "~/lib/utils";

import { ItemReviewCard, LocationReviewCard } from "./review-rows";
import type { InventoryItem } from "./types";

export function UnknownTray({
  items,
  locations,
  inventoryByLocation,
  currentLocationName,
  onMoveIn,
  onMoveTo,
  onMoveLocationIn,
  disabled,
}: {
  items: InventoryItem[];
  locations: InfLocation[];
  inventoryByLocation: Map<string, InventoryItem[]>;
  currentLocationName: string;
  onMoveIn: (item: InventoryItem) => void;
  onMoveTo: (item: InventoryItem) => void;
  onMoveLocationIn: (location: InfLocation) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const filtered = items.filter((item) =>
    item.product.name.toLowerCase().includes(query.toLowerCase()),
  );
  const filteredLocations = locations.filter((location) =>
    location.name.toLowerCase().includes(query.toLowerCase()),
  );
  const totalUnknownCount = items.length + locations.length;

  if (totalUnknownCount === 0) {
    return <Description>Unknown is empty.</Description>;
  }

  return (
    <Stack gap="sm">
      <label className="flex min-h-12 items-center gap-2 border border-[var(--border)] px-4">
        <MagnifyingGlassIcon className="size-4 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search unknown contents"
          placeholder="Search unknown"
          className="min-w-0 flex-1 bg-transparent outline-none"
        />
      </label>
      {filtered.length === 0 && filteredLocations.length === 0 ? (
        <Description>No Unknown contents match.</Description>
      ) : (
        <Stack gap="sm" className="max-h-80 overflow-auto">
          {filteredLocations.map((location) => (
            <LocationReviewCard
              key={location.id}
              location={location}
              previewItems={inventoryByLocation.get(location.id) ?? []}
              className={cn(
                "border-primary/40 bg-primary/5",
                disabled && "opacity-50",
              )}
              actions={
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 w-10 shrink-0"
                  disabled={disabled}
                  title={`Move into ${currentLocationName}`}
                  aria-label={`Move into ${currentLocationName}`}
                  onClick={() => onMoveLocationIn(location)}
                >
                  <ArrowLineDownIcon className="size-4" />
                </Button>
              }
            />
          ))}
          {filtered.map((item) => (
            <ItemReviewCard
              key={item.id}
              product={item.product}
              amount={item.amount}
              className={cn(
                "border-warning/40 bg-background",
                disabled && "opacity-50",
              )}
              controls={
                <Row gap="xs" className="shrink-0 justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-10 shrink-0"
                    disabled={disabled}
                    title="Move to another location"
                    aria-label="Move to another location"
                    onClick={() => onMoveTo(item)}
                  >
                    <FolderSimplePlusIcon className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-10 shrink-0"
                    disabled={disabled}
                    title={`Move into ${currentLocationName}`}
                    aria-label={`Move into ${currentLocationName}`}
                    onClick={() => onMoveIn(item)}
                  >
                    <ArrowLineDownIcon className="size-4" />
                  </Button>
                </Row>
              }
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
