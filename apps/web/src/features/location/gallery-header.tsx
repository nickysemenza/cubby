import { type LocationType, locationType } from "@cubby/schemas/location";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";

import { Picker } from "~/entity/picker/picker";
import { locationTypeOptionsWithTheme } from "~/entity/presentation/location-icons";
import { Row } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";

export type EmptyFilter = "all" | "withItems" | "empty";

const TYPE_OPTIONS = [
  { value: "all", label: "All types" },
  ...locationTypeOptionsWithTheme,
];
const STATUS_OPTIONS = [
  { value: "all", label: "All contents" },
  { value: "withItems", label: "With items" },
  { value: "empty", label: "Empty" },
];

export function GalleryHeader({
  query,
  onQueryChange,
  type,
  onTypeChange,
  status,
  onStatusChange,
  onClear,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  type: LocationType | null;
  onTypeChange: (type: LocationType | null) => void;
  status: EmptyFilter;
  onStatusChange: (status: EmptyFilter) => void;
  onClear: () => void;
}) {
  const filtered = Boolean(query || type || status !== "all");
  return (
    <>
      <Row align="center" gap="sm" wrap className="border-b border-border py-1">
        <div className="relative min-w-40 flex-1">
          <MagnifyingGlassIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Find a location or item"
            placeholder="Find a location or item"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            className="pl-7"
          />
        </div>
        <Picker
          mode="choose"
          label="Location type"
          options={TYPE_OPTIONS}
          value={type ?? "all"}
          onValueChange={(value) =>
            onTypeChange(
              value === "all"
                ? null
                : (locationType.safeParse(value).data ?? null),
            )
          }
          className="w-32"
        />
        <Picker
          mode="choose"
          label="Location status"
          options={STATUS_OPTIONS}
          value={status}
          onValueChange={(value) =>
            onStatusChange(
              value === "withItems" || value === "empty" ? value : "all",
            )
          }
          className="w-40"
        />
        {filtered && (
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear filters
          </Button>
        )}
      </Row>
    </>
  );
}
