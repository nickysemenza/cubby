import type { ActorContext } from "@cubby/schemas/context";
import type { RecordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";

import type { Database } from "~/server/db";
import { withSnapshotWrite } from "~/server/db/helpers";

import { planSourceIntake, planIntakeReceipt } from "./source-intake-plan";
import {
  prepareRows,
  lockAndLoadSourceIntake,
  applySourceIntake,
} from "./source-intake-stages";

export async function recordSourceTransactionRecords(
  db: Database,
  input: RecordSourceTransactionRecordsInput,
  actor: ActorContext,
) {
  const prepared = await prepareRows(input);
  const result = await withSnapshotWrite(
    db,
    async (tx) => {
      const loaded = await lockAndLoadSourceIntake(tx, input, prepared);
      const plan = planSourceIntake({ prepared, ...loaded });
      const receipt = planIntakeReceipt(input, loaded, plan);
      if (input.dryRun) return receipt;
      return applySourceIntake(
        tx,
        input,
        actor,
        prepared,
        loaded,
        plan,
        receipt,
      );
    },
    { isolationLevel: "serializable" },
  );
  const { occurrenceCodes, ...receipt } = result;
  const { reconcileRecordedFinancialEvidence } =
    await import("./statement-evidence-correction");
  return {
    ...receipt,
    correctionReviews: input.dryRun
      ? []
      : await reconcileRecordedFinancialEvidence(
          db,
          input.import.source,
          occurrenceCodes,
          actor,
        ),
  };
}
