import {
  WorkActionLink,
  WorkActionTrigger,
  type WorkActionProps,
} from "~/entity/work-queue/work-actions";
import { useBackfill } from "~/features/maintenance/backfill-button";
import { BACKFILL } from "~/features/maintenance/backfill-registry";

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
