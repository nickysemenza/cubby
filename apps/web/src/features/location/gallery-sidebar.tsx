import type { InfLocation } from "@cubby/schemas/location";
import { SidebarIcon } from "@phosphor-icons/react/dist/csr/Sidebar";
import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/ui/primitives/button";

import { LocationOutline } from "./location-outline";

export function GallerySidebar({
  locations,
  query,
  filtering,
  selectedId,
  onSelect,
  expandedIds,
  onToggle,
  collapsed,
  onToggleCollapse,
}: {
  locations: InfLocation[];
  query: string;
  filtering: boolean;
  selectedId?: string;
  onSelect: (id?: string) => void;
  expandedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const outlineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = outlineRef.current;
    const row = viewport?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!viewport || !row) return;
    const bounds = viewport.getBoundingClientRect();
    const target = row.getBoundingClientRect();
    if (target.top < bounds.top) viewport.scrollTop += target.top - bounds.top;
    else if (target.bottom > bounds.bottom)
      viewport.scrollTop += target.bottom - bounds.bottom;
  }, [selectedId, expandedIds, collapsed]);
  return (
    <aside
      aria-label="Location navigation"
      className={cn(
        "flex shrink-0 flex-col border-b border-border md:min-h-0 md:border-r md:border-b-0",
        collapsed ? "md:w-9" : "md:w-56",
      )}
    >
      <div className="flex min-h-9 items-center justify-between border-b border-border px-1">
        {collapsed && (
          <span className="px-1 text-xs font-medium md:hidden">Locations</span>
        )}
        {!collapsed && (
          <button
            type="button"
            onClick={() => onSelect(undefined)}
            aria-current={!selectedId ? "page" : undefined}
            className="min-h-11 px-1 text-xs font-medium hover:underline sm:min-h-7"
          >
            All locations
          </button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleCollapse}
          aria-label={
            collapsed ? "Show location navigation" : "Hide location navigation"
          }
          aria-expanded={!collapsed}
          className="size-8"
        >
          <SidebarIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
      {!collapsed && (
        <div
          ref={outlineRef}
          className="max-h-56 min-h-0 overflow-y-auto md:max-h-none md:flex-1"
        >
          <div
            className="px-2 pt-1 text-right text-2xs text-muted-foreground"
            title="Inventory entries including descendants"
          >
            Items
          </div>
          {locations.length ? (
            <LocationOutline
              locations={locations}
              query={query}
              revealMatches={filtering}
              expandedIds={expandedIds}
              onToggle={onToggle}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ) : (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              No locations in this outline.
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
