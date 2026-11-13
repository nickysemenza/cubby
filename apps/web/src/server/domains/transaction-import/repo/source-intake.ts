import type { ActorContext } from "@cubby/schemas/context";
import type { RecordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";

import type { Database } from "~/server/db";
import {householdWrite} from "~/server/kernel/api";
import {withTransaction} from "~/server/db/helpers";
import { planSourceIntake } from "~/server/domains/transaction-import/policy/source-intake-plan";

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
  const result = await householdWrite(
    db,
    async (database) => withTransaction(database,async tx => {
      const loaded = await lockAndLoadSourceIntake(tx, input, prepared);
      const plan = planSourceIntake(input, prepared, loaded);
      if (input.dryRun) return plan.receipt;
      return applySourceIntake(tx, actor, plan);
    }),
  );
  const { occurrenceCodes: _occurrenceCodes, ...receipt } = result;
  return receipt;
}
