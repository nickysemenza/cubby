import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { FolderSimplePlusIcon } from "@phosphor-icons/react/dist/csr/FolderSimplePlus";
import { useState } from "react";
import { match } from "ts-pattern";

import { LocationMoveDialog } from "~/features/locations/location-move-dialog";
import { Button } from "~/ui/primitives/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

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

const REFUSED = "Pick a different destination — that move isn't allowed.";

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
 * Commits through the same mutation handlers as drag-and-drop, so optimistic
 * tree surgery, rollback and invalidation are identical. The real Home
 * location is the top-level destination; the validity guards are the ones the
 * drop monitor re-checks before firing.
 */
function MoveToDialog({
  target,
  onClose,
}: {
  target: ArrangeMoveTarget;
  onClose: () => void;
}) {
  const { moveLocation, moveItem } = useArrangeMutations();

  const isValid = (destinationId: LocationShortcode) =>
    target.kind === "location"
      ? isValidLocationDrop(target.roots, target.locationId, destinationId)
      : isValidItemDrop(
          target.roots,
          target.drag.sourceLocationId,
          destinationId,
        );

  return (
    <LocationMoveDialog
      title={`Move ${target.name}`}
      description={
        target.kind === "location"
          ? "Choose the location this becomes a sublocation of."
          : "Choose the location to move this item to."
      }
      submitLabel="Move"
      onClose={onClose}
      shortcut={
        target.kind === "location"
          ? { label: "Move to Home", locationId: target.roots[0]?.id }
          : undefined
      }
      disabledReason={(id) =>
        isValid(id)
          ? null
          : target.kind === "location"
            ? "A location cannot move into itself or its descendants"
            : "Already the current location"
      }
      onConfirm={(destinationId) =>
        match(target)
          .with({ kind: "location" }, (t) => {
            if (!isValidLocationDrop(t.roots, t.locationId, destinationId))
              return REFUSED;
            moveLocation(t.locationId, destinationId);
            return null;
          })
          .with({ kind: "item" }, (t) => {
            if (!isValid(destinationId)) return REFUSED;
            moveItem(t.drag, destinationId);
            return null;
          })
          .exhaustive()
      }
    />
  );
}
