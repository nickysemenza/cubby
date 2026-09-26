import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { FolderSimplePlusIcon } from "@phosphor-icons/react/dist/csr/FolderSimplePlus";
import { useState } from "react";
import { match } from "ts-pattern";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityReferencePicker } from "~/app/_components/combobox/entity-reference-picker";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { DialogFormActions } from "~/components/ui/dialog-form-actions";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";

import { isValidItemDrop, isValidLocationDrop } from "./arrange-tree-utils";
import type { ItemDragData } from "./arrange-types";
import { useArrangeMutations } from "./use-arrange-mutations";

/**
 * What a "Move to…" trigger moves — the same two shapes the drag payloads in
 * `arrange-types` carry, so both paths hand identical arguments to identical
 * mutations. Only the location arm needs `roots` (its cycle/no-op guard does).
 */
export type ArrangeMoveTarget =
  | {
      kind: "location";
      locationId: LocationShortcode;
      name: string;
      roots: InfLocation[];
    }
  | { kind: "item"; drag: ItemDragData; name: string; roots: InfLocation[] };

/**
 * The pointer-free way to move something on the arrange surface.
 * A pointer-free alternative to drag and drop, useful for deliberate moves and
 * whenever a destination is easier to search than reach spatially.
 */
export function ArrangeMoveTo({ target }: { target: ArrangeMoveTarget }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Move ${target.name}`}
              className="shrink-0 text-muted-foreground"
              onClick={(event) => {
                event.stopPropagation();
                setOpen(true);
              }}
            />
          }
        >
          <FolderSimplePlusIcon />
        </TooltipTrigger>
        <TooltipContent>Move to…</TooltipContent>
      </Tooltip>
      {open && <MoveToDialog target={target} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Mounted only while open, so the per-row trigger costs nothing until used and
 * the location search stays off the surface's critical path. Commits through
 * the same mutation handlers as drag-and-drop, so optimistic tree surgery,
 * rollback and invalidation are identical.
 */
function MoveToDialog({
  target,
  onClose,
}: {
  target: ArrangeMoveTarget;
  onClose: () => void;
}) {
  const { moveLocation, moveItem } = useArrangeMutations();
  const [destination, setDestination] =
    useState<ComboboxItem<LocationShortcode> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The real Home location is the top-level destination. Same validity guards
  // the drop monitor re-checks before firing.
  const commit = (destinationId: LocationShortcode | null) => {
    const moved = match(target)
      .with({ kind: "location" }, (t) => {
        if (!isValidLocationDrop(t.roots, t.locationId, destinationId))
          return false;
        moveLocation(t.locationId, destinationId);
        return true;
      })
      .with({ kind: "item" }, (t) => {
        if (
          destinationId === null ||
          !isValidItemDrop(t.roots, t.drag.sourceLocationId, destinationId)
        )
          return false;
        moveItem(t.drag, destinationId);
        return true;
      })
      .exhaustive();

    if (!moved) {
      setError("Pick a different destination — that move isn't allowed.");
      return;
    }
    onClose();
  };

  return (
    <ResponsiveDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`Move ${target.name}`}
      description={
        target.kind === "location"
          ? "Choose the location this becomes a sublocation of."
          : "Choose the location to move this item to."
      }
      footer={
        <DialogFormActions
          onCancel={onClose}
          submitLabel="Move"
          error={error}
          submitDisabled={destination === null}
          onSubmit={() => destination && commit(destination.id)}
        />
      }
    >
      <Stack gap="md">
        {/* Lives in the body, not the footer: the phone sheet promotes the
            footer's Cancel/Move into its header and hides the footer, which
            would take this shortcut with it. */}
        {target.kind === "location" && (
          <Button
            variant="outline"
            disabled={!target.roots[0]}
            onClick={() => {
              const home = target.roots[0];
              if (home) commit(home.id);
            }}
          >
            Move to Home
          </Button>
        )}
        <EntityReferencePicker
          entity="location"
          label="location"
          mapItems={(items) =>
            items.map((item) => {
              const valid =
                target.kind === "location"
                  ? isValidLocationDrop(
                      target.roots,
                      target.locationId,
                      item.id,
                    )
                  : isValidItemDrop(
                      target.roots,
                      target.drag.sourceLocationId,
                      item.id,
                    );
              return valid
                ? item
                : {
                    ...item,
                    presentation: {
                      ...item.presentation,
                      group: {
                        id: "unavailable",
                        label: "Unavailable",
                        order: 99,
                      },
                      disabledReason:
                        target.kind === "location"
                          ? "A location cannot move into itself or its descendants"
                          : "Already the current location",
                    },
                  };
            })
          }
          value={destination}
          setValue={(item) => {
            setDestination(item);
            setError(null);
          }}
        />
      </Stack>
    </ResponsiveDialog>
  );
}
