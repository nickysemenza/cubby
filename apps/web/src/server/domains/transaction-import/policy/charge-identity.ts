export type ChargeRef = { source: string; chargeKey: string };

/** Stable statement identity shared by individual and transfer-pair proposals. */
export const chargeId = (charge: ChargeRef): string =>
  `${charge.source}:${charge.chargeKey}`;
