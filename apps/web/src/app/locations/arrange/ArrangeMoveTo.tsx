import type { LocationId } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { FolderInput } from "lucide-react";
import { useState } from "react";
import { match } from "ts-pattern";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import { WithLocationSearch } from "~/app/_components/combobox/with-search-hook";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { StatusText } from "~/components/ui/status-text";
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
      locationId: LocationId;
      name: string;
      roots: InfLocation[];
    }
  | { kind: "item"; drag: ItemDragData; name: string };

/**
 * The pointer-free way to move something on the arrange surface.
 * pragmatic-drag-and-drop is HTML5-drag-only, so on iOS Safari nothing here is
 * draggable at all — this picker is the move affordance there, and the keyboard
 * path everywhere else. Desktop drag stays primary; this is a quiet icon button.
 */
export function ArrangeMoveTo({ target }: { target: ArrangeMoveTarget }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Move ${target.name}`}
        className="shrink-0 text-muted-foreground"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <FolderInput />
      </Button>
      {open && <MoveToDialog target={target} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Mounted only while open, so the per-row trigger costs nothing until used and
 * the location search stays off the surface's critical path. Commits through
 * the very `moveLocation` / `moveItem` handlers `useArrangeDnd`'s drop monitor
 * calls, so optimistic tree surgery, rollback and invalidation are identical.
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
    useState<ComboboxItem<LocationId> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `null` destination = top level ("Home"), the drop target the breadcrumbs
  // expose. Same validity guards the drop monitor re-checks before firing.
  const commit = (destinationId: LocationId | null) => {
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
          !isValidItemDrop(t.drag.sourceLocationId, destinationId)
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
    >
      <Stack gap="md">
        <WithLocationSearch>
          {({ items, onSearchChange, isLoading, onOpenChange }) => (
            <EntityPicker
              entity="location"
              label="location"
              items={items}
              onSearchChange={onSearchChange}
              isLoading={isLoading}
              onOpenChange={onOpenChange}
              value={destination}
              setValue={(item) => {
                setDestination(item);
                setError(null);
              }}
            />
          )}
        </WithLocationSearch>

        {error && (
          <StatusText as="div" tone="destructive" className="text-sm">
            {error}
          </StatusText>
        )}

        <Row justify="end" gap="sm" wrap>
          {target.kind === "location" && (
            <Button variant="outline" onClick={() => commit(null)}>
              Move to top level
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={destination === null}
            onClick={() => destination && commit(destination.id)}
          >
            Move
          </Button>
        </Row>
      </Stack>
    </ResponsiveDialog>
  );
}
