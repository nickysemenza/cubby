/**
 * The synthetic order the live import journey must land as a Purchase. Kept
 * free of imports: the Tester Army config reads it without loading the app
 * server (see scripts/tester-army-startup.test.ts).
 */
export const IMPORT_AGENT_ORDER = {
  vendor: "Synthetic Seed Supply",
  orderId: "SYN-CONFIRM-LIVE-1",
  item: "Herb packet",
  totalCents: 500,
} as const;
