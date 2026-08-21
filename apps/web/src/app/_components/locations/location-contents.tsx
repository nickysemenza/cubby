/**
 * LocationContents — the unified "what lives here" section of a location
 * detail page. Sub-locations and directly-stored inventory items share one
 * surface and one visual language (square photo shelf cards), under a single
 * toolbar (add item / add child / recount / validate / print labels / view
 * toggle). The rolled-up valuation renders in the section header via
 * {@link LocationContentsValuation}.
 */

import type { InfLocation } from "@cubby/schemas/location";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { sortBy } from "es-toolkit";
import { ChevronDown, EllipsisVertical, FolderPlus, Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  VerbButton,
  VerbMenuItem,
} from "~/app/_components/actions/action-verb-ui";
import { Row, Stack } from "~/components/layout";
import { Button, buttonVariants } from "~/components/ui/button";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { Description } from "~/components/ui/description";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Eyebrow } from "~/components/ui/eyebrow";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { ViewSwitcher } from "~/components/ui/view-switcher";
import { EntityFormDialog } from "~/entities/editing/entity-form-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { invalidateTRPCQueries, queryKeys } from "~/lib/query-keys";
import { cn, formatCurrency } from "~/lib/utils";
import {
  SHELF_VIEW_OPTIONS,
  ShelfCard,
  ShelfEmpty,
  ShelfGrid,
  type ShelfView,
} from "../data-table/shelf";
import { QuickInventoryAdd } from "../inventory/quick-inventory-add";
import {
  calculateInventoryValuation,
  formatPricingCountsSummary,
  type InventoryItem,
} from "./calculate-inventory-valuation";
import { LocationChildrenTable } from "./location-children-table";
import { locationContentsVisibility } from "./location-contents-state";
import { LocationInventoryBreakdown } from "./location-inventory-breakdown";
import {
  LocationInventoryTable,
  locationInventoryListInput,
} from "./location-inventory-table";
import { LocationPhotoAction } from "./location-photo-action";
import {
  getLocationGlyph,
  getLocationTypeGroup,
  typeSupportsQrCode,
} from "./location-type-theme";
import { LocationVisual } from "./location-visual";
import { locationChildGroupLabel } from "./location-visual-resolver";

/** Display order for type groups in the sub-locations grid. */
const GROUP_ORDER = ["surfaces", "storage", "containers", "spaces"] as const;

const groupRank = (loc: InfLocation) => {
  const idx = GROUP_ORDER.indexOf(
    getLocationTypeGroup(loc.type) as (typeof GROUP_ORDER)[number],
  );
  return idx === -1 ? GROUP_ORDER.length : idx;
};

