import {
  emailState,
  emailPredictionEvidence,
} from "~/server/domains/email/repo/email-state";
import {
  emailEvidence,
  mailOriginalEvidence,
  orderEvidence,
  retainedPaymentEvidence,
} from "~/server/domains/purchase-import/repo/order-evidence";
import { defineModule } from "~/server/kernel/api";

export const orderKernelModule = defineModule({
  name: "orders",
  entities: ["email"],
  reconcilers: [emailState],
  evidence: [
    emailEvidence,
    emailPredictionEvidence,
    mailOriginalEvidence,
    orderEvidence,
    retainedPaymentEvidence,
  ],
});
