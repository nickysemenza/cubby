import { manualTransactionEvidence } from "~/server/domains/financial-transaction/repo/manual-evidence";
import {
  occurrenceEvidence,
  statementEvidence,
} from "~/server/domains/transaction-import/repo/statement-evidence";
import { defineModule } from "~/server/kernel/api";

export const statementKernelModule = defineModule({
  name: "statement",
  evidence: [occurrenceEvidence, statementEvidence, manualTransactionEvidence],
});
