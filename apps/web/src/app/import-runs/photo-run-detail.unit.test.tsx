import {
  imageShortcode,
  importRunShortcode,
  productShortcode,
} from "@cubby/schemas/identifiers";
import type {
  PhotoRunImage,
  PhotoRunReview,
} from "@cubby/schemas/photo-import-run";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ImportRunDetail } from "~/contracts/run.contract";
import { photoImport } from "~/entities/run.functions";
import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import type { UnparsedStartOperationData } from "~/server/start-operation.contract";

import { PhotoImportRunView } from "./photo-run-detail";

let harness: ReturnType<typeof createBrowserTestHarness>;
let restoreDispatch: (() => void) | undefined;

/** Answer every Start operation with `data`, as candidate reads expect. */
const answerOperations = (data: UnparsedStartOperationData) => {
  restoreDispatch = overrideStartDispatch(async () => ({ ok: true, data }));
};

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
  restartInputs: null,
  successorRunPublicId: null,
  coordinatorModel: null,
  skillRevision: null,
  runtimeRevision: null,
  agentModelMs: 0,
  source: { kind: "manual", vendorName: null },
  actor: {
    name: null,
    ledgerParty: { id: "LPY-4K7M", name: "Fixture household member" },
  },
  controllingMembers: [],
  controlHistory: [],
  vendorAccount: null,
  dispatch: {
    eventId: null,
    state: "pending",
    attempts: 0,
    error: null,
    coordinatorStartedAt: null,
  },
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
  targetState: PhotoRunImage["targetState"],
  text: { description?: string; recognizedText?: string; cutout?: boolean },
): PhotoRunImage => ({
  id: imageShortcode.parse(id),
  position,
  targetState,
  originalUrl: `https://img.example.com/${id}.jpg`,
  cutoutUrl: text.cutout ? `https://img.example.com/${id}-cutout.png` : null,
  cutout: null,
  describe: null,
  describeStartedAt: null,
  describeCompletedAt: null,
  describeAttemptMs: null,
  describeWaitingMs: null,
  localAnalysisReady: Boolean(text.recognizedText),
  cutoutReason: null,
  describeReason: null,
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
    photoImport.review.queryKey({ runId: RUN_ID }),
    review,
  );
});

