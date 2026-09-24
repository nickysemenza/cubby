import { imageShortcode, importRunShortcode } from "@cubby/schemas/identifiers";
import type {
  PhotoRunImage,
  PhotoRunReview,
} from "@cubby/schemas/photo-import-run";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ImportRunDetail } from "~/lib/purchase-import-run-detail";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { PhotoImportRunView } from "./photo-run-detail";

let harness: ReturnType<typeof createBrowserTestHarness>;

// "RUN-4K7M" is the one synthetic shortcode body AGENTS.md sanctions for
// outward-facing examples, and it also satisfies the real shortcode format
// the `importRunId` filter validates against.
const RUN_ID = importRunShortcode.parse("RUN-4K7M");

const run: ImportRunDetail = {
  publicId: RUN_ID,
  purpose: "photo_inventory",
  status: "completed",
  trigger: "manual",
  startedAt: "2026-09-20T16:00:00.000Z",
  endedAt: "2026-09-20T16:05:00.000Z",
  ordersSeen: 0,
  imported: 0,
  updated: 0,
  skipped: 0,
  failureCode: null,
  notes: "Fall closet batch, top shelf",
  predecessorRunPublicId: null,
  coordinatorModel: null,
  skillRevision: null,
  runtimeRevision: null,
  source: null,
  actor: {
    name: null,
    ledgerParty: { id: "LPY-4K7M", name: "Fixture household member" },
  },
  controllingMembers: [],
  controlHistory: [],
  vendorAccount: null,
  affectedPurchases: [],
  findings: [],
  operations: [],
  preparedOrders: [],
  targets: [
    {
      id: "target-1",
      targetType: "image",
      targetShortcode: null,
      targetName: null,
      sourceId: null,
      sourceLabel: null,
      vendorAccountLabel: null,
      state: "completed",
      fingerprint: null,
      outcome: "attached",
      warning: null,
      diff: null,
      completedAt: "2026-09-20T16:04:00.000Z",
    },
    {
      id: "target-2",
      targetType: "image",
      targetShortcode: null,
      targetName: null,
      sourceId: null,
      sourceLabel: null,
      vendorAccountLabel: null,
      state: "completed",
      fingerprint: null,
      outcome: "attached",
      warning: null,
      diff: null,
      completedAt: "2026-09-20T16:04:30.000Z",
    },
    {
      id: "target-3",
      targetType: "image",
      targetShortcode: null,
      targetName: null,
      sourceId: null,
      sourceLabel: null,
      vendorAccountLabel: null,
      state: "pending",
      fingerprint: null,
      outcome: null,
      warning: null,
      diff: null,
      completedAt: null,
    },
  ],
  evidence: [],
  progress: [],
  latestProgress: null,
  approvals: [],
};

const photo = (
  id: string,
  position: number,
  targetState: "completed" | "pending",
  text: { description?: string; recognizedText?: string; cutout?: boolean },
): PhotoRunImage => ({
  id: imageShortcode.parse(id),
  position,
  targetState,
  originalUrl: `https://img.example.com/${id}.jpg`,
  cutoutUrl: text.cutout ? `https://img.example.com/${id}-cutout.png` : null,
  cutout: null,
  describe: null,
  cutoutReason: null,
  description: text.description ?? null,
  recognizedText: text.recognizedText ?? null,
});

const review: PhotoRunReview = {
  review: {
    runId: RUN_ID,
    runStatus: "completed",
    proposals: [],
    unassignedImageIds: [],
  },
  images: [
    photo("IMG-4K7M", 1, "completed", {
      description: "A folded sweater",
      cutout: true,
    }),
    photo("IMG-4K7N", 2, "completed", { recognizedText: "Patagonia\nSize M" }),
    photo("IMG-4K7P", 3, "pending", {}),
  ],
};

beforeEach(() => {
  harness = createBrowserTestHarness();
  harness.queryClient.setQueryData(
    ["purchase-import", "run", RUN_ID, "photo-review"],
    review,
  );
});

afterEach(() => {
  harness.dispose();
});

describe("PhotoImportRunView", () => {
  // The run's status, owner, times and notes render in the generic Run
  // detail's hero and overview; this slot owns only the worklist.
  it("shows the progress tally and every run photo with its cutout and description", async () => {
    render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });

    expect(await screen.findByText("Progress")).toBeInTheDocument();

    // Progress tally derived from `run.targets`, not from the review fetch.
    // SAFETY: the "Progress" heading always renders inside its own `Card`
    // (see `PhotoRunProgress`), so the nearest `[data-slot="card"]` ancestor
    // is never null.
    const progress = screen
      .getByText("Progress")
      .closest('[data-slot="card"]') as HTMLElement;
    expect(
      within(progress).getByRole("progressbar", { name: "Photos reviewed" }),
    ).toHaveAttribute("aria-valuenow", "2");
    expect(progress).toHaveTextContent("2 of 3 photos settled");

    // Every run photo is a row linking to its image, with the cutout beside
    // the original once the device has produced one.
    expect(
      await screen.findByRole("link", { name: "Open photo IMG-4K7M" }),
    ).toHaveAttribute("href", "/images/IMG-4K7M");
    expect(
      screen.getByRole("link", { name: "Open photo IMG-4K7P" }),
    ).toBeInTheDocument();
    expect(screen.getByAltText("Cutout of IMG-4K7M")).toBeInTheDocument();
    expect(screen.queryByAltText("Cutout of IMG-4K7N")).not.toBeInTheDocument();

    // The description wins; without one, only the OCR text's first line shows.
    expect(screen.getByText("A folded sweater")).toBeInTheDocument();
    expect(screen.getByText("Patagonia")).toBeInTheDocument();
    expect(screen.queryByText("Size M")).not.toBeInTheDocument();
  });
});