/** One sub-location as a square photo card, matching the item shelf cards. */
function LocationShelfCard({ location }: { location: InfLocation }) {
  const TypeIcon = getLocationGlyph(location);
  const itemCount =
    location.valuation?.totalItemCount ?? location.directItemCount ?? 0;
  const childCount = location.childCount ?? 0;
  const caption = [
    location.valuation
      ? formatCurrency(location.valuation.totalValuation)
      : null,
    `${itemCount} item${itemCount === 1 ? "" : "s"}`,
    childCount > 0 ? `${childCount} loc${childCount === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ShelfCard
      to="/locations/$shortcode"
      params={{ shortcode: location.id }}
      media={<LocationVisual location={location} variant="card" />}
      title={location.name}
      subtitle={caption}
      entity="location"
      badgeSlot={
        <TypeIcon
          className="size-3"
          aria-label={location.type ?? location.product?.name}
        />
      }
    />
  );
}

/**
 * The Contents section's header stat: rolled-up total (direct + descendants,
 * from the persisted location.valuation) with the by-manufacturer breakdown
 * of direct items behind a popover.
 */
export function LocationContentsValuation({
  location,
}: {
  location: InfLocation;
}) {
  const total = location.valuation?.totalValuation ?? 0;
  const totalItems =
    location.valuation?.totalItemCount ?? location.totalItemCount ?? 0;
  const children = location.children ?? [];
  const childCount = children.length;
  const childLabel = locationChildGroupLabel(children);
  const pricingNote = formatPricingCountsSummary(location.valuation?.total);

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "font-mono tabular-nums",
        )}
      >
        <span className="max-w-[70vw] truncate">
          {totalItems} {totalItems === 1 ? "item" : "items"}
          {childCount > 0
            ? ` across ${childCount} ${childLabel.toLowerCase()}`
            : ""}{" "}
          · {formatCurrency(total)}
        </span>
        <ChevronDown className="size-3 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <Stack gap="xs">
          <Row align="baseline" justify="between">
            <Eyebrow as="span">Total value</Eyebrow>
            <span className="font-mono text-sm tabular-nums">
              {formatCurrency(total)}
            </span>
          </Row>
          {pricingNote && <Description size="xs">{pricingNote}</Description>}
          <ValuationBreakdown location={location} />
        </Stack>
      </PopoverContent>
    </Popover>
  );
}

/** By-manufacturer breakdown of DIRECT items (descendants excluded). */
function ValuationBreakdown({ location }: { location: InfLocation }) {
  const api = useTRPC();
  // Same query key as LocationInventoryTable's list — served from its cache.
  const { data } = useQuery(
    api.inventory.list.queryOptions(locationInventoryListInput(location.id)),
  );
  const breakdown = useMemo(
    () =>
      calculateInventoryValuation((data?.items ?? []) as InventoryItem[])
        .breakdown,
    [data],
  );

  if (breakdown.length === 0) return null;

  return (
    <div className="mt-2 border-[var(--border)] border-t pt-2">
      <Eyebrow className="mb-1">Direct items by manufacturer</Eyebrow>
      <Stack as="ul" gap="xs">
        {breakdown.slice(0, 6).map((b) => (
          <Row
            as="li"
            key={b.key}
            align="center"
            justify="between"
            className="text-xs"
          >
            <span className="truncate pr-2">{b.label}</span>
            <span className="font-mono tabular-nums">
              {formatCurrency(b.valuation)}
            </span>
          </Row>
        ))}
      </Stack>
    </div>
  );
}

/**
 * The fixtures companion to `locationInventoryListInput`.
 *
 * Its own explicit input, NOT a spread of the stock one: they must land on
 * separate React Query cache entries, and sharing a shape is exactly how two
 * lists end up serving each other's rows.
 */
const locationFixturesListInput = (locationId: InfLocation["id"]) => ({
  sort: [{ orderBy: "createdAt", direction: "desc" as const }],
  pagination: { pageIndex: 0, pageSize: 100 },
  filters: {
    locationIdFilter: locationId,
    placementFilter: "installed" as const,
  },
});

export function LocationContents({ location }: { location: InfLocation }) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [view, setView] = useState<ShelfView>("shelf");
  const [addOpen, setAddOpen] = useState(false);
  const [createChildOpen, setCreateChildOpen] = useState(false);

  const children = location.children ?? [];
  const hasChildren = children.length > 0;

  // Live items read — same cache entry as the table's list query, so this is
  // free; drives the group count/empty-state so they can't go stale against
  // the grid below.
  const { data: itemsData } = useQuery(
    api.inventory.list.queryOptions(locationInventoryListInput(location.id)),
  );
  const itemCount = itemsData?.meta.totalCount ?? location.directItemCount ?? 0;
  const visibility = locationContentsVisibility(children.length, itemCount);

  // Fixtures are excluded from the list above, so they have to be disclosed
  // rather than silently dropped — otherwise the shelf reads as complete when
  // it isn't. Zero fixtures renders nothing at all.
  const { data: fixturesData } = useQuery(
    api.inventory.list.queryOptions(locationFixturesListInput(location.id)),
  );
  const fixtureCount = fixturesData?.meta.totalCount ?? 0;

  // Flat grid sorted so like types sit adjacent (the badge carries the type
  // signal) — replaces the old Grouped/All toggle + per-type sub-headers.
  const sortedChildren = useMemo(
    () => sortBy(children, [groupRank, (c) => c.type, (c) => c.name]),
    [children],
  );
  const childGroupLabel = locationChildGroupLabel(sortedChildren);

  const handlePrintLabels = useCallback(() => {
    const eligible = children.filter((c) => c.id && typeSupportsQrCode(c.type));
    const skipped = children.length - eligible.length;

    if (eligible.length === 0) {
      toast.error(
        "None of the child locations support QR code labels (rooms and areas are excluded)",
      );
      return;
    }
    if (skipped > 0) {
      toast.info(
        `Skipped ${skipped} location${skipped === 1 ? "" : "s"} without QR support (rooms/areas)`,
      );
    }
    const codes = eligible.map((c) => c.id).join(",");
    void navigate({ to: "/labels", search: { codes } });
  }, [children, navigate]);

  const handleChildCreated = useCallback(() => {
    invalidateTRPCQueries(queryClient, [
      // Children change every derived location view, including the count-only
      // drill-down. Keep this broad instead of adding one-off query keys.
      queryKeys.location.all,
    ]);
  }, [queryClient]);

  const handleItemAdded = useCallback(() => {
    setAddOpen(false);
  }, []);

  const toggleAdd = useCallback(() => {
    setAddOpen((prev) => !prev);
  }, []);

  const openCreateChild = useCallback(() => {
    setCreateChildOpen(true);
  }, []);

  return (
    <Stack gap="md">
      {/* Toolbar — every contents operation in one place. */}
      <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
        <Button
          variant={addOpen ? "secondary" : "outline"}
          size="sm"
          className="col-span-2 h-12 sm:col-span-1 sm:h-7"
          onClick={toggleAdd}
        >
          <Plus />
          Add item
        </Button>
        <LocationPhotoAction location={location} className="h-12 sm:h-7" />
        <VerbButton
          verb="recount"
          className="h-12 sm:h-7"
          render={
            <Link to="/inventory/session" search={{ parent: location.id }} />
          }
        />
        <div className="hidden items-center gap-2 sm:flex">
          <Button variant="outline" size="sm" onClick={openCreateChild}>
            <FolderPlus />
            Add child
          </Button>
          <VerbButton
            verb="photoPass"
            render={
              <Link
                to="/locations/photo-pass"
                search={{ parent: location.id }}
              />
            }
          />
          <VerbButton
            verb="bulkEdit"
            render={
              <Link
                to="/inventory/bulk-edit"
                search={{ locationId: location.id }}
              />
            }
          />
          {hasChildren && (
            <>
              <VerbButton
                verb="validate"
                render={
                  <Link
                    to="/problems"
                    search={{ validateParent: location.id }}
                  />
                }
              />
              <VerbButton verb="printLabels" onClick={handlePrintLabels} />
            </>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="sm:hidden"
            render={
              <Button
                variant="outline"
                size="sm"
                className="h-10 w-full"
                aria-label="More location actions"
              >
                <EllipsisVertical />
                More
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-44 sm:hidden">
            <DropdownMenuItem onClick={openCreateChild}>
              <FolderPlus />
              Add child
            </DropdownMenuItem>
            <VerbMenuItem
              verb="photoPass"
              render={
                <Link
                  to="/locations/photo-pass"
                  search={{ parent: location.id }}
                />
              }
            />
            <VerbMenuItem
              verb="bulkEdit"
              render={
                <Link
                  to="/inventory/bulk-edit"
                  search={{ locationId: location.id }}
                />
              }
            />
            {hasChildren && (
              <>
                <VerbMenuItem
                  verb="validate"
                  render={
                    <Link
                      to="/problems"
                      search={{ validateParent: location.id }}
                    />
                  }
                />
                <VerbMenuItem verb="printLabels" onSelect={handlePrintLabels} />
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <ViewSwitcher
          options={SHELF_VIEW_OPTIONS}
          value={view}
          onValueChange={setView}
          className="justify-self-end sm:ml-auto"
        />
      </div>

      {/* Quick-add rides collapsed behind the toolbar's Add item button. */}
      <Collapsible open={addOpen}>
        <CollapsibleContent>
          <div className="border border-[var(--border)] bg-muted/20 p-4">
            <QuickInventoryAdd
              locationId={location.id}
              onSuccess={handleItemAdded}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      <LocationInventoryBreakdown
        shortcode={location.id}
        hasChildren={hasChildren}
      />

      {visibility.empty ? (
        <ShelfEmpty
          entity="location"
          label="Nothing here yet — add an item or a sub-location"
        />
      ) : (
        <>
          {/* Sub-locations group — cards on the shelf, a full descendant tree
              in the table. The toggle covers both groups. */}
          {visibility.showChildren && (
            <Stack gap="sm">
              <Eyebrow>
                {childGroupLabel} · {children.length}
              </Eyebrow>
              {view === "table" ? (
                <LocationChildrenTable locationId={location.id} />
              ) : (
                <ShelfGrid
                  items={sortedChildren}
                  renderCard={(child) => (
                    <LocationShelfCard key={child.id} location={child} />
                  )}
                />
              )}
            </Stack>
          )}

          {/* Items group — the shelf/table toggle applies here only. */}
          {visibility.showDirectItems && (
            <Stack gap="sm">
              <Eyebrow>Items here · {itemCount}</Eyebrow>
              <LocationInventoryTable locationId={location.id} view={view} />
            </Stack>
          )}

          {fixtureCount > 0 && (
            <details>
              <summary className="cursor-pointer text-muted-foreground text-sm">
                Installed fixtures · {fixtureCount}
              </summary>
              <Stack gap="sm" className="pt-2">
                <p className="text-muted-foreground text-sm">
                  Wired or plumbed in. Kept as a record, never counted during a
                  recount.
                </p>
                <LocationInventoryTable
                  locationId={location.id}
                  view={view}
                  placement="installed"
                />
              </Stack>
            </details>
          )}
        </>
      )}

      <EntityFormDialog
        entity="location"
        open={createChildOpen}
        onOpenChange={setCreateChildOpen}
        seed={{ parentLocation: location }}
        onSuccess={handleChildCreated}
      />
    </Stack>
  );
}
