import {
  type LocationListItemOut,
  locationListItemOut,
  locationOut,
} from "@cubby/schemas/location";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import {
  type InventoryDialogItem,
  inventoryDialogItemSchema,
} from "../inventory/dialog-item";
import { MoveInventoryDialog } from "../inventory/move-inventory-dialog";
import { BulkReparentLocationsDialog } from "../locations/bulk-reparent-locations-dialog";
import { typeSupportsQrCode } from "../locations/location-type-theme";
import { VerbMenuItem } from "./action-verb-ui";
import { defineEntityAction } from "./entity-action-definition";
import type { EntityActionHandles, EntityActionRow } from "./entity-actions";
import { useStagedDialogAction } from "./use-staged-dialog-action";

const asInventoryItem = (row: EntityActionRow): InventoryDialogItem | null => {
  const parsed = inventoryDialogItemSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
};

const asLocationItem = (row: EntityActionRow): LocationListItemOut | null => {
  const parsed = locationListItemOut.safeParse(row);
  return parsed.success ? parsed.data : null;
};

function useMoveInventoryEntityAction(): EntityActionHandles {
  const staged = useStagedDialogAction(asInventoryItem);

  return {
    run: staged.stage,
    availability: ({ rows }) =>
      rows.length > 0 && rows.every((row) => asInventoryItem(row) !== null)
        ? { status: "available" }
        : { status: "hidden" },
    rowMenuItem: (row) => {
      const item = asInventoryItem(row);
      if (!item) return null;
      return (
        <VerbMenuItem
          verb="moveTo"
          onSelect={(event) => {
            event.stopPropagation();
            void staged.stage([item]);
          }}
        />
      );
    },
    dialog: (
      <MoveInventoryDialog
        open={staged.items.length > 0}
        onOpenChange={(open) => {
          if (!open) staged.finish(false);
        }}
        items={staged.items}
        onSuccess={() => staged.finish(true)}
      />
    ),
  };
}

const QR_UNAVAILABLE = "Rooms and areas do not support QR labels.";

function usePrintLocationLabelsAction(): EntityActionHandles {
  const navigate = useNavigate();
  const availability: EntityActionHandles["availability"] = useCallback(
    ({ rows }) => {
      const parsed = rows.map((row) => locationOut.safeParse(row));
      if (parsed.some((result) => !result.success)) {
        return { status: "hidden" };
      }
      return parsed.every(
        (result) => result.success && typeSupportsQrCode(result.data.type),
      )
        ? { status: "available" }
        : { status: "disabled", reason: QR_UNAVAILABLE };
    },
    [],
  );
  const run = useCallback(
    async (rows: readonly EntityActionRow[]) => {
      const context = {
        entity: "location" as const,
        surface: "selection" as const,
        rows,
      };
      if (availability?.(context).status !== "available") {
        return { success: false };
      }
      await navigate({
        to: "/labels",
        search: { codes: rows.map((row) => row.id).join(",") },
      });
      return { success: true };
    },
    [availability, navigate],
  );

  return {
    run,
    availability,
    rowMenuItem: (row) => {
      const parsed = locationOut.safeParse(row);
      if (!parsed.success) return null;
      const disabledReason = typeSupportsQrCode(parsed.data.type)
        ? undefined
        : QR_UNAVAILABLE;
      return (
        <VerbMenuItem
          verb="printLabel"
          disabledReason={disabledReason}
          onSelect={() => void run([row])}
        />
      );
    },
    dialog: null,
  };
}

function useMoveLocationUnderAction(): EntityActionHandles {
  const staged = useStagedDialogAction(asLocationItem);
  return {
    run: staged.stage,
    availability: ({ rows }) =>
      rows.length > 0 && rows.every((row) => asLocationItem(row) !== null)
        ? { status: "available" }
        : { status: "hidden" },
    rowMenuItem: (row) => {
      const item = asLocationItem(row);
      if (!item) return null;
      return (
        <VerbMenuItem
          verb="moveUnder"
          onSelect={(event) => {
            event.stopPropagation();
            void staged.stage([item]);
          }}
        />
      );
    },
    dialog: (
      <BulkReparentLocationsDialog
        open={staged.items.length > 0}
        onOpenChange={(open) => {
          if (!open) staged.finish(false);
        }}
        locations={staged.items}
        onSuccess={() => staged.finish(true)}
      />
    ),
  };
}

export const inventoryLocationEntityActionDefinitions = [
  defineEntityAction({
    id: "move-inventory",
    verb: "moveTo",
    entities: ["inventory"],
    arity: "both",
    surfaces: ["row", "selection", "inspector", "detail"],
    group: "organize",
    priority: 100,
    use: useMoveInventoryEntityAction,
  }),
  defineEntityAction({
    id: "print-location-labels",
    verb: "printLabel",
    entities: ["location"],
    arity: "both",
    surfaces: ["row", "selection", "inspector", "detail"],
    group: "organize",
    priority: 100,
    placement: { inspector: "overflow", detail: "overflow" },
    preserveSelection: true,
    use: usePrintLocationLabelsAction,
  }),
  defineEntityAction({
    id: "move-location-under",
    verb: "moveUnder",
    entities: ["location"],
    arity: "both",
    surfaces: ["row", "selection"],
    group: "organize",
    priority: 200,
    use: useMoveLocationUnderAction,
  }),
] as const;
