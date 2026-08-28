import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { inventoryListItemOut } from "@cubby/schemas/inventory";
import { Link } from "@tanstack/react-router";
import { ImageIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { z } from "zod";

import {
  VerbMenuItem,
  verbBulkAction,
} from "~/app/_components/actions/action-verb-ui";
import type { ListQueryOptionsFn } from "~/app/_components/hooks/usePaginatedTableCore";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListFor } from "~/entities/entity-list.functions";

import {
  createEditableAmountColumn,
  createSingleEntityInlineLinkColumn,
} from "../data-table/columnHelpers";
import { ListWorkbench } from "../data-table/ListWorkbench";
import type { ShelfView } from "../data-table/shelf";
import { createCubbyColumnHelper } from "../data-table/table-features";
import { useEntityList } from "../hooks/useEntityList";
import { useUpdateMutation } from "../hooks/useUpdateMutation";
import { DeleteInventoryDialog } from "../inventory/delete-inventory-dialog";
import { InventoryShelf } from "../inventory/inventory-shelf";
import { MoveInventoryDialog } from "../inventory/move-inventory-dialog";
import {
  ProductImageSummariesProvider,
  useHydratedProductImages,
} from "../products/product-image-summaries";
import { useProductUnitMappingSummaries } from "../products/product-unit-mapping-summaries";
import { ImageThumbnail } from "../table/ImageThumbnail";

type InventoryItem = z.infer<typeof inventoryListItemOut>;

/**
 * The location-scoped inventory.list input, used by LocationContents' header
 * valuation/count reads.
 *
 * Deliberately spelled to match the table's DEFAULT sort + page (the array
 * sort form, `createdAt` desc, 100 per page — see `defaultSortState` /
 * `defaultPagination`), so on first load the header and the table still hit
 * one React Query cache entry. They diverge once the user sorts or pages,
 * which is correct: the table is then showing something else.
 */
export const locationInventoryListInput = (locationId: LocationShortcode) => ({
  sort: [{ orderBy: "createdAt", direction: "desc" as const }],
  pagination: { pageIndex: 0, pageSize: 100 },
  // Stock only. Installed fixtures are disclosed separately by
  // LocationContents rather than dropped — hiding them here without saying so
  // would make the shelf read as complete when it is not.
  filters: { locationIdFilter: locationId, placementFilter: "stock" as const },
});

