import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { LocationType } from "@cubby/schemas/location";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { UsersIcon } from "@phosphor-icons/react/dist/csr/Users";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { LocationPickerThumb } from "~/app/_components/locations/location-picker-thumb";
import { typeSupportsQrCode } from "~/app/_components/locations/location-type-theme";
import { location } from "~/app/locations/location.functions";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { entityDetailFor } from "~/entities/entity-detail.functions";

export function AddLabelsPopover({
  codes,
  onCodesChange,
}: {
  codes: string | undefined;
  onCodesChange: (newCodes: string) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebouncedValue(search, { wait: 300 });
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus search input when popover opens
  useEffect(() => {
    if (open) {
      // Small delay to let the popover render
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // `location.search`, not `.list`: this roster only renders name + breadcrumb
  // + cover, so it has no use for `.list`'s inventory/product/pricing payload.
  const { data: searchResults, isLoading } = useQuery({
    ...location.search.queryOptions({
      filters: { nameFilter: debouncedSearch || undefined },
      pagination: { pageIndex: 0, pageSize: 10 },
      sort: { orderBy: "name", direction: "asc" },
    }),
    enabled: open,
  });

  const locations = searchResults?.data ?? [];

  function mergeCodes(newShortcodes: string[]) {
    const existing =
      codes
        ?.split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0) ?? [];
    const merged = uniq([...existing, ...newShortcodes]);
    onCodesChange(merged.join(","));
  }

  function handleAddSingle(location: {
    id: LocationShortcode;
    name: string;
    type: LocationType | null;
  }) {
    if (!typeSupportsQrCode(location.type)) {
      toast.warning(
        `${location.name} is a ${location.type} and doesn't support QR labels`,
      );
      return;
    }
    if (!location.id) {
      toast.warning(`${location.name} has no shortcode`);
      return;
    }
    mergeCodes([location.id]);
    toast.success(`Added ${location.name}`);
  }

  async function handleAddChildren(location: {
    id: LocationShortcode;
    name: string;
  }) {
    const full = await queryClient.fetchQuery(
      entityDetailFor("location").queryOptions(location.id),
    );
    if (!full) {
      toast.warning(`${location.name} no longer exists`);
      return;
    }
    const children = full.children ?? [];
    const eligible = children.filter((c) => typeSupportsQrCode(c.type));

    if (eligible.length === 0) {
      toast.warning(
        `No QR-eligible children found in ${location.name} (rooms/areas are excluded)`,
      );
      return;
    }

    const skipped = children.length - eligible.length;
    mergeCodes(eligible.map((c) => c.id));
    toast.success(
      `Added ${eligible.length} label${eligible.length !== 1 ? "s" : ""} from ${location.name}` +
        (skipped > 0 ? ` (skipped ${skipped} without QR support)` : ""),
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm">
            <PlusIcon className="mr-2 size-4" />
            Add
          </Button>
        }
      />
      {/* Keep the full 24rem desktop width: the Add/Children pair takes a fixed
          ~7rem, and at narrower widths the breadcrumb can drop exactly the
          "lower"/"upper" suffix it exists to disambiguate. Phone viewports cap
          the surface to their gutter and let the ancestry line wrap instead. */}
      <PopoverContent
        align="start"
        aria-label="Add labels"
        className="w-[calc(100vw-1rem)] p-0 sm:w-96"
      >
        <div className="flex items-center gap-2 border-b px-2 py-2">
          <MagnifyingGlassIcon className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            aria-label="Search locations"
            placeholder="Search locations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {isLoading ? (
            <Description className="px-2 py-4 text-center">
              Searching...
            </Description>
          ) : locations.length === 0 ? (
            <Description className="px-2 py-4 text-center">
              No locations found
            </Description>
          ) : (
            locations.map((loc) => (
              <div
                key={loc.id}
                // No vertical padding: the thumbnail is full-bleed and its
                // own min-height sets the row height, matching the location
                // combobox rows.
                className="flex items-center gap-2 px-2 text-sm"
              >
                <LocationPickerThumb
                  imageUrl={loc.coverImage?.url}
                  type={loc.type}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{loc.name}</span>
                  {loc.ancestors.length > 0 && (
                    <span className="text-xs break-words text-muted-foreground sm:truncate">
                      {loc.ancestors.map((a) => a.name).join(" › ")}
                    </span>
                  )}
                </span>
                <div className="flex shrink-0 gap-1">
                  {typeSupportsQrCode(loc.type) && loc.id && (
                    <button
                      type="button"
                      aria-label={`Add ${loc.name}`}
                      className="min-h-11 min-w-11 px-2 text-xs text-primary hover:bg-muted sm:min-h-0 sm:min-w-0 sm:px-1.5 sm:py-0.5" /* tight */
                      onClick={() => handleAddSingle(loc)}
                    >
                      Add
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Add children of ${loc.name}`}
                    className="flex min-h-11 items-center gap-1 px-2 text-xs text-primary hover:bg-muted sm:min-h-0 sm:px-1.5 sm:py-0.5" /* tight */
                    onClick={() => void handleAddChildren(loc)}
                  >
                    <UsersIcon className="size-3" />
                    Children
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
