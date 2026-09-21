import {
  inventoryShortcode,
  locationShortcode,
  productShortcode,
} from "@cubby/schemas/identifiers";
import { projectStatusSchema } from "@cubby/schemas/project";
import { useState } from "react";
import { z } from "zod";

import { PROJECT_STATUS_OPTIONS } from "~/app/projects/project-options";
import { expenseCaptureRequest } from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";

import { useUpdateMutation } from "../hooks/useUpdateMutation";
import { ProductDiscardDialog } from "../products/product-discard-dialog";
import { SetFieldDialog } from "../tracker/set-field-dialog";
import { VerbMenuItem } from "./action-verb-ui";
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
const discardableProduct = z.object({
  id: productShortcode,
  name: z.string(),
  inventoryEntry: z.array(
    z.object({
      id: inventoryShortcode,
      amount: z.object({ value: z.number(), unit: z.string() }),
      location: z.object({ id: locationShortcode, name: z.string() }),
    }),
  ),
});
type DiscardableProduct = z.infer<typeof discardableProduct>;

function useDiscardProductAction(): EntityActionHandles {
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
      <ProductDiscardDialog
        open
        onOpenChange={(open) => {
          if (!open) setProduct(null);
        }}
        product={product}
      />
    ),
  };
}

const projectStatusRow = z.object({
  id: z.string(),
  name: z.string().nullish(),
  status: projectStatusSchema.optional(),
});

function useSetProjectStatusAction(): EntityActionHandles {
  const [items, setItems] = useState<
    Array<{ id: string; name: string; status: string | null }>
  >([]);
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("project", "update"),
    entity: "project",
  });
  const stage = (rows: readonly EntityActionRow[]) => {
    setItems(
      rows.map((row) => {
        const parsed = projectStatusRow.safeParse(row);
        return {
          id: row.id,
          name: row.name || row.id,
          status: parsed.success ? (parsed.data.status ?? null) : null,
        };
      }),
    );
  };
  return {
    run: async (rows) => {
      stage(rows);
      return { success: rows.length > 0 };
    },
    rowMenuItem: (row) => (
      <VerbMenuItem
        verb="setStatus"
        onSelect={(event) => {
          event.stopPropagation();
          stage([row]);
        }}
      />
    ),
    dialog: items.length > 0 && (
      <SetFieldDialog
        open
        onOpenChange={(open) => {
          if (!open) setItems([]);
        }}
        items={items}
        options={PROJECT_STATUS_OPTIONS}
        fieldLabel="Status"
        itemNoun="Project"
        currentValue={(item) => item.status}
        isPending={update.isPending}
        onConfirm={async (value) => {
          const status = projectStatusSchema.parse(value);
          for (const item of items) {
            await update.mutateAsync({ id: item.id, data: { status } });
          }
          setItems([]);
        }}
      />
    ),
  };
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
] as const;