interface LocationInventoryTableProps {
  locationId: LocationShortcode;
  /**
   * Which half of the shelf this table shows. Defaults to movable stock — the
   * browse contract. `LocationContents` renders a second instance with
   * "installed" so fixtures are disclosed rather than silently dropped.
   */
  placement?: "stock" | "installed";
  /** Shelf/table switch — owned by the parent (LocationContents) toolbar. */
  view: ShelfView;
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/** Stable hook config (see apps/web/CLAUDE.md on inline objects). */
const EMBEDDED_TABLE_STATE = {
  urlSync: false,
  readUrlState: false,
} as const;
const NO_TABLE_FILTERS = () => ({}) as Record<string, never>;

/**
 * An inventory entry is about its product, so product verbs reach this row
 * without the inventory table declaring any. Module-level: a fresh literal
 * per render feeds a hook dependency contract and rebuilds every column.
 */
const PRODUCT_SUBJECT = {
  entity: "product" as const,
  resolve: (row: { product: { id: string; name: string } }) => ({
    entity: "product" as const,
    id: row.product.id,
    name: row.product.name,
  }),
};

export function LocationInventoryTable({
  locationId,
  view,
  placement = "stock",
}: LocationInventoryTableProps) {
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<InventoryItem>(),
    [],
  );
  const [unitMappingProductIds, setUnitMappingProductIds] = useState<string[]>(
    [],
  );
  const unitMappingsByProductId = useProductUnitMappingSummaries(
    unitMappingProductIds,
  );
  const updateMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("inventory", "update"),
    entity: "inventory",
  });

  // Dialog states for bulk actions
  const [dialogState, setDialogState] = useState<{
    type: "move" | "delete" | null;
    items: InventoryItem[];
  }>({ type: null, items: [] });
  // `updateMutation` is intentionally absent from the dep array: useMutation
  // returns a new object every render, but the closure captures mutateAsync
  // correctly and it is functionally stable — same reasoning as the columns
  // memo below.
  const bulkActions = useMemo(
    () => ({
      actions: [
        verbBulkAction<InventoryItem>("moveTo", {
          id: "move",
          minSelection: 1,
          onExecute: async (rows) => {
            setDialogState({
              type: "move",
              items: rows.map((r) => r.original),
            });
            return { success: true };
          },
        }),
        verbBulkAction<InventoryItem>("delete", {
          minSelection: 1,
          onExecute: async (rows) => {
            setDialogState({
              type: "delete",
              items: rows.map((r) => r.original),
            });
            return { success: true };
          },
        }),
        // Marking is inherently a multi-select job — you sweep a room's
        // appliances in one pass — so it's a bulk action rather than a
        // per-row toggle. It does NOT move anything: the row keeps its
        // location and simply stops being counted. The verb flips with the
        // current placement, which is why this one is chosen rather than fixed.
        verbBulkAction<InventoryItem>(
          placement === "installed" ? "markAsStock" : "markInstalled",
          {
            id: "placement",
            minSelection: 1,
            onExecute: async (rows) => {
              const next = placement === "installed" ? "stock" : "installed";
              // Sequential, NOT Promise.all. The slot is
              // `(productId, locationId, placement)`, so flipping a stock row
              // whose installed twin already sits in this room is refused — a
              // legitimate state, which is why the key allows the pair. In
              // parallel that rejection lands after its siblings have already
              // been written, leaving a partial apply; serially it stops at
              // the offending row with everything before it durably done.
              for (const row of rows) {
                await updateMutation.mutateAsync({
                  id: row.original.id,
                  data: { placement: next },
                });
              }
              return { success: true };
            },
          },
        ),
      ],
      // Selection survives on purpose: if a flip is refused mid-batch, the rows
      // stay selected so it's visible which ones were being acted on.
      clearSelectionOnComplete: false,
    }),
    // oxlint-disable-next-line react/exhaustive-deps -- mutation identity churns every render
    [placement],
  );

  // Memoize columns to prevent recreating on every render. updateMutation is
  // NOT in the dependency array because useMutation returns a new object
  // every render, but the closure captures mutateAsync correctly and it's
  // functionally stable — see productlist.tsx for the same pattern.
  const columns = useMemo(
    () => [
      columnHelper.accessor((row) => row.product.id, {
        id: "image",
        header: () => <ImageIcon className="size-3 text-muted-foreground" />,
        enableSorting: false,
        meta: {
          className: "h-px w-10 overflow-hidden px-0 py-0",
          mobile: { slot: "image", priority: -10 },
        },
        cell: (info) => (
          <InventoryProductImageCell productId={info.getValue()} />
        ),
      }),

      createSingleEntityInlineLinkColumn(columnHelper, "product", "product", {
        header: "Product",
        className: "min-w-0 w-64",
      }),

      createEditableAmountColumn(columnHelper, "amount", {
        onSave: async (newAmount, row) => {
          await updateMutation.mutateAsync({
            id: row.id,
            data: { amount: newAmount },
          });
        },
        getUnitMappings: (row) => unitMappingsByProductId[row.product.id] ?? [],
        // The only click-through to the row's OWN entity — every other column
        // here points at the product or location. Same treatment as the
        // /inventory index list.
        renderDisplay: (content, row) => (
          <Link to="/inventory/$shortcode" params={{ shortcode: row.id }}>
            {content}
          </Link>
        ),
      }),
    ],
    // oxlint-disable-next-line react/exhaustive-deps -- updateMutation changes every render but is functionally stable
    [columnHelper, unitMappingsByProductId],
  );

  // Fixed parent scope merged with the table's live sort/pagination.
  const listQueryOptions: ListQueryOptionsFn<Record<string, never>> =
    useCallback(
      (params) =>
        entityListFor("inventory").queryOptions({
          sort: params.sort,
          pagination: params.pagination,
          filters: { locationIdFilter: locationId, placementFilter: placement },
        }),
      [locationId, placement],
    );

  const { workbench, data } = useEntityList<
    InventoryItem,
    Record<string, never>
  >({
    entity: "inventory",
    // Embedded inventory owns contextual Move/Delete dialogs; canonical
    // roster actions would duplicate them on this subresource table.
    includeCatalogActions: false,
    layoutKey: "inventory:location-detail",
    subject: PRODUCT_SUBJECT,
    // Forward the table's own sort/pagination — dropping the argument left the
    // Product/Amount sort headers doing nothing (manualSorting is on, so
    // TanStack doesn't sort client-side either) and made every page of a
    // >100-entry location show the same first 100 rows.
    queryOptions: listQueryOptions,
    buildFilters: NO_TABLE_FILTERS,
    filters: [],
    // One URL writer per page: the location detail page owns the params, and
    // this table is embedded alongside its other content.
    tableStateOptions: EMBEDDED_TABLE_STATE,
    columns,
    extraActions: (item) => (
      <>
        <VerbMenuItem
          verb="moveTo"
          onSelect={() => setDialogState({ type: "move", items: [item] })}
        />
        <VerbMenuItem
          verb="delete"
          onSelect={() => setDialogState({ type: "delete", items: [item] })}
        />
      </>
    ),
    bulkActions,
  });

  const items = workbench.table.getRowModel().rows.map((r) => r.original);
  const productIds = useMemo(() => data.map((item) => item.product.id), [data]);

  useEffect(() => {
    setUnitMappingProductIds((current) =>
      sameIds(current, productIds) ? current : productIds,
    );
  }, [productIds]);

  return (
    <ProductImageSummariesProvider productIds={productIds}>
      {view === "shelf" ? (
        <InventoryShelf
          items={items}
          isLoading={workbench.isLoading}
          error={workbench.error}
        />
      ) : (
        <ListWorkbench model={workbench} mode="embedded" />
      )}

      {/* Move dialog */}
      <MoveInventoryDialog
        open={dialogState.type === "move"}
        onOpenChange={(open) => {
          if (!open) setDialogState({ type: null, items: [] });
        }}
        items={dialogState.items}
        sourceLocationId={locationId}
        onSuccess={() => {
          setDialogState({ type: null, items: [] });
          workbench.table.resetRowSelection();
        }}
      />

      {/* Delete dialog */}
      <DeleteInventoryDialog
        open={dialogState.type === "delete"}
        onOpenChange={(open) => {
          if (!open) setDialogState({ type: null, items: [] });
        }}
        items={dialogState.items}
        onSuccess={() => {
          setDialogState({ type: null, items: [] });
          workbench.table.resetRowSelection();
        }}
      />
    </ProductImageSummariesProvider>
  );
}

function InventoryProductImageCell({ productId }: { productId: string }) {
  const images = useHydratedProductImages(productId);

  return (
    <ImageThumbnail
      images={images}
      alt="Image"
      lazyPreview={true}
      entity="inventory"
    />
  );
}
