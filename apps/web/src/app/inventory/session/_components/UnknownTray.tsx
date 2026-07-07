import type { InfLocation } from "@cubby/schemas/location";
import { ArrowDownToLine, FolderInput, Search } from "lucide-react";
import { useState } from "react";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
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

  return (
    <Card size="sm">
      <CardHeader>
        <Row align="center" justify="between">
          <CardTitle>Unknown</CardTitle>
          <Badge variant="outline">{totalUnknownCount}</Badge>
        </Row>
      </CardHeader>
      <CardContent>
        <Stack gap="sm">
          <label className="flex min-h-12 items-center gap-2 border border-[var(--border)] px-4">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
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
                    "border-l-primary/60 bg-primary/5",
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
                      <ArrowDownToLine className="h-4 w-4" />
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
                    "border-l-warning/60 bg-background",
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
                        <FolderInput className="h-4 w-4" />
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
                        <ArrowDownToLine className="h-4 w-4" />
                      </Button>
                    </Row>
                  }
                />
              ))}
            </Stack>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
