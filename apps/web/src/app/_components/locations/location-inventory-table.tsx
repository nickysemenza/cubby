import type {
  InventoryShortcode,
  LocationShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import type { inventoryListItemOut } from "@cubby/schemas/inventory";
import { Link } from "@tanstack/react-router";
import type { Row } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import { ArrowRightLeft, ImageIcon, PackageMinus, Trash } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { z } from "zod";
import type { TRPCQueryOptionsFn } from "~/app/_components/hooks/usePaginatedTableCore";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";
import { inventoryMutationInvalidateKeys } from "~/lib/query-keys";
import {
  createEditableAmountColumn,
  createSingleEntityInlineLinkColumn,
} from "../data-table/columnHelpers";
import type { ShelfView } from "../data-table/shelf";
import RTable from "../data-table/Table";
import { useEntityList } from "../hooks/useEntityList";
import { useUpdateMutation } from "../hooks/useUpdateMutation";
import { DeleteInventoryDialog } from "../inventory/delete-inventory-dialog";
import { InventoryDiscardDialog } from "../inventory/inventory-discard-dialog";
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

export function LocationInventoryTable({
  locationId,
  view,
  placement = "stock",
}: LocationInventoryTableProps) {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<InventoryItem>(), []);
  const [unitMappingProductIds, setUnitMappingProductIds] = useState<string[]>(
    [],
  );
  const unitMappingsByProductId = useProductUnitMappingSummaries(
    unitMappingProductIds,
  );
  const updateMutation = useUpdateMutation({
    mutationFn: api.inventory.update.mutationOptions,
    entity: "inventory",
    invalidateKeys: inventoryMutationInvalidateKeys,
  });

  // Dialog states for bulk actions
  const [dialogState, setDialogState] = useState<{
    type: "move" | "delete" | null;
    items: InventoryItem[];
  }>({ type: null, items: [] });
  // Discard is single-row only: it writes one ledger line against one product.
  const [discardTarget, setDiscardTarget] = useState<{
    productId: ProductShortcode;
    entryId: InventoryShortcode;
  } | null>(null);

  const bulkActions = useMemo(
    () => ({
      actions: [
        {
          id: "move",
          label: "Move",
          icon: <ArrowRightLeft className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<InventoryItem>[]) => {
            setDialogState({
              type: "move",
              items: rows.map((r) => r.original),
            });
            return { success: true };
          },
        },
        {
          id: "delete",
          label: "Delete",
          icon: <Trash className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<InventoryItem>[]) => {
            setDialogState({
              type: "delete",
              items: rows.map((r) => r.original),
            });
            return { success: true };
          },
        },
      ],
      clearSelectionOnComplete: false,
    }),
    [],
  );

  // Memoize columns to prevent recreating on every render. updateMutation is
  // NOT in the dependency array because useMutation returns a new object
  // every render, but the closure captures mutateAsync correctly and it's
  // functionally stable — see productlist.tsx for the same pattern.
  // biome-ignore lint/correctness/useExhaustiveDependencies: updateMutation changes every render but is functionally stable
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
    [columnHelper, unitMappingsByProductId],
  );

  // Fixed parent scope merged with the table's live sort/pagination.
  const listQueryOptions: TRPCQueryOptionsFn<Record<string, never>> =
    useCallback(
      (params) =>
        api.inventory.list.queryOptions({
          sort: params.sort,
          pagination: params.pagination,
          filters: { locationIdFilter: locationId, placementFilter: placement },
        }),
      [api, locationId, placement],
    );

  const { table, data, isLoading, error, bulkActionBar } = useEntityList<
    InventoryItem,
    Record<string, never>
  >({
    entity: "inventory",
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
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDialogState({ type: "move", items: [item] })}
        >
          <ArrowRightLeft className="mr-2 size-4" />
          Move to...
        </Button>
        {/* Discard writes a ledger row and can clear the shelf in the same
            transaction — the honest verb for "used it up", where Delete just
            says the entry should never have existed. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setDiscardTarget({
              productId: item.product.id,
              entryId: item.id,
            })
          }
        >
          <PackageMinus className="mr-2 size-4" />
          Discard...
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={() => setDialogState({ type: "delete", items: [item] })}
        >
          <Trash className="mr-2 size-4" />
          Delete
        </Button>
      </>
    ),
    bulkActions,
  });

  const items = table.getRowModel().rows.map((r) => r.original);
  const productIds = useMemo(() => data.map((item) => item.product.id), [data]);

  useEffect(() => {
    setUnitMappingProductIds((current) =>
      sameIds(current, productIds) ? current : productIds,
    );
  }, [productIds]);

  return (
    <ProductImageSummariesProvider productIds={productIds}>
      {view === "shelf" ? (
        <InventoryShelf items={items} isLoading={isLoading} error={error} />
      ) : (
        <RTable
          table={table}
          isLoading={isLoading}
          error={error}
          entity="inventory"
          sizingKey="inventory:location-detail"
          bulkActionBar={bulkActionBar}
          embedded
        />
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
          table.resetRowSelection();
        }}
      />

      {/* Discard dialog — fetches the product so the operator sees every shelf.
          Mounted only while targeted, so the fetch never runs at rest. */}
      {discardTarget && (
        <InventoryDiscardDialog
          onOpenChange={(open) => {
            if (!open) setDiscardTarget(null);
          }}
          target={discardTarget}
        />
      )}

      {/* Delete dialog */}
      <DeleteInventoryDialog
        open={dialogState.type === "delete"}
        onOpenChange={(open) => {
          if (!open) setDialogState({ type: null, items: [] });
        }}
        items={dialogState.items}
        onSuccess={() => {
          setDialogState({ type: null, items: [] });
          table.resetRowSelection();
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
