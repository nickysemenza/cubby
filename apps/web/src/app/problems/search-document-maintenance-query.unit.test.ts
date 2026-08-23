import { describe, expect, it } from "vitest";
import {
  SEARCH_DOCUMENT_MAINTENANCE_POLL_MS,
  searchDocumentMaintenanceRefetchInterval,
} from "./search-document-maintenance-query";

describe("search document maintenance polling", () => {
  it("polls live audits and stops at every terminal state", () => {
    expect(searchDocumentMaintenanceRefetchInterval({ state: "running" })).toBe(
      SEARCH_DOCUMENT_MAINTENANCE_POLL_MS,
    );
    for (const state of ["never-run", "completed", "failed"] as const) {
      expect(searchDocumentMaintenanceRefetchInterval({ state })).toBe(false);
    }
    expect(searchDocumentMaintenanceRefetchInterval(undefined)).toBe(false);
  });
});
