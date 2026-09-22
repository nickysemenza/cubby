import { importRunShortcode } from "@cubby/schemas/identifiers";
import { imageWithEntitySchema } from "@cubby/schemas/image";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { image } from "~/entities/image.functions";
import type { ImportRunDetail } from "~/lib/purchase-import-run-detail";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";

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

const runImages = [
  mock(imageWithEntitySchema, {
    seed: 1,
    overrides: {
      id: "IMG-4K7M",
      filename: "closet-sweater.jpg",
      url: "https://img.example.com/closet-sweater.jpg",
      importTarget: { runId: run.publicId, state: "completed", position: 1 },
      analysisSummary: {
        description: "A folded sweater",
        classifications: ["sweater", "wool"],
        recognizedText: "Patagonia\nSize M",
      },
    },
  }),
  mock(imageWithEntitySchema, {
    seed: 2,
    overrides: {
      id: "IMG-4K7N",
      filename: "closet-jacket.jpg",
      url: "https://img.example.com/closet-jacket.jpg",
      importTarget: { runId: run.publicId, state: "completed", position: 2 },
      analysisSummary: {
        description: null,
        classifications: [],
        recognizedText: null,
      },
    },
  }),
  mock(imageWithEntitySchema, {
    seed: 3,
    overrides: {
      id: "IMG-4K7P",
      filename: "closet-unsorted.jpg",
      url: "https://img.example.com/closet-unsorted.jpg",
      importTarget: { runId: run.publicId, state: "pending", position: 3 },
    },
  }),
];

beforeEach(() => {
  harness = createBrowserTestHarness();
  harness.queryClient.setQueryData(
    image.list.queryKey({
      filters: { importRunId: [run.publicId] },
      pagination: { pageIndex: 0, pageSize: 200 },
    }),
    {
      meta: { pageIndex: 0, pageSize: 200, totalCount: runImages.length },
      items: runImages,
    },
  );
});

afterEach(() => {
  harness.dispose();
});

describe("PhotoImportRunView", () => {
  it("shows the run header, progress tally, and images grouped by target state", async () => {
    render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });

    expect(
      await screen.findByRole("heading", { name: run.publicId }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Uploaded by Fixture household member"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Fall closet batch, top shelf"),
    ).toBeInTheDocument();

    // Progress tally derived from `run.targets`, not from the images fetch.
    // SAFETY: the "Progress" heading always renders inside its own `Card`
    // (see `PhotoRunProgress`), so the nearest `[data-slot="card"]` ancestor
    // is never null.
    const progress = screen
      .getByText("Progress")
      .closest('[data-slot="card"]') as HTMLElement;
    expect(within(progress).getByText("2")).toBeInTheDocument();
    expect(within(progress).getByText("1")).toBeInTheDocument();

    // Images are grouped into one section per target state. Each card has
    // two links to the same image (thumbnail + filename), so assert that at
    // least one resolves to the right detail route rather than picking one.
    // SAFETY: each state group heading renders inside its own `Card` (see
    // `PhotoRunTargets`), so the nearest `[data-slot="card"]` ancestor is
    // never null.
    const completedSection = (
      await screen.findByRole("heading", { name: "Completed" })
    ).closest('[data-slot="card"]') as HTMLElement;
    const sweaterLinks = within(completedSection).getAllByRole("link", {
      name: /closet-sweater\.jpg/,
    });
    expect(
      sweaterLinks.some((link) =>
        link.getAttribute("href")?.includes("IMG-4K7M"),
      ),
    ).toBe(true);
    expect(
      within(completedSection).getAllByRole("link", {
        name: /closet-jacket\.jpg/,
      }),
    ).not.toHaveLength(0);

    // SAFETY: same invariant as `completedSection` above.
    const pendingSection = (
      await screen.findByRole("heading", { name: "Pending" })
    ).closest('[data-slot="card"]') as HTMLElement;
    expect(
      within(pendingSection).getAllByRole("link", {
        name: /closet-unsorted\.jpg/,
      }),
    ).not.toHaveLength(0);

    // OCR snippet (first line only) and classification chips render for the
    // image that has an analysis summary.
    expect(screen.getByText("Patagonia")).toBeInTheDocument();
    expect(screen.queryByText("Size M")).not.toBeInTheDocument();
    expect(screen.getByText("sweater")).toBeInTheDocument();
    expect(screen.getByText("wool")).toBeInTheDocument();
  });
});
