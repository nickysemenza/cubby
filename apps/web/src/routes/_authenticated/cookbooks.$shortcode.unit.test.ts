import type { CookbookRunReport } from "@cubby/schemas/cookbook";
import { describe, expect, it, vi } from "vitest";

import { summarizeRunReport } from "~/app/cookbooks/cookbook-run-report";

import {
  cookbookTabs,
  loadCookbookDetail,
  type CookbookDetailLoaderPort,
} from "./cookbooks.$shortcode";

describe("cookbook detail loader", () => {
  it("preloads the focused detail and turns an unknown code into router not-found", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ id: "CKB-ALPHA", book: "Alpha" })
      .mockResolvedValueOnce(null);
    const port: CookbookDetailLoaderPort = { load };

    await loadCookbookDetail("CKB-ALPHA", port);
    expect(load).toHaveBeenCalledWith("CKB-ALPHA");

    await expect(loadCookbookDetail("CKB-MISSING", port)).rejects.toMatchObject(
      { isNotFound: true },
    );
  });
});

describe("cookbook detail tabs", () => {
  it("offers the extraction report only for a readable source", () => {
    expect(cookbookTabs({ needsReextract: false })).toEqual([
      "recipes",
      "ingredients",
      "report",
    ]);
    // A retired-format book's source cannot be fetched at all, so the tab would
    // open onto nothing but the server's refusal.
    expect(cookbookTabs({ needsReextract: true })).toEqual([
      "recipes",
      "ingredients",
    ]);
  });
});

describe("run report summary", () => {
  const report: CookbookRunReport = {
    run_id: "run-1",
    started_at: "2026-09-10T10:00:00Z",
    finished_at: "2026-09-10T10:01:05Z",
    total_cost_usd: 0.42,
    cost_complete: false,
    wall_ms: 65_000,
    incomplete: true,
    cancelled: false,
    calls: [],
    chunks: [],
    crosscheck: {
      nav_titles: 3,
      matched: 2,
      missing: ["Cherry Pie"],
      phantom: [],
      recall: 0.67,
    },
    usage_by_model: [
      { model: "claude-haiku", calls: 4, cost_usd: 0.4 },
      { model: "claude-sonnet", calls: 1, cost_usd: 0.02 },
    ],
  };

  it("keeps the facts that still matter months later", () => {
    expect(summarizeRunReport(report)).toEqual({
      costUsd: 0.42,
      costComplete: false,
      wallMs: 65_000,
      models: [
        { model: "claude-haiku", calls: 4 },
        { model: "claude-sonnet", calls: 1 },
      ],
      recall: 0.67,
      matched: 2,
      navTitles: 3,
      incomplete: true,
      cancelled: false,
    });
  });

  it("reads an absent recall as unknown, not as zero", () => {
    // The crate leaves recall out when a book has too few contents entries to
    // judge; reporting that as 0% would accuse a fine extraction of failing.
    const summary = summarizeRunReport({
      ...report,
      crosscheck: { ...report.crosscheck, recall: null },
    });
    expect(summary.recall).toBeNull();
  });
});
