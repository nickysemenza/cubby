import { statementTransactionApplication } from "@cubby/schemas/statement-suggestion";
import { isEqual } from "es-toolkit";

import type { Review } from "~/server/generic/suggestions/repo/review";

export function validateStatementCorrection(input: Review) {
  if (
    input.correction.present &&
    !isEqual(
      statementTransactionApplication.parse(input.correction.value),
      input.application,
    )
  )
    throw new Error(
      "A corrected Transaction suggestion must apply the corrected action",
    );
}
