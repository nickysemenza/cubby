import {
  occurrenceEvidence,
  statementEvidence,
} from "~/server/domains/transaction-import/repo/statement-evidence";
import { defineModule } from "~/server/kernel/api";

export const statementKernelModule = defineModule({
  name: "statement",
  entities: ["sourceOccurrence", "sourceTransactionRecord"],
  evidence: [occurrenceEvidence, statementEvidence],
});
