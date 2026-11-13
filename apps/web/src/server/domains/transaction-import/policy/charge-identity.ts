import type { StatementSuggestionOut } from "@cubby/schemas/statement-suggestion";

export type ChargeRef = Pick<StatementSuggestionOut, "source" | "chargeKey">;

/** Stable statement identity shared by individual and transfer-pair proposals. */
export const chargeId = (charge: ChargeRef): string =>
  `${charge.source}:${charge.chargeKey}`;
