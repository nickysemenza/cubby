/** Initial repair and deployment successors share one provider retention policy. */
export const SEARCH_INDEX_REPAIR_RETENTION = {
  successRetention: "1 day",
  errorRetention: "7 days",
} as const;
