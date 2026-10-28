import { productListItemOut } from "@cubby/schemas/entities/product";
import {
  productShortcode,
  inventoryShortcode,
  locationShortcode,
} from "@cubby/schemas/identifiers";
import { useQueryClient } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { z } from "zod";

import {
  detailEditRequest,
  expenseCaptureRequest,
} from "~/entity/editing/editor-requests";
import {
  EntityEditDialog,
  type EntityEditDialogRequest,
} from "~/entity/editing/entity-edit-dialog";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { featureRegistry } from "~/entity/feature-registry";

import { useUpdateMutation } from "../hooks/use-update-mutation";
import { PRODUCT_DISCARD_READ_FIELDS } from "./action-read-fields";
import { VerbMenuItem } from "./action-verb-ui";
import { useBulkEditEntityAction } from "./bulk-edit-entity-action";
import { defineEntityAction } from "./entity-action-definition";
import type {
  EntityActionHandles,
  EntityActionResolutionContext,
  EntityActionRow,
} from "./entity-actions";

/**
 * The verbs the entity declarations name in `detail.hero.actions` /
 * `list.actions` that no other registry module carries. Each handler is the
 * dialog the bespoke detail page used to open by hand; the registry is what
 * lets the generic page (and the list bar) offer them from one place.
 */

const singleRow = (rows: readonly EntityActionRow[]) =>
  rows.length === 1 ? rows[0] : undefined;

/** "Record sale" is a disposition expense capture seeded with the product. */
function useRecordSaleAction(): EntityActionHandles {
  const [productId, setProductId] = useState<string | null>(null);
  const stage = (row: EntityActionRow) => {
    const parsed = productShortcode.safeParse(row.id);
    if (parsed.success) setProductId(parsed.data);
    return parsed.success;
  };
  return {
    run: async (rows) => {
      const row = singleRow(rows);
      return { success: row !== undefined && stage(row) };
    },
    rowMenuItem: (row) => (
      <VerbMenuItem
        verb="recordSale"
        onSelect={(event) => {
          event.stopPropagation();
          stage(row);
        }}
      />
    ),
    dialog: productId !== null && (
      <EntityEditDialog
        open
        onOpenChange={(open) => {
          if (!open) setProductId(null);
        }}
        request={expenseCaptureRequest({
          // SAFETY: parsed by `productShortcode` when staged.
          productId: productId as never,
          disposition: true,
        })}
      />
    ),
  };
}

/**
 * A product detail record carries its own shelves, which is what the
 * discard dialog needs to ask "which shelf?". A row without them (a list
 * row, a foreign subject) gets no verb rather than a dialog that cannot
 * answer that question.
 */
const discardableProduct = productListItemOut.pick({
  id: true,
  name: true,
  inventoryEntry: true,
});
type DiscardableProduct = z.infer<typeof discardableProduct>;

function useDiscardProductAction(): EntityActionHandles {
  const { ProductDiscardDialog } = featureRegistry().components;
  const [product, setProduct] = useState<DiscardableProduct | null>(null);
  // An unstocked product still discards: the dialog records a ledger-only exit
  // when `inventoryEntry` is empty, which is the post-import "don't have this
  // anymore" case. Gating on a non-empty shelf list hid the verb exactly there.
  const parse = (row: EntityActionRow) => {
    const parsed = discardableProduct.safeParse(row);
    return parsed.success ? parsed.data : null;
  };
  return {
    run: async (rows) => {
      const row = singleRow(rows);
      const parsed = row ? parse(row) : null;
      if (parsed) setProduct(parsed);
      return { success: parsed !== null };
    },
    availability: ({ rows }: EntityActionResolutionContext) => {
      const row = singleRow(rows);
      return row && parse(row) ? { status: "available" } : { status: "hidden" };
    },
    rowMenuItem: (row) => {
      const parsed = parse(row);
      if (!parsed) return null;
      return (
        <VerbMenuItem
          verb="discard"
          onSelect={(event) => {
            event.stopPropagation();
            setProduct(parsed);
          }}
        />
      );
    },
    dialog: product !== null && (
      <Suspense fallback={null}>
        <ProductDiscardDialog
          open
          onOpenChange={(open) => {
            if (!open) setProduct(null);
          }}
          product={product}
        />
      </Suspense>
    ),
  };
}

/** A focused status action over the shared atomic bulk mutation. */
function useSetProjectStatusAction(): EntityActionHandles {
  return useBulkEditEntityAction("project", {
    verb: "setStatus",
    fields: ["status"],
  });
}

const wishRow = z.object({
  id: z.string(),
  acquiredAt: z.union([z.string(), z.date()]).nullish(),
});

