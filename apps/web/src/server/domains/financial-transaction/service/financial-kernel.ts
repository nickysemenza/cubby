import {
  bankEvent,
  statementKindAsk,
} from "~/server/domains/financial-transaction/repo/bank-event";
import { manualTransactionEvidence } from "~/server/domains/financial-transaction/repo/manual-evidence";
import { defineModule } from "~/server/kernel/api";

export const financialTransactionKernelModule = defineModule({
  name: "financialTransaction",
  entities: ["financialTransaction"],
  evidence: [manualTransactionEvidence],
  asks: [statementKindAsk],
  reconcilers: [bankEvent],
  machinery: [
    {
      entity: "financialTransaction",
      owning: "bankEvent",
      fields: false,
      quality: false,
    },
  ],
});
