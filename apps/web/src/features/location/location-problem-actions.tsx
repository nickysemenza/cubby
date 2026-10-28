import { locationShortcode } from "@cubby/schemas/identifiers";

import {
  WorkActionDialogTrigger,
  WorkActionLink,
  WorkActionTrigger,
  type WorkActionProps,
} from "~/entity/work-queue/work-actions";
import { AddInventoryDialog } from "~/features/inventory/add-inventory-dialog";
import { useBackfill } from "~/features/maintenance/backfill-button";
import { BACKFILL } from "~/features/maintenance/backfill-registry";

/** `emptyLocations:add-inventory`: itemize the row's Location. */
export function AddInventoryAction({
  action,
  target,
}: WorkActionProps<"item">) {
  const parsed = locationShortcode.safeParse(target.row.id);
  if (!parsed.success) return null;
  return (
    <WorkActionDialogTrigger action={action}>
      {(close) => (
        <AddInventoryDialog
          open
          onOpenChange={(open) => !open && close()}
          locationId={parsed.data}
          locationName={target.row.name}
          onSuccess={() => undefined}
        />
      )}
    </WorkActionDialogTrigger>
  );
}

/** `locationsWithoutAiDescription:analyze-all`: enqueue photo analysis. */
export function AnalyzeLocationsAction(props: WorkActionProps) {
  const backfill = useBackfill(BACKFILL.analyzeDescriptions);
  return (
    <WorkActionTrigger
      {...props}
      pending={backfill.running}
      onRun={backfill.start}
    />
  );
}

/**
 * `start-recount`: recounting happens in the native app, so the flow opens
 * the record (a Location, or the Inventory entry whose Location to recount).
 */
export function StartRecountAction({
  action,
  target,
}: WorkActionProps<"item">) {
  if (!target.row.id) return null;
  return <WorkActionLink action={action} href={`/${target.row.id}`} />;
}
