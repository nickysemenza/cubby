import { RecordProposals } from "~/entity/suggestions/queue/record-proposals";
import {
  WorkActionDialogTrigger,
  type WorkActionProps,
} from "~/entity/work-queue/work-actions";
import { Overlay } from "~/ui/overlays/overlay";

/** Transfer review uses the same stored Suggestions as the record and queue. */
export function TransferPairAction({ action, target }: WorkActionProps) {
  const transactionId = target.scope === "item" ? target.row.id : null;
  if (!transactionId) return null;
  return (
    <WorkActionDialogTrigger action={action}>
      {(close) => (
        <Overlay
          open
          onOpenChange={(open) => !open && close()}
          title="Pair transfer"
          size="lg"
          cancelLabel="Done"
        >
          <RecordProposals id={transactionId} />
        </Overlay>
      )}
    </WorkActionDialogTrigger>
  );
}
