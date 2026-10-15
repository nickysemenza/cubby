import { imageShortcode, shortcode } from "@cubby/schemas/identifiers";
import type {
  PhotoGroupProposal,
  PhotoRunImage,
  PhotoRunReview,
} from "@cubby/schemas/photo-import-run";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunDetail } from "~/contracts/run.contract";
import { photoImport } from "~/integrations/tanstack-query/generated/catalog.gen";
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
// the `runId` filter validates against.
const RUN_ID = shortcode("RUN-4K7M");

const run: RunDetail = {
  publicId: RUN_ID,
  purpose: "photo_inventory",
  status: "completed",
  trigger: "manual",
  attempt: 1,
  cause: "member_request",
  parentRunId: null,
  startedAt: "2026-09-20T16:00:00.000Z",
  endedAt: "2026-09-20T16:05:00.000Z",
  ordersSeen: 0,
  imported: 0,
  updated: 0,
  skipped: 0,
  failureCode: null,
  notes: "Fall closet batch, top shelf",
  retirementReason: null,
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
  progress: [],
  latestProgress: null,
  approvals: [],
};

const photo = (
  id: string,
  position: number,
  targetState: PhotoRunImage["targetState"],
  text: {
    description?: string;
    recognizedText?: string;
    cutout?: boolean;
    deviceWorkState?: PhotoRunImage["deviceWorkState"];
  },
): PhotoRunImage => ({
  id: imageShortcode.parse(id),
  position,
  capturedAt: null,
  capturedAtOffsetMinutes: null,
  targetState,
  skipReason: null,
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
  deviceWorkState: text.deviceWorkState ?? null,
  deviceWorkError: null,
  deviceWorkAttempts: 0,
});

const review: PhotoRunReview = {
  lifecycle: {
    processor: null,
    phase: "completed",
    plannedImageCount: null,
    openBatchCount: 0,
    finalizedImageCount: 3,
    describedImageCount: 2,
    failedImageIds: [],
    skippedImageCount: 0,
    proposedGroupCount: 0,
    committedGroupCount: 0,
    dispatchError: null,
  },
  imageProcessingPaused: false,
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

const committedSweater: PhotoGroupProposal = {
  groupKey: "fixture-sweater",
  state: "committed",
  origin: null,
  images: [
    { id: shortcode("IMG-4K7M"), purpose: "item" },
    { id: shortcode("IMG-4K7N"), purpose: "label" },
  ],
  skip: [],
  product: { kind: "create", create: { name: "Fixture sweater" } },
  committedProduct: {
    id: shortcode("PRD-4K7M"),
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
      ...review,
      imageProcessingPaused: false,
      review: {
        ...review.review,
        runStatus: "needs_review",
        proposals: [
          {
            groupKey: "fixture-shirt",
            origin: null,
            state: "proposed",
            images: [{ id: shortcode("IMG-4K7P"), purpose: "item" }],
            skip: [],
            product: { kind: "create", create: { name: "Fixture shirt" } },
            review: {
              observedName: "Fixture shirt",
              unresolvedReason: null,
              stockIntent: "evidence",
            },
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
      await screen.findByRole("button", { name: "Create Product" }),
    ).toBeEnabled();
    expect(
      screen.queryByText(/photos that can no longer be reviewed/),
    ).not.toBeInTheDocument();
  });

  it.each(["external", "cubby"] as const)(
    "keeps %s handoff or retry available after reopening a Run with committed groups",
    async (processor) => {
      const reopened: PhotoRunReview = {
        ...review,
        lifecycle: {
          ...review.lifecycle,
          processor,
          phase:
            processor === "external" ? "ready_for_handoff" : "needs_attention",
          dispatchError:
            processor === "cubby"
              ? "Connect the Cubby agent before grouping"
              : null,
        },
        review: {
          ...review.review,
          runStatus: "running",
          proposals: [committedSweater],
        },
      };
      harness.queryClient.setQueryData(
        photoImport.review.queryKey({ runId: RUN_ID }),
        reopened,
      );
      render(<PhotoImportRunView run={{ ...run, status: "running" }} />, {
        wrapper: harness.wrapper,
      });
      expect(
        screen.getByRole("button", {
          name:
            processor === "external"
              ? "Copy prompt for Claude/Codex"
              : "Start grouping",
        }),
      ).toBeEnabled();
      if (processor !== "cubby") return;
      expect(
        screen.getByText("Connect the Cubby agent before grouping"),
      ).toBeVisible();
    },
  );

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
      screen.queryByText(/The agent is preparing item groups/),
    ).not.toBeInTheDocument();
    expect(
      operations.filter((name) => name === "photoImport.startGrouping"),
    ).toHaveLength(0);
  });

  it("names paused image processing as the reason grouping waits", async () => {
    harness.queryClient.setQueryData(
      photoImport.review.queryKey({ runId: RUN_ID }),
      {
        ...review,
        imageProcessingPaused: true,
        review: { ...review.review, proposals: [] },
        images: review.images.map((image) => ({
          ...image,
          targetState: "pending" as const,
          describe: "pending" as const,
        })),
      } satisfies PhotoRunReview,
    );

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
      await screen.findByText(/Image processing is paused/),
    ).toBeInTheDocument();
  });

  // The run's status, owner, times and notes render in the generic Run
  // detail's hero and overview; this slot owns only the worklist.
  it("shows the progress tally and every run photo with its cutout and description", async () => {
    render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });

    expect(await screen.findByText("Progress")).toBeInTheDocument();

    // Progress tally derived from `run.targets`, not from the review fetch.
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

  it("does not invent a skipped result for an unqueued label photo", async () => {
    harness.queryClient.setQueryData(
      photoImport.review.queryKey({ runId: RUN_ID }),
      {
        ...review,
        review: {
          ...review.review,
          proposals: [committedSweater],
        },
        images: review.images.map((image) =>
          image.id === "IMG-4K7N"
            ? {
                ...image,
                cutout: null,
                cutoutReason: null,
              }
            : image,
        ),
      } satisfies PhotoRunReview,
    );
    render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });

    const labelRow = screen
      .getByRole("link", { name: "Open photo IMG-4K7N" })
      .closest("tr");
    if (!labelRow) throw new Error("Expected label photo row");
    expect(
      within(labelRow).getByText("Cutout: not queued"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Cutout: Skipped")).not.toBeInTheDocument();
  });

  it("holds approval while cloud description runs, then enables it without waiting for device analysis or cutout", async () => {
    const pendingReview: PhotoRunReview = {
      ...review,
      imageProcessingPaused: false,
      review: {
        ...review.review,
        runStatus: "running",
        proposals: [
          {
            groupKey: "fixture-sweater",
            origin: null,
            state: "proposed",
            images: [{ id: shortcode("IMG-4K7P"), purpose: "item" }],
            skip: [],
            product: { kind: "create", create: { name: "Fixture sweater" } },
            review: {
              observedName: "Fixture sweater",
              unresolvedReason: null,
              stockIntent: "evidence",
            },
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
      name: "Create Product",
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
