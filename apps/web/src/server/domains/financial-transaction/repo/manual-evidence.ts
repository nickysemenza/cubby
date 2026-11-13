import type { ActorContext } from "@cubby/schemas/context";
import type { FinancialTransactionCreateInput } from "@cubby/schemas/financial-transaction";

import type { Database } from "~/server/db/database";
import { manualEntry } from "~/server/db/kernel-schema";
import { append, defineEvidence, evidenceRow } from "~/server/kernel/api";
import { jsonSnapshot } from "~/server/lib/canonical-json";

export const manualTransactionEvidence = defineEvidence({
  kind: "manualEntry",
  table: manualEntry,
  keys: (row) => [`manual:${row.id}`],
  discovers: (row) => [{ kind: "bankEvent", key: `manual:${row.id}` }],
  owner: (row) => row.userId,
});

export function appendManualTransactions(
  db: Database,
  inputs: readonly { input: FinancialTransactionCreateInput; id?: string }[],
  actor: ActorContext,
) {
  return append(
    db,
    inputs.map(({ input, id }) =>
      evidenceRow(manualTransactionEvidence, {
        id,
        entity: "financialTransaction",
        userId: actor.userId,
        payload: jsonSnapshot.parse(input),
      }),
    ),
  );
}
