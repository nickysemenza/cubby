import { bankEvent } from "~/server/domains/financial-transaction/repo/bank-event";
import { manualTransactionEvidence } from "~/server/domains/financial-transaction/repo/manual-evidence";
import { purchaseEvent } from "~/server/domains/financial-transaction/repo/purchase-event";
import { defineModule } from "~/server/kernel/api";

export const financialTransactionKernelModule = defineModule({
  name: "financialTransaction",
  entities: ["financialTransaction", "purchase", "expense"],
  evidence: [manualTransactionEvidence],
  reconcilers: [bankEvent, purchaseEvent],
  machinery: [
    {
      entity: "financialTransaction",
      owning: "bankEvent",
      scopes: ["purchaseEvent"],
      fields: false,
      quality: false,
    },
    {
      entity: "purchase",
      owning: "purchaseEvent",
      fields: false,
      quality: false,
    },
    {
      entity: "expense",
      owning: "purchaseEvent",
      fields: false,
      quality: false,
    },
  ],
});
