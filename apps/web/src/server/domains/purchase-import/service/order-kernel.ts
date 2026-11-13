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
  evidence: [
    emailEvidence,
    mailOriginalEvidence,
    orderEvidence,
    retainedPaymentEvidence,
  ],
});
