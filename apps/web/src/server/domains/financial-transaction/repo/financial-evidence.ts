import {moneyToMinor} from "@cubby/shared";
import {createAppError} from "~/server/errors/app-error";

/** Legacy evidence doubles must refuse through the financial constraint boundary. */
export const financialEvidenceAmountMinor = (amount: number): bigint => {
  try {
    return moneyToMinor(amount);
  } catch {
    // SILENT: Replace the low-level conversion error with the owning financial constraint.
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Financial evidence amount must be an exact, supported whole-cent amount.",
    );
  }
};
