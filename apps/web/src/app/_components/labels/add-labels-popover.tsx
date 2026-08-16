import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { LocationType } from "@cubby/schemas/location";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { Plus, Search, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { LocationPickerThumb } from "~/app/_components/locations/location-picker-thumb";
import { typeSupportsQrCode } from "~/app/_components/locations/location-type-theme";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { useTRPC } from "~/integrations/trpc/react";

export function AddLabelsPopover({
  codes,
  onCodesChange,
}: {
  codes: string | undefined;
  onCodesChange: (newCodes: string) => void;
}) {
  const api = useTRPC();
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
    ...api.location.search.queryOptions({
      filters: { nameFilter: debouncedSearch || undefined },
      pagination: { pageIndex: 0, pageSize: 10 },
      sort: { orderBy: "name", direction: "asc" },
    }),
    enabled: open,
  });

  const locations = searchResults?.items ?? [];

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
    type: LocationType;
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
      api.location.getByID.queryOptions({
        id: location.id,
      }),
    );
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
            <Plus className="mr-2 size-4" />
            Add
          </Button>
        }
      />
      {/* w-96, not w-80: the Add/Children pair takes a fixed ~7rem, and at the
          narrower width the breadcrumb squeezed names down to "2 drawer packout
          …" — dropping exactly the "lower"/"upper" suffix it exists to
          disambiguate. */}
      <PopoverContent align="start" className="w-96 p-0">
        <div className="flex items-center gap-2 border-b px-2 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search locations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
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
                className="flex items-center gap-2 rounded-sm px-2 text-sm"
              >
                <LocationPickerThumb
                  imageUrl={loc.coverImage?.url}
                  type={loc.type}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{loc.name}</span>
                  {loc.ancestors.length > 0 && (
                    <span className="truncate text-muted-foreground text-xs">
                      {loc.ancestors.map((a) => a.name).join(" › ")}
                    </span>
                  )}
                </span>
                <div className="flex shrink-0 gap-1">
                  {typeSupportsQrCode(loc.type) && loc.id && (
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-primary text-xs hover:bg-muted" /* tight */
                      onClick={() => handleAddSingle(loc)}
                    >
                      Add
                    </button>
                  )}
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-primary text-xs hover:bg-muted" /* tight */
                    onClick={() => void handleAddChildren(loc)}
                  >
                    <Users className="size-3" />
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
