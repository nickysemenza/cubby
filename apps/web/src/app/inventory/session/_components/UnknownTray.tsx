import type { InfLocation } from "@cubby/schemas/location";
import { ArrowDownToLine, Search } from "lucide-react";
import { useState } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Image } from "~/components/ui/image";
import { cn } from "~/lib/utils";
import type { InventoryItem } from "./types";

export function UnknownTray({
  items,
  locations,
  currentLocationName,
  onMoveIn,
  onMoveLocationIn,
  disabled,
}: {
  items: InventoryItem[];
  locations: InfLocation[];
  currentLocationName: string;
  onMoveIn: (item: InventoryItem) => void;
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
                <div
                  key={location.id}
                  className={cn(
                    "border border-[var(--border)] border-l-4 border-l-primary/60 bg-primary/5 p-2",
                    disabled && "opacity-50",
                  )}
                >
                  <Row align="baseline" gap="xs" wrap>
                    <EntityInlineLink
                      entity="location"
                      data={{
                        id: location.id,
                        name: location.name,
                        type: location.type,
                      }}
                    />
                  </Row>
                  <Row
                    align="center"
                    justify="between"
                    gap="sm"
                    className="mt-2"
                  >
                    <Row align="center" gap="sm" className="min-w-0">
                      <div className="flex h-16 w-16 shrink-0 items-center justify-center border border-primary/30 bg-primary/10 text-primary">
                        {location.images[0]?.url ? (
                          <Image
                            src={location.images[0].url}
                            alt={location.name}
                            displayWidth={128}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <LocationIcon type={location.type} size={26} />
                        )}
                      </div>
                      <Description size="xs" className="truncate">
                        {location.children?.length ?? 0} loc ·{" "}
                        {location.totalItemCount ?? 0}{" "}
                        {(location.totalItemCount ?? 0) === 1
                          ? "item"
                          : "items"}
                      </Description>
                    </Row>
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
                  </Row>
                </div>
              ))}
              {filtered.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "border border-[var(--border)] border-l-4 border-l-warning/60 bg-background p-2",
                    disabled && "opacity-50",
                  )}
                >
                  <Row align="baseline" gap="xs" wrap>
                    <EntityInlineLink entity="product" data={item.product} />
                  </Row>
                  <Row
                    align="center"
                    justify="between"
                    gap="sm"
                    className="mt-2"
                  >
                    <Row align="center" gap="sm" className="min-w-0">
                      <Image
                        src={item.product.images[0]?.url}
                        alt={item.product.name}
                        displayWidth={128}
                        className="h-16 w-16 shrink-0 border border-[var(--border)] object-cover"
                      />
                      <Description size="xs" className="truncate">
                        {tryFormatAmount(item.amount)}
                      </Description>
                    </Row>
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
                </div>
              ))}
            </Stack>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
