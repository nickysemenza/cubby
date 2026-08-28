import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { InventoryPlacement } from "@cubby/schemas/inventory";
import type { ProductWithFoodOut } from "@cubby/schemas/product";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FC, useCallback, useMemo, useState } from "react";

import {
  VerbMenuItem,
  verbBulkAction,
} from "~/app/_components/actions/action-verb-ui";
import {
  createCurrencyColumn,
  createEditableAmountColumn,
  createSingleEntityInlineLinkColumn,
} from "~/app/_components/data-table/columnHelpers";
import { ListWorkbench } from "~/app/_components/data-table/ListWorkbench";
import {
  type CubbyRow,
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import { useClientEntityList } from "~/app/_components/hooks/useClientEntityList";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { DeleteInventoryDialog } from "~/app/_components/inventory/delete-inventory-dialog";
import { MoveInventoryDialog } from "~/app/_components/inventory/move-inventory-dialog";
import { HierarchyDrilldown } from "~/app/_components/visualizations/hierarchy-drilldown";
import { AuditedHint } from "~/app/inventory/session/_components/AuditedHint";
import { product as productOperations } from "~/app/products/product.functions";
import { Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";

import { ShelfEmpty } from "../data-table/shelf";
import { EntityInlineLink } from "../EntityInlineLink";
import { buildProductLocationBreakdown } from "./product-location-breakdown";

type InventoryEntry = ProductWithFoodOut["inventoryEntry"][number];

/**
 * Where a decomposed kit's stock actually sits. Renders nothing until the
 * component rows arrive rather than guessing at them — the surrounding empty
 * state already carries the fact, and this only names the parts.
 */
const HeldAsComponents: FC<{
  productId: ProductShortcode;
  operations: ProductStockedAtOperations;
}> = ({ productId, operations }) => {
  const { data } = useQuery(
    operations.components.queryOptions({ parentProductId: productId }),
  );
  if (!data || data.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
      <span>Held as</span>
      {data.map((component, index) => (
        <span key={component.productId} className="flex items-center gap-1">
          {index > 0 && <span aria-hidden>·</span>}
          <span className="tabular-nums">{component.quantity}×</span>
          <EntityInlineLink
            displayImage={undefined}
            entity="product"
            data={{
              id: component.productId,
              name: component.productName,
              manufacturer: component.manufacturer,
            }}
            compact
          />
        </span>
      ))}
    </div>
  );
};

/**
 * One table, one question: where is this product?
 *
 * Two kinds of answer share it. A `stock` row is an InventoryEntry — units
 * sitting somewhere, editable and deletable. An `identity` row is a Location
 * that IS this product: the bin itself, in service rather than on a shelf.
 *
 * They live together because splitting them made the page contradict itself —
 * a rack in use as a shelf read "Not stocked anywhere" in one section while
 * another listed it. The discriminator column is the honest way to show two
 * kinds of presence, and it extends vocabulary `inventoryEntry.placement`
 * already established for `stock` vs `installed`.
 *
 * An identity row has no InventoryEntry behind it, so it is unselectable, has
 * no row menu and no editable cell. `rowIsEntity` and `isEditable` enforce
 * that structurally rather than by hoping a handler checks.
 */
type StockRow = InventoryEntry & {
  kind: "stock";
  product: { name: string };
};

type IdentityRow = {
  kind: "identity";
  id: string;
  location: ProductWithFoodOut["servingAsLocations"][number];
  amount: { value: number; unit: string };
  valuation: number | null;
  verifiedAt: null;
  placement: "stock";
  product: { name: string };
};

type StockedRow = StockRow | IdentityRow;

/** Remote read used only when a decomposed kit has no direct stock rows. */
export interface ProductStockedAtOperations {
  components: typeof productOperations.components;
}

const productionOperations: ProductStockedAtOperations = {
  components: productOperations.components,
};

/** Stable hook config (see apps/web/CLAUDE.md on inline objects). */
const EMBEDDED_TABLE_STATE = {
  urlSync: false,
  readUrlState: false,
} as const;

const rowIsEntity = (row: StockedRow) => row.kind === "stock";

type DialogState =
  | { type: null }
  | { type: "move" | "delete"; items: StockRow[] };

const CLOSED: DialogState = { type: null };

/** Project inventory and location-as-product rows onto one honest table model. */
export function productStockedRows(product: ProductWithFoodOut): StockedRow[] {
  const stock = product.inventoryEntry.map((entry): StockRow => ({
    ...entry,
    kind: "stock",
    product: { name: product.name },
  }));
  const identity = product.servingAsLocations.map((location): IdentityRow => ({
    kind: "identity",
    // The table keys rows by `id` and an identity row has no InventoryEntry,
    // so it uses the location shortcode as a display-only table key.
    id: location.id,
    location,
    // A location is one unit of the product by definition.
    amount: { value: 1, unit: "each" },
    // The effective price mirrors stock rows' server projection.
    valuation: product.pricing.effectivePrice,
    verifiedAt: null,
    placement: "stock",
    product: { name: product.name },
  }));
  return [...stock, ...identity];
}

/** Product inventory rows: location and amount are direct, editable entry fields. */
export const ProductStockedAt: FC<{
  product: ProductWithFoodOut;
  operations?: ProductStockedAtOperations;
}> = ({ product, operations = productionOperations }) => {
  const helper = useMemo(() => createCubbyColumnHelper<StockedRow>(), []);
  const [dialog, setDialog] = useState<DialogState>(CLOSED);
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("inventory", "update"),
    entity: "inventory",
  });

  // The shared Move/Delete dialogs name a row by its product; on this page the
  // product is the page itself, so carry it onto the row rather than refetching
  // the list-shaped inventory row.
  const rows = useMemo(() => productStockedRows(product), [product]);

  const locationBreakdown = useMemo(
    () => buildProductLocationBreakdown(product),
    [product],
  );

  const columns = useMemo(
    () =>
      createCubbyColumnCollection<StockedRow>((add) => {
        add(
          createSingleEntityInlineLinkColumn(helper, "location", "location", {
            header: "Location",
            className: "w-56",
            editable: {
              isEditable: rowIsEntity,
              onSave: async (locationId, entry) => {
                if (!locationId || entry.kind !== "stock") return;
                await update.mutateAsync({
                  id: entry.id,
                  data: { locationId },
                });
              },
            },
          }),
        );
        add(
          helper.accessor("kind", {
            header: "Held as",
            meta: { className: "w-32" },
            cell: (info) =>
              info.getValue() === "identity" ? (
                <Badge variant="secondary">is this location</Badge>
              ) : info.row.original.placement === "installed" ? (
                <Badge variant="secondary">installed</Badge>
              ) : (
                <Badge variant="outline">stock</Badge>
              ),
          }),
        );
        add(
          createEditableAmountColumn(helper, "amount", {
            isEditable: rowIsEntity,
            onSave: async (amount, entry) => {
              if (entry.kind !== "stock") return;
              await update.mutateAsync({ id: entry.id, data: { amount } });
            },
            getUnitMappings: () => product.unitMappings,
            // The row's own entity — every other column here points at the
            // location or the product. Same treatment as the location table.
            renderDisplay: (content, entry) =>
              entry.kind === "stock" ? (
                <Link
                  to="/inventory/$shortcode"
                  params={{ shortcode: entry.id }}
                >
                  {content}
                </Link>
              ) : (
                content
              ),
          }),
        );
        add(
          createCurrencyColumn(helper, "valuation", {
            header: "Value",
            className: "w-24",
          }),
        );
        add(
          helper.accessor("verifiedAt", {
            header: "Verified",
            meta: { className: "w-32" },
            cell: (info) =>
              // A location is not recounted as its own stock, so there is nothing
              // to be stale about.
              info.row.original.kind === "identity" ? null : (
                <AuditedHint
                  at={info.getValue()}
                  label="verified"
                  placement={info.row.original.placement}
                />
              ),
          }),
        );
      }),
    // oxlint-disable-next-line react/exhaustive-deps -- mutation wrapper is functionally stable
    [helper, product.unitMappings],
  );

  /**
   * Move the selection to one placement, skipping rows already there.
   *
   * Sequential, NOT `Promise.all` — the same reason the location table spells
   * out: the slot is `(productId, locationId, placement)`, so flipping a row
   * whose twin already sits in that room at the target placement is refused. In
   * parallel that rejection lands after its siblings are already written,
   * leaving a partial apply; serially it stops at the offending row with
   * everything before it durably done.
   */
  const flipTo = useCallback(
    async (next: InventoryPlacement, selected: CubbyRow<StockedRow>[]) => {
      const movable = selected
        .map((row) => row.original)
        .filter(
          (row): row is StockRow =>
            row.kind === "stock" && row.placement !== next,
        );
      for (const row of movable) {
        await update.mutateAsync({ id: row.id, data: { placement: next } });
      }
      return { success: true };
    },
    [update],
  );

  const bulkActions = useMemo(
    () => ({
      actions: [
        verbBulkAction<StockedRow>("moveTo", {
          id: "move",
          minSelection: 1,
          onExecute: async (selected) => {
            setDialog({
              type: "move",
              items: selected
                .map((r) => r.original)
                .filter((r): r is StockRow => r.kind === "stock"),
            });
            return { success: true };
          },
        }),
        verbBulkAction<StockedRow>("delete", {
          minSelection: 1,
          onExecute: async (selected) => {
            setDialog({
              type: "delete",
              items: selected
                .map((r) => r.original)
                .filter((r): r is StockRow => r.kind === "stock"),
            });
            return { success: true };
          },
        }),
        // Ported from `location-inventory-table`, which owns the same verb pair
        // over one room. That table is scoped to a single placement and so can
        // pick ONE verb from a prop; this one deliberately shows both
        // placements at once (the discriminator column is the whole point), so
        // each direction is its own action and `flipTo` filters the selection
        // rather than assuming it.
        //
        // Reaching this from the product side is what makes an install
        // recordable at all when you are working product-first — walking the
        // half-used roll of wire, or the fixture that went into the wall, from
        // the page that told you it was missing.
        verbBulkAction<StockedRow>("markInstalled", {
          id: "mark-installed",
          minSelection: 1,
          onExecute: (selected) => flipTo("installed", selected),
        }),
        verbBulkAction<StockedRow>("markAsStock", {
          id: "mark-stock",
          minSelection: 1,
          onExecute: (selected) => flipTo("stock", selected),
        }),
      ],
      clearSelectionOnComplete: false,
    }),
    [flipTo],
  );

  // Every row here is an entry for the ONE product this page is about, so the
  // subject is constant rather than read per row — the identity rows do not
  // even carry a product id. Memoized because it feeds a hook dependency
  // contract; a fresh literal rebuilds every column each render.
  const subject = useMemo(
    () => ({
      entity: "product" as const,
      resolve: () => ({
        entity: "product" as const,
        id: product.id,
        name: product.name,
      }),
    }),
    [product.id, product.name],
  );
  const { workbench } = useClientEntityList<StockedRow>({
    entity: "inventory",
    // This embedded relationship table owns placement-aware Inventory actions.
    includeCatalogActions: false,
    subject,
    data: rows,
    columns,
    tableStateOptions: EMBEDDED_TABLE_STATE,
    // Distinct column set from the /inventory index, so it needs its own
    // persisted View settings rather than sharing `table-columns:inventory`.
    layoutKey: "inventory:product-detail",
    bulkActions,
    rowIsEntity,
    extraActions: (entry) =>
      // An identity row has no InventoryEntry to move, discard or delete.
      // Unlinking is a location-side edit, so the menu points there instead of
      // offering a verb that would have nothing to act on.
      entry.kind !== "stock" ? null : (
        <>
          <VerbMenuItem
            verb="moveTo"
            onSelect={(event) => {
              event.stopPropagation();
              setDialog({ type: "move", items: [entry] });
            }}
          />
          <VerbMenuItem
            verb="delete"
            onSelect={(event) => {
              event.stopPropagation();
              setDialog({ type: "delete", items: [entry] });
            }}
          />
        </>
      ),
  });
  const { table } = workbench;

  if (rows.length === 0) {
    // A decomposed kit is not "stocked nowhere" — its shelf claim moved to its
    // parts. Saying otherwise here contradicts the hero stamp above and the Kit
    // Components table below, which is the same contradiction this file's
    // header records for bins in service.
    //
    // `componentCount` is embedded on the detail read, so the LABEL never
    // flashes the wrong answer; only the part names arrive with the query, and
    // that query is the one the Kit Components section already makes.
    if (product.componentCount > 0) {
      return (
        <ShelfEmpty
          entity="inventory"
          label="Not stocked under this name"
          detail={
            <HeldAsComponents productId={product.id} operations={operations} />
          }
        />
      );
    }
    return <ShelfEmpty entity="inventory" label="Not stocked anywhere" />;
  }

  const closeAndClear = () => {
    setDialog(CLOSED);
    table.resetRowSelection();
  };

  return (
    <>
      <Stack gap="md">
        {locationBreakdown && (
          <HierarchyDrilldown
            root={locationBreakdown}
            ariaLabel={`${product.name} location breakdown`}
          />
        )}

        <ListWorkbench
          model={workbench}
          ariaLabel={`${product.name} inventory`}
          mode="embedded"
        />
      </Stack>

      <MoveInventoryDialog
        open={dialog.type === "move"}
        onOpenChange={(open) => {
          if (!open) setDialog(CLOSED);
        }}
        items={dialog.type === "move" ? dialog.items : []}
        onSuccess={closeAndClear}
      />

      <DeleteInventoryDialog
        open={dialog.type === "delete"}
        onOpenChange={(open) => {
          if (!open) setDialog(CLOSED);
        }}
        items={dialog.type === "delete" ? dialog.items : []}
        onSuccess={closeAndClear}
      />
    </>
  );
};
