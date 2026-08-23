import type { SearchDocumentMaintenance } from "@cubby/schemas/search";

export const SEARCH_DOCUMENT_MAINTENANCE_POLL_MS = 4_000;

/** Poll only while the persisted audit is live; terminal state stays stable. */
export const searchDocumentMaintenanceRefetchInterval = (
  data: Pick<SearchDocumentMaintenance, "state"> | undefined,
): number | false =>
  data?.state === "running" ? SEARCH_DOCUMENT_MAINTENANCE_POLL_MS : false;