/** A wish's "Mark purchased" toggles `acquired`; already-acquired rows flip back. */
function useMarkWishPurchasedAction(): EntityActionHandles {
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("wish", "update"),
    entity: "wish",
  });
  const toggle = async (row: EntityActionRow) => {
    const parsed = wishRow.safeParse(row);
    if (!parsed.success) return false;
    await update.mutateAsync({
      id: row.id,
      data: { acquired: !parsed.data.acquiredAt },
    });
    return true;
  };
  return {
    run: async (rows) => {
      const results = await Promise.all(rows.map(toggle));
      return { success: results.every(Boolean) };
    },
    rowMenuItem: (row) => (
      <VerbMenuItem
        verb="markPurchased"
        onSelect={(event) => {
          event.stopPropagation();
          void toggle(row);
        }}
      />
    ),
    dialog: null,
  };
}

const openTaskRow = z.object({
  id: z.string(),
  status: z.string().nullish(),
});

/** A task's "Complete" sets status to done; a done task offers nothing. */
function useCompleteTaskAction(): EntityActionHandles {
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("task", "update"),
    entity: "task",
  });
  const open = (row: EntityActionRow) => {
    const parsed = openTaskRow.safeParse(row);
    return parsed.success && parsed.data.status !== "done";
  };
  const complete = async (row: EntityActionRow) => {
    if (!open(row)) return false;
    await update.mutateAsync({ id: row.id, data: { status: "done" } });
    return true;
  };
  return {
    run: async (rows) => {
      const results = await Promise.all(rows.map(complete));
      return { success: results.every(Boolean) };
    },
    availability: ({ rows }: EntityActionResolutionContext) =>
      rows.length > 0 && rows.every(open)
        ? { status: "available" }
        : { status: "hidden" },
    rowMenuItem: (row) =>
      open(row) ? (
        <VerbMenuItem
          verb="complete"
          onSelect={(event) => {
            event.stopPropagation();
            void complete(row);
          }}
        />
      ) : null,
    dialog: null,
  };
}

/** The inventory editor's seed reads the nested product and location. */
const adjustableInventory = z.object({
  id: inventoryShortcode,
  product: z.object({ id: productShortcode }),
  location: z.object({ id: locationShortcode }),
});

/**
 * "Adjust amount" is the entry editor scoped to its amount: a deliberate
 * correction, not a recount, so it never stamps `verifiedAt`.
 */
function useAdjustInventoryAmountAction(): EntityActionHandles {
  const queryClient = useQueryClient();
  const [entry, setEntry] = useState<EntityActionRow | null>(null);
  const stage = (row: EntityActionRow) => {
    const adjustable = adjustableInventory.safeParse(row).success;
    if (adjustable) setEntry(row);
    return adjustable;
  };
  return {
    run: async (rows) => {
      const row = singleRow(rows);
      return { success: row !== undefined && stage(row) };
    },
    availability: ({ rows }: EntityActionResolutionContext) => {
      const row = singleRow(rows);
      return row && adjustableInventory.safeParse(row).success
        ? { status: "available" }
        : { status: "hidden" };
    },
    rowMenuItem: (row) =>
      adjustableInventory.safeParse(row).success ? (
        <VerbMenuItem
          verb="adjustAmount"
          onSelect={(event) => {
            event.stopPropagation();
            stage(row);
          }}
        />
      ) : null,
    dialog: entry !== null && (
      <EntityEditDialog
        open
        onOpenChange={(open) => {
          if (!open) setEntry(null);
        }}
        // SAFETY: `adjustableInventory` proved the nested product and location
        // the inventory request seeds from; the registry validates the rest.
        request={
          detailEditRequest(
            queryClient,
            "inventory",
            entry as never,
            "amount",
          ) as EntityEditDialogRequest<"inventory">
        }
      />
    ),
  };
}

export const declaredEntityActionDefinitions = [
  defineEntityAction({
    verb: "recordSale",
    entities: ["product"],
    arity: "single",
    surfaces: ["row", "inspector", "detail"],
    group: "lifecycle",
    priority: 50,
    use: useRecordSaleAction,
  }),
  defineEntityAction({
    id: "discard-product",
    readFields: PRODUCT_DISCARD_READ_FIELDS,
    verb: "discard",
    entities: ["product"],
    arity: "single",
    surfaces: ["row", "inspector", "detail"],
    group: "lifecycle",
    priority: 60,
    use: useDiscardProductAction,
  }),
  defineEntityAction({
    id: "set-project-status",
    verb: "setStatus",
    entities: ["project"],
    arity: "both",
    group: "organize",
    priority: 200,
    use: useSetProjectStatusAction,
  }),
  defineEntityAction({
    id: "mark-wish-purchased",
    verb: "markPurchased",
    entities: ["wish"],
    arity: "both",
    group: "primary",
    priority: 50,
    use: useMarkWishPurchasedAction,
  }),
  defineEntityAction({
    id: "complete-task",
    verb: "complete",
    entities: ["task"],
    arity: "both",
    surfaces: ["row", "selection", "inspector", "detail"],
    group: "primary",
    priority: 40,
    use: useCompleteTaskAction,
  }),
  defineEntityAction({
    id: "adjust-inventory-amount",
    verb: "adjustAmount",
    entities: ["inventory"],
    arity: "single",
    surfaces: ["row", "inspector", "detail"],
    group: "organize",
    priority: 90,
    use: useAdjustInventoryAmountAction,
  }),
] as const;
