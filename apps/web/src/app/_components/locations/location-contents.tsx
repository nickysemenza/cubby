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
import {
  ChevronDown,
  ClipboardCheck,
  FolderPlus,
  Plus,
  Printer,
  ScanBarcode,
  SquarePen,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Row, Stack } from "~/components/layout";
import { Button, buttonVariants } from "~/components/ui/button";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { Description } from "~/components/ui/description";
import { Eyebrow } from "~/components/ui/eyebrow";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { invalidateTRPCQueries } from "~/lib/query-keys";
import { cn, formatCurrency } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import {
  ShelfCard,
  ShelfEmpty,
  ShelfGrid,
  ShelfTableToggle,
  type ShelfView,
} from "../data-table/shelf";
import { QuickInventoryAdd } from "../inventory/quick-inventory-add";
import {
  calculateInventoryValuation,
  formatPricingCountsSummary,
  type InventoryItem,
} from "./calculate-inventory-valuation";
import { CreateChildLocationDialog } from "./create-child-location-dialog";
import {
  LocationInventoryTable,
  locationInventoryListInput,
} from "./location-inventory-table";
import {
  getLocationIcon,
  getLocationTypeGroup,
  typeSupportsQrCode,
} from "./location-type-theme";

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
  const TypeIcon = getLocationIcon(location.type);
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
      to="/locations/$id"
      params={{ id: location.id }}
      image={location.images[0]?.url}
      extraCount={location.images.length - 1}
      title={location.name}
      subtitle={caption}
      entity="location"
      badgeSlot={<TypeIcon className="h-3 w-3" aria-label={location.type} />}
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
  const pricingNote = formatPricingCountsSummary(location.valuation?.total);

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "font-mono tabular-nums",
        )}
      >
        {formatCurrency(total)}
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
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
  const hasItems = itemCount > 0;

  // Flat grid sorted so like types sit adjacent (the badge carries the type
  // signal) — replaces the old Grouped/All toggle + per-type sub-headers.
  const sortedChildren = useMemo(
    () => sortBy(children, [groupRank, (c) => c.type, (c) => c.name]),
    [children],
  );

  const handlePrintLabels = useCallback(() => {
    const eligible = children.filter(
      (c) => c.shortcode && typeSupportsQrCode(c.type),
    );
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
    const codes = eligible.map((c) => c.shortcode).join(",");
    void navigate({ to: "/labels", search: { codes } });
  }, [children, navigate]);

  const handleChildCreated = useCallback(() => {
    invalidateTRPCQueries(queryClient, [
      api.location.getByID.queryKey({ id: location.id }),
    ]);
  }, [queryClient, api, location.id]);

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
      <Row align="center" gap="sm" wrap>
        <Button
          variant={addOpen ? "secondary" : "outline"}
          size="sm"
          onClick={toggleAdd}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add item
        </Button>
        <Button variant="outline" size="sm" onClick={openCreateChild}>
          <FolderPlus className="mr-2 h-4 w-4" />
          Add child
        </Button>
        <Link
          to="/inventory/session"
          search={{ parentId: location.id }}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <ScanBarcode className="mr-2 h-4 w-4" />
          Recount
        </Link>
        <Link
          to="/inventory/bulk-edit"
          search={{ locationId: location.id }}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <SquarePen className="mr-2 h-4 w-4" />
          Bulk edit
        </Link>
        {hasChildren && (
          <>
            <Link
              to="/locations/validate"
              search={{ parentId: location.id }}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              <ClipboardCheck className="mr-2 h-4 w-4" />
              Validate
            </Link>
            <Button variant="outline" size="sm" onClick={handlePrintLabels}>
              <Printer className="mr-2 h-4 w-4" />
              Print labels
            </Button>
          </>
        )}
        <ShelfTableToggle value={view} onChange={setView} className="ml-auto" />
      </Row>

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

      {!hasChildren && !hasItems ? (
        <ShelfEmpty
          entity="location"
          label="Nothing here yet — add an item or a sub-location"
        />
      ) : (
        <>
          {/* Sub-locations group — always cards, in both views. */}
          {hasChildren && (
            <Stack gap="sm">
              <Eyebrow>Locations · {children.length}</Eyebrow>
              <ShelfGrid
                items={sortedChildren}
                renderCard={(child) => (
                  <LocationShelfCard key={child.id} location={child} />
                )}
              />
            </Stack>
          )}

          {/* Items group — the shelf/table toggle applies here only. */}
          <Stack gap="sm">
            <Eyebrow>Items · {itemCount}</Eyebrow>
            {hasItems ? (
              <LocationInventoryTable locationId={location.id} view={view} />
            ) : (
              <ShelfEmpty
                entity="inventory"
                label="No items stored directly here"
              />
            )}
          </Stack>
        </>
      )}

      <CreateChildLocationDialog
        open={createChildOpen}
        onOpenChange={setCreateChildOpen}
        parentLocation={location}
        onSuccess={handleChildCreated}
      />
    </Stack>
  );
}
