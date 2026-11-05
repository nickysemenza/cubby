import { z } from "zod";

export const correctionAuthorityReceiptKinds = z.enum([
  "assessment_application",
  "saved_field",
]);
export const CORRECTION_OUTCOME_RECEIPT_KIND = "assessment_correction";