afterEach(() => {
  restoreDispatch?.();
  restoreDispatch = undefined;
  harness.dispose();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("PhotoImportRunView", () => {
  it("keeps approval available for unresolved photos on a stopped review run", async () => {
    const stoppedReview: PhotoRunReview = {
      review: {
        ...review.review,
        runStatus: "needs_review",
        proposals: [
          {
            groupKey: "fixture-shirt",
            state: "proposed",
            images: [{ id: imageShortcode.parse("IMG-4K7P"), purpose: "item" }],
            skip: [],
            product: { kind: "create", create: { name: "Fixture shirt" } },
            committedProduct: null,
            inventory: null,
            evidence: null,
            conflict: null,
            lastError: null,
            missingImageCount: 0,
            committedAt: null,
            updatedAt: "2026-09-20T16:04:00.000Z",
          },
        ],
      },
      images: review.images.map((image) =>
        image.id === "IMG-4K7P"
          ? { ...image, targetState: "unresolved" }
          : image,
      ),
    };
    harness.queryClient.setQueryData(
      photoImport.review.queryKey({ runId: RUN_ID }),
      stoppedReview,
    );
    render(<PhotoImportRunView run={{ ...run, status: "needs_review" }} />, {
      wrapper: harness.wrapper,
    });

    expect(
      await screen.findByRole("button", { name: "Approve item" }),
    ).toBeEnabled();
    expect(
      screen.queryByText(/photos that can no longer be reviewed/),
    ).not.toBeInTheDocument();
  });

  it("starts grouping when the completed iPhone upload opens its review link", async () => {
    window.history.replaceState(null, "", "/runs/RUN-4K7M?startGrouping=1");
    const operations: string[] = [];
    restoreDispatch = overrideStartDispatch(async (operation) => {
      operations.push(operation);
      return { ok: true, data: { runId: RUN_ID, started: true } };
    });

    render(
      <PhotoImportRunView run={{ ...run, status: "running", endedAt: null }} />,
      { wrapper: harness.wrapper },
    );

    await waitFor(() =>
      expect(
        operations.filter((name) => name === "photoImport.startGrouping"),
      ).toHaveLength(1),
    );
  });

  // Regression: a coordinator started while descriptions were still queued
  // saw bare photos and stopped for review without grouping any of them.
  it("waits for photo descriptions before starting grouping", async () => {
    window.history.replaceState(null, "", "/runs/RUN-4K7M?startGrouping=1");
    const describing: PhotoRunReview = {
      ...review,
      review: { ...review.review, proposals: [] },
      images: review.images.map((image) => ({
        ...image,
        targetState: "pending",
        describe: "pending",
      })),
    };
    harness.queryClient.setQueryData(
      photoImport.review.queryKey({ runId: RUN_ID }),
      describing,
    );
    const operations: string[] = [];
    restoreDispatch = overrideStartDispatch(async (operation) => {
      operations.push(operation);
      return {
        ok: true,
        data: { runId: RUN_ID, started: true, waitingForAnalysis: 0 },
      };
    });

    render(
      <PhotoImportRunView
        run={{
          ...run,
          status: "running",
          endedAt: null,
          targets: run.targets.map((target) => ({
            ...target,
            state: "pending",
          })),
        }}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      await screen.findByText(/Grouping starts once descriptions are ready/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start grouping" }),
    ).toBeDisabled();
    expect(
      operations.filter((name) => name === "photoImport.startGrouping"),
    ).toHaveLength(0);
  });

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
    expect(progress).toHaveTextContent("Device analysis · optional");
    expect(progress).toHaveTextContent("Cloud description");
    expect(progress).toHaveTextContent("Subject lift · optional");

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
    expect(screen.getByText("Device: Done")).toBeInTheDocument();
    expect(screen.getAllByText("Device: Not received")).toHaveLength(2);
  });

  it("shows a neutral skipped cutout pill with the label-only reason", async () => {
    harness.queryClient.setQueryData(
      photoImport.review.queryKey({ runId: RUN_ID }),
      {
        ...review,
        review: {
          ...review.review,
          proposals: [
            {
              groupKey: "fixture-sweater",
              state: "committed",
              images: [
                { id: imageShortcode.parse("IMG-4K7M"), purpose: "item" },
                { id: imageShortcode.parse("IMG-4K7N"), purpose: "label" },
              ],
              skip: [],
              product: { kind: "create", create: { name: "Fixture sweater" } },
              committedProduct: {
                id: productShortcode.parse("PRD-4K7M"),
                name: "Fixture sweater",
                coverUrl: null,
              },
              inventory: null,
              evidence: null,
              conflict: null,
              lastError: null,
              missingImageCount: 0,
              committedAt: "2026-09-20T16:04:00.000Z",
              updatedAt: "2026-09-20T16:04:00.000Z",
            },
          ],
        },
        images: review.images.map((image) =>
          image.id === "IMG-4K7N"
            ? {
                ...image,
                cutout: "skipped",
                cutoutReason: "Image is attached only as label evidence",
              }
            : image,
        ),
      } satisfies PhotoRunReview,
    );
    answerOperations({
      candidates: [
        {
          id: "PRD-4K7N",
          name: "ForgeWear pocket tee black small",
          coverUrl: null,
          match: {
            source: "catalog_name",
            sharedNameTerms: ["pocket", "tee", "black", "small"],
            brandMatches: true,
            variant: {
              color: { first: null, second: "black", relation: "unknown" },
              size: { first: null, second: "small", relation: "unknown" },
            },
          },
          hasOwnPhoto: false,
          hasPhotoImport: false,
          hasPurchase: true,
          hasInventory: false,
        },
      ],
    });
    render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });

    expect(await screen.findByText("Cutout: Skipped")).toHaveAttribute(
      "data-slot",
      "badge",
    );
    expect(
      screen.getByLabelText(
        "Cutout: Skipped. This photo is label evidence, so it does not need a cutout.",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Product comparison" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Shared terms: pocket, tee, black, small/),
    ).toBeInTheDocument();
  });

  it("holds approval while cloud description runs, then enables it without waiting for device analysis or cutout", async () => {
    const pendingReview: PhotoRunReview = {
      review: {
        ...review.review,
        runStatus: "running",
        proposals: [
          {
            groupKey: "fixture-sweater",
            state: "proposed",
            images: [{ id: imageShortcode.parse("IMG-4K7P"), purpose: "item" }],
            skip: [],
            product: { kind: "create", create: { name: "Fixture sweater" } },
            committedProduct: null,
            inventory: null,
            evidence: null,
            conflict: null,
            lastError: null,
            missingImageCount: 0,
            committedAt: null,
            updatedAt: "2026-09-20T16:04:00.000Z",
          },
        ],
      },
      images: review.images.map((image) =>
        image.id === "IMG-4K7P"
          ? { ...image, describe: "leased", cutout: "waiting_for_device" }
          : image,
      ),
    };
    const key = photoImport.review.queryKey({ runId: RUN_ID });
    harness.queryClient.setQueryData(key, pendingReview);
    answerOperations({ candidates: [] });
    render(
      <PhotoImportRunView run={{ ...run, status: "running", endedAt: null }} />,
      { wrapper: harness.wrapper },
    );

    const approveItem = await screen.findByRole("button", {
      name: "Approve item",
    });
    expect(approveItem).toBeDisabled();
    expect(
      screen.getByText(/Approval waits for the AI description/),
    ).toBeInTheDocument();

    harness.queryClient.setQueryData(key, {
      ...pendingReview,
      images: pendingReview.images.map((image) =>
        image.id === "IMG-4K7P" ? { ...image, describe: "ready" } : image,
      ),
    } satisfies PhotoRunReview);
    await waitFor(() => expect(approveItem).toBeEnabled());
  });
});
