import { retryImageProcessingInput } from "@cubby/schemas/activity";
import {
  imageShortcode,
  productShortcode,
  shortcode,
  vendorShortcode,
} from "@cubby/schemas/identifiers";
import {
  photoProductCandidate,
  photoProductEvidence,
  photoRunCandidatesResponse,
  reviewPhotoGroupsOutput,
} from "@cubby/schemas/photo-import-run";
import type {
  PhotoGroupProposal,
  PhotoRunImage,
  PhotoRunReview,
} from "@cubby/schemas/photo-import-run";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { createEditorBrowserTestHarness as createBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import { photoImportContract } from "~/contracts/photo-import.contract";
import type { RunDetail } from "~/contracts/run.contract";
import { installFeatures } from "~/features/registry";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { photoImport } from "~/integrations/tanstack-query/domains/photoImport";
import { run as runOperations } from "~/integrations/tanstack-query/domains/run";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { overrideOperationDispatch } from "~/integrations/tanstack-query/operation-call";
import { mock } from "~/lib/test/mock-schema";
import type { OperationWireValue } from "~/server/operation-runtime/operation.contract";

import { PhotoImportRunView } from "./photo-run-detail";

installFeatures();
const initialUrl = window.location.href;

let harness: ReturnType<typeof createBrowserTestHarness>;
let restoreDispatch: (() => void) | undefined;

/** Answer every Start operation with `data`, as candidate reads expect. */
const answerOperations = (data: OperationWireValue) => {
  restoreDispatch = overrideOperationDispatch(async () => ({ ok: true, data }));
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
};

// Native state tests need a decodable local image, not an unreachable CDN.
const photoDataUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="gray"/></svg>')}`;

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
  originalUrl: `${photoDataUrl}#${id}`,
  cutoutUrl: text.cutout ? `${photoDataUrl}#${id}-cutout` : null,
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
  cloudDescriptionMissing: false,
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
    withoutCloudDescriptionCount: 0,
    skippedImageCount: 0,
    proposedGroupCount: 0,
    committedGroupCount: 0,
    dispatchError: null,
  },
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
  steps: [],
  blockedReason: null,
  committedAt: "2026-09-20T16:04:00.000Z",
  updatedAt: "2026-09-20T16:04:00.000Z",
};

beforeEach(async () => {
  await page.viewport(1440, 900);
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
  window.history.replaceState(null, "", initialUrl);
  vi.unstubAllGlobals();
});

describe("PhotoImportRunView", () => {
  it("points a superseded Run at the successor's pending groups instead of listing ungrouped photos", async () => {
    const successorId = shortcode("RUN-5K8N");
    harness.queryClient.setQueryData(
      photoImport.review.queryKey({ runId: RUN_ID }),
      {
        ...review,
        review: {
          ...review.review,
          unassignedImageIds: review.images.map((image) => image.id),
        },
      },
    );
    harness.queryClient.setQueryData(
      runOperations.work.queryKey({ runId: successorId }),
      {
        ...run,
        publicId: successorId,
        predecessorRunPublicId: RUN_ID,
        status: "needs_review",
      } satisfies RunDetail,
    );
    harness.queryClient.setQueryData(
      photoImport.review.queryKey({ runId: successorId }),
      {
        ...review,
        review: {
          runId: successorId,
          runStatus: "needs_review",
          proposals: [
            {
              ...committedSweater,
              state: "proposed",
              committedProduct: null,
              committedAt: null,
            },
          ],
          unassignedImageIds: [],
        },
      } satisfies PhotoRunReview,
    );

    render(
      <PhotoImportRunView
        run={{ ...run, successorRunPublicId: successorId }}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      await screen.findByRole("link", {
        name: `Grouping continued in ${successorId}`,
      }),
    ).toHaveAttribute("href", `/runs/${successorId}`);
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByText("1 group awaiting approval")).toBeInTheDocument();
    expect(screen.queryByLabelText("Not in a group")).not.toBeInTheDocument();
    expect(screen.queryByText(/photos not in a group/)).not.toBeInTheDocument();
  });

  it("keeps approval available for unresolved photos on a stopped review run", async () => {
    const stoppedReview: PhotoRunReview = {
      ...review,
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
            steps: [],
            blockedReason: null,
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
      await screen.findByRole("button", { name: /Create product and/ }),
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
    restoreDispatch = overrideOperationDispatch(async (operation) => {
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
    restoreDispatch = overrideOperationDispatch(async (operation) => {
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

  it("keeps pending descriptions processing automatically", async () => {
    harness.queryClient.setQueryData(
      photoImport.review.queryKey({ runId: RUN_ID }),
      {
        ...review,
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
      await screen.findByText(/Grouping starts once descriptions are ready/),
    ).toBeInTheDocument();
  });

  // The run's status, owner, times and notes render in the generic Run
  // detail's hero and overview; this slot owns only the worklist.
  it("shows the progress tally and every run photo with its cutout and description", async () => {
    render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });
    await userEvent.click(
      await screen.findByRole("button", { name: /^Photos$/ }),
    );

    expect(await screen.findByText("Progress")).toBeInTheDocument();

    // Progress tally derived from `run.targets`, not from the review fetch.
    const progress = screen.getByText("Progress").closest("section");
    if (!progress) throw new Error("Photo progress section is missing");
    expect(
      within(progress).getByRole("progressbar", { name: "Photos reviewed" }),
    ).toHaveAttribute("aria-valuenow", "2");
    expect(progress).toHaveTextContent("2 of 3 photos settled");
    await userEvent.click(
      within(progress).getByRole("button", { name: "Processing details" }),
    );
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

  it("notes photos grouped on an Apple description while the cloud one waits", async () => {
    harness.queryClient.setQueryData(
      photoImport.review.queryKey({ runId: RUN_ID }),
      {
        ...review,
        lifecycle: { ...review.lifecycle, withoutCloudDescriptionCount: 2 },
        images: review.images.map((image, index) =>
          index < 2
            ? { ...image, describe: "ready", cloudDescriptionMissing: true }
            : image,
        ),
      } satisfies PhotoRunReview,
    );
    render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });
    await userEvent.click(
      await screen.findByRole("button", { name: /^Photos$/ }),
    );

    expect(
      await screen.findByTestId("without-cloud-description"),
    ).toHaveTextContent("2 photos use their Apple description");
    expect(
      screen.getAllByText("Apple description only; cloud description waiting"),
    ).toHaveLength(2);
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
    await userEvent.click(
      await screen.findByRole("button", { name: /^Photos$/ }),
    );

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
            steps: [],
            blockedReason: "AI description is still processing or needs retry",
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
    answerOperations({ groups: [] });
    render(
      <PhotoImportRunView run={{ ...run, status: "running", endedAt: null }} />,
      { wrapper: harness.wrapper },
    );

    const approveItem = await screen.findByRole("button", {
      name: /Create product and/,
    });
    expect(approveItem).toBeDisabled();
    expect(
      screen.getByText(/Approval waits for the AI description/),
    ).toBeInTheDocument();

    harness.queryClient.setQueryData(key, {
      ...pendingReview,
      review: {
        ...pendingReview.review,
        proposals: pendingReview.review.proposals.map((proposal) => ({
          ...proposal,
          blockedReason: null,
        })),
      },
      images: pendingReview.images.map((image) =>
        image.id === "IMG-4K7P" ? { ...image, describe: "ready" } : image,
      ),
    } satisfies PhotoRunReview);
    await waitFor(() => expect(approveItem).toBeEnabled());
  });
});

const proposedSweater: PhotoGroupProposal = {
  ...committedSweater,
  state: "proposed",
  committedProduct: null,
  committedAt: null,
  images: [{ id: shortcode("IMG-4K7M"), purpose: "item" }],
};

function presentProposal(proposal = proposedSweater) {
  harness.queryClient.setQueryData(
    photoImport.review.queryKey({ runId: RUN_ID }),
    {
      ...review,
      review: { ...review.review, proposals: [proposal] },
      images: review.images.map((image) => ({
        ...image,
        targetState: "pending",
        describe: "ready",
      })),
    } satisfies PhotoRunReview,
  );
}

it("retains unchanged candidate checks across Run progress and refreshes only revised groups", async () => {
  const proposals = Array.from({ length: 7 }, (_, index) => ({
    ...proposedSweater,
    groupKey: `fixture-group-${index}`,
    images:
      index === 6
        ? [{ id: imageShortcode.parse("IMG-4K7N"), purpose: "label" as const }]
        : proposedSweater.images,
  }));
  const key = photoImport.review.queryKey({ runId: RUN_ID });
  let snapshot: PhotoRunReview = {
    ...review,
    review: {
      ...review.review,
      proposals: [
        ...proposals,
        committedSweater,
        {
          ...committedSweater,
          groupKey: "discarded-fixture",
          state: "discarded",
        },
      ],
    },
  } satisfies PhotoRunReview;
  harness.queryClient.setQueryData(key, snapshot);
  const requests: string[][] = [];
  let rejected = false;
  restoreDispatch = overrideOperationDispatch(async (operation, input) => {
    if (operation === "photoImport.review") return { ok: true, data: snapshot };
    if (operation === "photoImport.rejectCandidate") {
      rejected = true;
      return {
        ok: true,
        data: { ...snapshot.review, results: [], frozenGroupKeys: [] },
      };
    }
    if (operation !== "photoImport.candidatesBatch")
      throw new Error(`Unexpected operation ${operation}`);
    const { groupKeys } =
      photoImportContract.ops.candidatesBatch.input.parse(input);
    requests.push(groupKeys ?? []);
    return {
      ok: true,
      data: {
        groups: (groupKeys ?? []).map((groupKey) => ({
          groupKey,
          status: "ready",
          error: null,
          candidates: [],
          rejectedCandidates: rejected
            ? [
                {
                  id: "PRD-4K7M",
                  name: "Synthetic rejected sweater",
                  rejected: true,
                },
              ]
            : [],
          selectedComparison: null,
        })),
      },
    };
  });
  render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });
  await waitFor(() =>
    expect(requests.flat()).toEqual(proposals.map((p) => p.groupKey)),
  );
  await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
  await invalidateOperationTags(harness.queryClient, ripple.runOnly);
  expect(requests).toHaveLength(2);
  snapshot = {
    ...snapshot,
    review: {
      ...snapshot.review,
      proposals: snapshot.review.proposals.map((proposal, index) =>
        index === 3
          ? { ...proposal, updatedAt: "2026-09-20T16:06:00.000Z" }
          : proposal,
      ),
    },
  };
  harness.queryClient.setQueryData(key, snapshot);
  await waitFor(() => expect(requests.slice(2)).toEqual([["fixture-group-3"]]));
  await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
  snapshot = {
    ...snapshot,
    images: snapshot.images.map((image) =>
      image.id === "IMG-4K7N"
        ? { ...image, recognizedText: "Synthetic revised size label" }
        : image,
    ),
  };
  harness.queryClient.setQueryData(key, snapshot);
  await waitFor(() => expect(requests.slice(3)).toEqual([["fixture-group-6"]]));
  await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
  await invalidateOperationTags(harness.queryClient, ripple.image);
  expect(requests.slice(4).flat().sort()).toEqual(
    proposals.map((p) => p.groupKey).sort(),
  );
  const beforeRejection = requests.length;
  const rejection = {
    runId: RUN_ID,
    groupKey: "fixture-group-3",
    productId: productShortcode.parse("PRD-4K7M"),
    operationId: "fixture-rejection",
  };
  await photoImport.rejectCandidate.call(rejection);
  await invalidateOperationTags(
    harness.queryClient,
    photoImport.rejectCandidate.invalidates(rejection),
  );
  expect(requests.slice(beforeRejection).flat().sort()).toEqual(
    proposals.map((p) => p.groupKey).sort(),
  );
  expect(
    await screen.findByText("Synthetic rejected sweater · Rejected"),
  ).toBeVisible();
});

it("retries a failed candidate read without disabling approval", async () => {
  await page.viewport(402, 874);
  presentProposal();
  let calls = 0;
  restoreDispatch = overrideOperationDispatch(async (operation) => {
    if (operation !== "photoImport.candidatesBatch")
      throw new Error(`Unexpected operation ${operation}`);
    calls++;
    return {
      ok: true,
      data: photoRunCandidatesResponse.parse({
        groups: [
          {
            groupKey: proposedSweater.groupKey,
            status: calls === 1 ? "failed" : "ready",
            error: calls === 1 ? "Synthetic candidate check unavailable" : null,
            candidates: [],
            rejectedCandidates: [],
            selectedComparison: null,
          },
        ],
      }),
    };
  });
  render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });
  expect(await screen.findByText("Couldn't check ·")).toBeVisible();
  expect(
    screen.getByText("Synthetic candidate check unavailable"),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: /Create product and/ }),
  ).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("No matching existing Products."),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: /Create product and/ }),
  ).toBeEnabled();
  expect(calls).toBe(2);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(402);
});

it("keeps a weak candidate behind Compare instead of presenting a duplicate warning", async () => {
  presentProposal();
  const candidate = mock(photoProductCandidate, {
    overrides: {
      id: productShortcode.parse("PRD-4K7M"),
      name: "Synthetic related sweater",
      duplicateStrength: "weak",
      coverUrl: null,
      match: {
        source: "catalog_name",
        sharedNameTerms: ["sweater"],
        brandMatches: false,
      },
    },
  });
  answerOperations(
    photoRunCandidatesResponse.parse({
      groups: [
        {
          groupKey: proposedSweater.groupKey,
          status: "ready",
          error: null,
          candidates: [candidate],
          rejectedCandidates: [],
          selectedComparison: null,
        },
      ],
    }),
  );
  render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });
  expect(
    await screen.findByRole("button", { name: "Compare existing Products" }),
  ).toBeVisible();
  expect(screen.queryByText(candidate.name)).not.toBeInTheDocument();
  expect(screen.queryByText(/Possible duplicate:/)).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /Create product and/ }),
  ).toBeEnabled();
});

it.each(["description", "cutout"] as const)(
  "treats %s failure according to the server approval boundary",
  async (failure) => {
    const proposal = {
      ...proposedSweater,
      blockedReason:
        failure === "description" ? "AI description needs retry" : null,
    };
    harness.queryClient.setQueryData(
      photoImport.review.queryKey({ runId: RUN_ID }),
      {
        ...review,
        review: { ...review.review, proposals: [proposal] },
        images: review.images.map((image) => ({
          ...image,
          targetState: "pending",
          describe: failure === "description" ? "failed" : "ready",
          describeReason:
            failure === "description" ? "Synthetic description failure" : null,
          cutout: failure === "cutout" ? "failed" : null,
          cutoutReason:
            failure === "cutout" ? "Synthetic cutout failure" : null,
        })),
      } satisfies PhotoRunReview,
    );
    answerOperations({ groups: [] });
    render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });
    const notice = await screen.findByText(
      failure === "description"
        ? /Description failed: Synthetic description failure/
        : /Optional cutout failed: Synthetic cutout failure/,
    );
    expect(notice).toBeVisible();
    expect(
      within(notice).getByRole("link", { name: "Open photo to retry" }),
    ).toHaveAttribute("href", "/images/IMG-4K7M");
    const approve = screen.getByRole("button", { name: /Create product and/ });
    expect(approve).toHaveProperty("disabled", failure === "description");
  },
);

it("shows exact-identifier evidence without hiding a conflicting size", async () => {
  const observedName = "Synthetic work boots size 7";
  presentProposal({
    ...proposedSweater,
    product: { kind: "create", create: { name: observedName } },
  });
  const candidate = mock(photoProductCandidate, {
    overrides: {
      id: productShortcode.parse("PRD-4K7M"),
      name: "Synthetic work boots size 9",
      duplicateStrength: "strong",
      coverUrl: null,
      match: {
        source: "catalog_name",
        sharedNameTerms: ["boots"],
        brandMatches: false,
        matchedIdentifiers: ["EXAMPLE-7744"],
        variant: {
          color: { relation: "same" },
          size: { relation: "different" },
          evidence: {
            firstTitle: observedName,
            secondTitle: "Synthetic work boots size 9",
          },
        },
      },
    },
  });
  answerOperations(
    photoRunCandidatesResponse.parse({
      groups: [
        {
          groupKey: proposedSweater.groupKey,
          status: "ready",
          error: null,
          candidates: [candidate],
          rejectedCandidates: [],
          selectedComparison: null,
        },
      ],
    }),
  );
  render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });
  expect(await screen.findByText(/Possible duplicate:/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Compare" }));
  expect(screen.getByText("Exact identifier")).toBeVisible();
  expect(screen.getByText("Titles conflict — check evidence")).toBeVisible();
  await userEvent.click(screen.getByText("Original comparison text"));
  expect(screen.getByText(`Photo: ${observedName}`)).toBeVisible();
  expect(
    screen.getByText("Product: Synthetic work boots size 9"),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Choose Product" })).toBeEnabled();
});

// Dirty input must survive a background saved snapshot; approval's blur barrier
// must submit that input before reading the revision used for approval.
// A successful sibling save must not acknowledge a rejected field draft.
it("keeps a dirty field through refresh and saves it before approval", async () => {
  const proposal: PhotoGroupProposal = {
    ...proposedSweater,
    steps: [
      {
        key: "identity",
        label: "Identity",
        status: "needs_input",
        summary: null,
        action: "create",
        blockedReason: null,
      },
    ],
  };
  presentProposal(proposal);
  let savedName: string | undefined;
  let savedNotes: string | null | undefined;
  let rejectName = true;
  let submittedRevision: string | undefined;
  const savedRevision = "2026-09-20T16:06:00.000Z";
  restoreDispatch = overrideOperationDispatch(async (operation, input) => {
    if (operation === "photoImport.candidatesBatch")
      return { ok: true, data: { groups: [] } };
    if (operation === "photoImport.saveGroups") {
      const body = photoImportContract.ops.saveGroups.input.parse(input);
      const group = body.groups[0];
      if (group?.product.kind === "create") {
        if (rejectName && group.product.create.name === "Unsaved sweater name")
          throw new Error("Synthetic name save rejected");
        savedName = group.product.create.name;
        savedNotes = group.product.create.notes;
      }
      return {
        ok: true,
        data: reviewPhotoGroupsOutput.parse({
          ...review.review,
          proposals: [
            {
              ...proposal,
              product: {
                kind: "create",
                create: { name: savedName, notes: savedNotes },
              },
              updatedAt: savedRevision,
            },
          ],
          results: [],
          frozenGroupKeys: [],
        }),
      };
    }
    if (operation === "photoImport.approveGroups") {
      submittedRevision =
        photoImportContract.ops.approveGroups.input.parse(input)
          .expectedRevisions?.[0]?.updatedAt;
      return {
        ok: true,
        data: reviewPhotoGroupsOutput.parse({
          ...review.review,
          proposals: [{ ...committedSweater, updatedAt: savedRevision }],
          results: [{ groupKey: proposal.groupKey, outcome: "committed" }],
          frozenGroupKeys: [],
        }),
      };
    }
    throw new Error(`Unexpected operation ${operation}`);
  });
  render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });
  const name = await screen.findByRole("textbox", { name: "New product name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Unsaved sweater name");
  presentProposal({
    ...proposal,
    product: { kind: "create", create: { name: "Refreshed saved name" } },
  });
  await waitFor(() => expect(name).toHaveValue("Unsaved sweater name"));
  const approve = screen.getByRole("button", { name: /Create product and/ });
  await userEvent.click(approve);
  await screen.findByText(
    /Changes were not saved:.*Synthetic name save rejected/,
  );
  expect(submittedRevision).toBeUndefined();

  await userEvent.click(screen.getByText("Notes and tags", { exact: true }));
  const notes = screen.getByRole("textbox", { name: "Product notes" });
  await userEvent.type(notes, "Label confirmed: medium");
  await userEvent.click(name);
  await waitFor(() => expect(savedNotes).toBe("Label confirmed: medium"));
  // A valid sibling save cannot acknowledge the rejected name draft.
  await userEvent.click(approve);
  await waitFor(() => expect(name).toHaveFocus());
  expect(name).toHaveValue("Unsaved sweater name");
  expect(submittedRevision).toBeUndefined();

  rejectName = false;
  await userEvent.click(approve);
  await userEvent.click(
    screen.getByRole("button", { name: /^All items · 1$/ }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Products from this import")).toBeVisible(),
  );
  expect(savedName).toBe("Unsaved sweater name");
  expect(submittedRevision).toBe(savedRevision);
});

it("recovers an applied receipt on a completed Run with an unsettled proposal", async () => {
  const proposal = { ...proposedSweater, blockedReason: "Run is completed" };
  const snapshot: PhotoRunReview = {
    ...review,
    review: { ...review.review, proposals: [proposal] },
  };
  harness.queryClient.setQueryData(
    photoImport.review.queryKey({ runId: RUN_ID }),
    snapshot,
  );
  let recovered = false;
  let submittedRevisions: unknown;
  restoreDispatch = overrideOperationDispatch(async (operation, input) => {
    if (operation === "photoImport.candidatesBatch")
      return { ok: true, data: { groups: [] } };
    if (operation === "photoImport.review")
      return {
        ok: true,
        data: recovered
          ? {
              ...snapshot,
              review: { ...snapshot.review, proposals: [committedSweater] },
            }
          : snapshot,
      };
    if (operation === "photoImport.approveGroups") {
      const body = photoImportContract.ops.approveGroups.input.parse(input);
      submittedRevisions = body.expectedRevisions;
      recovered = true;
      return {
        ok: true,
        data: reviewPhotoGroupsOutput.parse({
          ...review.review,
          proposals: [committedSweater],
          results: [{ groupKey: proposal.groupKey, outcome: "replayed" }],
          frozenGroupKeys: [],
        }),
      };
    }
    throw new Error(`Unexpected operation ${operation}`);
  });
  render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });
  await userEvent.click(
    await screen.findByRole("button", { name: "Recover applied result" }),
  );
  await waitFor(() => expect(recovered).toBe(true));
  expect(submittedRevisions).toEqual([
    { groupKey: proposal.groupKey, updatedAt: proposal.updatedAt },
  ]);
});

it("retains per-image retry errors and refreshes successful siblings", async () => {
  const failedIds = [
    imageShortcode.parse("IMG-4K7M"),
    imageShortcode.parse("IMG-4K7N"),
  ];
  const failedReview: PhotoRunReview = {
    ...review,
    lifecycle: {
      ...review.lifecycle,
      phase: "needs_attention",
      failedImageIds: failedIds,
    },
    images: review.images
      .filter((image) => failedIds.includes(image.id))
      .map((image) => ({
        ...image,
        targetState: "pending",
        describe: "failed",
        describeReason: "Synthetic description failure",
      })),
  };
  harness.queryClient.setQueryData(
    photoImport.review.queryKey({ runId: RUN_ID }),
    failedReview,
  );
  const retried: string[] = [];
  restoreDispatch = overrideOperationDispatch(async (operation, input) => {
    if (operation === "imageProcessing.retry") {
      const { id } = retryImageProcessingInput.parse(input);
      retried.push(id);
      if (id === failedIds[1]) throw new Error("Synthetic retry unavailable");
      return { ok: true, data: { retried: 1, submissionId: null } };
    }
    if (operation === "photoImport.review")
      return {
        ok: true,
        data: {
          ...failedReview,
          lifecycle: {
            ...failedReview.lifecycle,
            failedImageIds: retried.length ? [failedIds[1]] : failedIds,
          },
          images: failedReview.images.map((image) =>
            retried.length && image.id === failedIds[0]
              ? { ...image, describe: "leased" }
              : image,
          ),
        },
      };
    throw new Error(`Unexpected operation ${operation}`);
  });
  render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });
  await userEvent.click(
    await screen.findByRole("button", { name: "Retry failed descriptions" }),
  );
  expect(
    await screen.findByText(/IMG-4K7N: Synthetic retry unavailable/),
  ).toBeVisible();
  expect(
    await screen.findByText(
      "1 photos need a description retry. Successful photos are retained.",
    ),
  ).toBeVisible();
  expect(retried).toEqual(failedIds);
});

it("reviews evidence-matched brands in the workbench without replacing explicit or rejected choices", async () => {
  await page.viewport(1440, 900);
  const brandId = vendorShortcode.parse("VEN-4K7M");
  const evidence = [
    {
      name: "Fixture Apparel",
      imageIds: [imageShortcode.parse("IMG-4K7M")],
      matches: [{ id: brandId, name: "Fixture Apparel" }],
    },
  ];
  let rows: PhotoGroupProposal[] = [
    {
      ...proposedSweater,
      groupKey: "first-shirt",
      origin: "coordinator",
      product: { kind: "create", create: { name: "First fixture shirt" } },
      brandEvidence: evidence,
    },
    {
      ...proposedSweater,
      groupKey: "second-shirt",
      origin: "coordinator",
      product: { kind: "create", create: { name: "Second fixture shirt" } },
      brandEvidence: evidence,
    },
    {
      ...proposedSweater,
      groupKey: "chosen-shirt",
      product: {
        kind: "create",
        create: {
          name: "Explicit fixture shirt",
          brandId: vendorShortcode.parse("VEN-7M4K"),
        },
      },
      brandEvidence: evidence,
    },
    {
      ...proposedSweater,
      groupKey: "rejected-shirt",
      product: { kind: "create", create: { name: "Rejected fixture shirt" } },
      brandEvidence: evidence,
      review: {
        observedName: "Rejected fixture shirt",
        stockIntent: "evidence",
        unresolvedReason: null,
        rejectedBrandNames: ["Fixture Apparel"],
      },
    },
    {
      ...proposedSweater,
      groupKey: "member-empty",
      origin: "member",
      product: {
        kind: "create",
        create: { name: "Member cleared brand", brandId: null },
      },
      brandEvidence: evidence,
    },
  ];
  const publish = () =>
    harness.queryClient.setQueryData(
      photoImport.review.queryKey({ runId: RUN_ID }),
      {
        ...review,
        review: { ...review.review, proposals: rows },
        images: review.images.map((image) => ({
          ...image,
          targetState: "pending",
          describe: "ready",
        })),
      } satisfies PhotoRunReview,
    );
  publish();
  let savedKeys: string[] = [];
  restoreDispatch = overrideOperationDispatch(async (operation, input) => {
    if (operation === "photoImport.candidatesBatch")
      return { ok: true, data: { groups: [] } };
    if (operation !== "photoImport.saveGroups")
      throw new Error(`Unexpected operation ${operation}`);
    const body = photoImportContract.ops.saveGroups.input.parse(input);
    savedKeys = body.groups.map((group) => group.groupKey);
    rows = rows.map((row) => {
      const group = body.groups.find((item) => item.groupKey === row.groupKey);
      return group?.product.kind === "create"
        ? { ...row, product: group.product }
        : row;
    });
    return {
      ok: true,
      data: reviewPhotoGroupsOutput.parse({
        ...review.review,
        proposals: rows,
        results: [],
        frozenGroupKeys: [],
      }),
    };
  });
  render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });
  const list = await screen.findByRole("navigation", {
    name: "Items to review",
  });
  expect(screen.getByRole("textbox", { name: "New product name" })).toHaveValue(
    "First fixture shirt",
  );
  expect(screen.getByRole("combobox", { name: "Brand" })).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Read from 1 photo" }),
  );
  expect(screen.getByRole("region", { name: "Photo evidence" })).toBeVisible();
  await userEvent.click(
    screen.getByText("Use Fixture Apparel for 2 matching items", {
      exact: true,
    }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Update 2 proposals" }),
  );
  await waitFor(() =>
    expect(savedKeys).toEqual(["first-shirt", "second-shirt"]),
  );
  const first = within(list).getByRole("button", {
    name: /First fixture shirt/,
  });
  first.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(screen.getByRole("textbox", { name: "New product name" })).toHaveValue(
    "Second fixture shirt",
  );
  expect(
    within(list).getByRole("button", { name: /Second fixture shirt/ }),
  ).toHaveFocus();
  await page.viewport(402, 874);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(402);
});

it.each(["create", "existing"] as const)(
  "reviews, rejects and manually replaces a new brand on a %s Product draft",
  async (kind) => {
    const productId = productShortcode.parse("PRD-4K7M");
    let proposal: PhotoGroupProposal = {
      ...proposedSweater,
      product:
        kind === "create"
          ? { kind: "create", create: { name: "Fixture shirt" } }
          : {
              kind: "existing",
              existing: {
                id: productId,
                name: "Fixture shirt",
                coverUrl: null,
              },
            },
      review: {
        observedName: "Fixture shirt",
        stockIntent: "evidence",
        unresolvedReason: null,
      },
      brandEvidence: [
        {
          name: "Fixture New Label",
          imageIds: [imageShortcode.parse("IMG-4K7M")],
          matches: [],
        },
      ],
    };
    const publish = () => presentProposal(proposal);
    publish();
    const current = mock(photoProductEvidence, {
      overrides: {
        id: productId,
        name: "Fixture shirt",
        fields: {
          brandId: {
            current: {
              assignment: { kind: "inherit" },
              controls: {
                kind: "editable",
                canSetNone: false,
                canConfirm: false,
                reset: { kind: "unavailable" },
              },
            },
            result: {
              kind: "live",
              decision: {
                outcome: { kind: "empty", reason: "unset" },
                provenance: null,
              },
            },
            work: { kind: "idle" },
          },
          brandName: {
            current: {
              assignment: null,
              controls: { kind: "readonly", reason: "computed" },
            },
            result: {
              kind: "live",
              decision: {
                outcome: { kind: "empty", reason: "unset" },
                provenance: null,
              },
            },
            work: { kind: "idle" },
          },
          tags: {
            current: {
              assignment: {
                kind: "value",
                value: [],
                ownership: { kind: "record" },
              },
              controls: {
                kind: "editable",
                canSetNone: false,
                canConfirm: false,
                reset: { kind: "unavailable" },
              },
            },
            result: {
              kind: "live",
              decision: {
                outcome: { kind: "value", value: [] },
                provenance: { kind: "own", ownership: { kind: "record" } },
              },
            },
            work: { kind: "idle" },
          },
        },
        model: null,
        notes: null,
        category: null,
        identifiers: [],
        externalIds: [],
        ownPhotos: [],
        purchaseLines: [],
        purchaseLineCount: 0,
        inventoryEntries: [],
      },
    });
    if (kind === "existing")
      harness.queryClient.setQueryData(
        photoImport.productEvidence.queryKey({ runId: RUN_ID, productId }),
        current,
      );
    restoreDispatch = overrideOperationDispatch(async (operation, input) => {
      if (operation === "photoImport.candidatesBatch")
        return { ok: true, data: { groups: [] } };
      if (operation === "photoImport.productEvidence")
        return { ok: true, data: current };
      if (operation !== "photoImport.saveGroups")
        throw new Error(`Unexpected operation ${operation}`);
      const body = photoImportContract.ops.saveGroups.input.parse(input);
      const group = body.groups[0];
      if (!group) throw new Error("Missing saved proposal");
      proposal = {
        ...proposal,
        review: group.review,
        product:
          group.product.kind === "create" ? group.product : proposal.product,
      };
      return {
        ok: true,
        data: reviewPhotoGroupsOutput.parse({
          ...review.review,
          proposals: [proposal],
          results: [],
          frozenGroupKeys: [],
        }),
      };
    });
    render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });
    await userEvent.click(
      await screen.findByRole("button", { name: "Propose new brand" }),
    );
    await screen.findByText("On approval: create brand “Fixture New Label”");
    await userEvent.click(
      screen.getByRole("button", { name: "Reject brand proposal" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Propose new brand" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(proposal.review?.rejectedBrandNames).toEqual([
        "Fixture New Label",
      ]),
    );
    if (kind === "existing")
      await userEvent.click(
        screen.getByRole("checkbox", { name: "Change brand" }),
      );
    await userEvent.click(
      await screen.findByText("Brand not listed?", { exact: true }),
    );
    const name = screen.getByRole("textbox", { name: "New brand name" });
    await userEvent.type(name, "Fixture Corrected Label");
    await userEvent.tab();
    await waitFor(() => {
      const selection =
        proposal.product.kind === "create"
          ? proposal.product.create
          : proposal.review?.productChanges;
      expect(selection?.brandCreate).toEqual({
        name: "Fixture Corrected Label",
      });
    });
    publish();
    await waitFor(() => expect(name).toHaveValue("Fixture Corrected Label"));
  },
);

it("retains failed batch selection and its diagnostic while successful items become applied", async () => {
  const first: PhotoGroupProposal = {
    ...proposedSweater,
    groupKey: "ready-shirt",
    product: { kind: "create", create: { name: "Ready fixture shirt" } },
  };
  const second: PhotoGroupProposal = {
    ...proposedSweater,
    groupKey: "retry-shirt",
    product: { kind: "create", create: { name: "Retry fixture shirt" } },
  };
  harness.queryClient.setQueryData(
    photoImport.review.queryKey({ runId: RUN_ID }),
    {
      ...review,
      review: { ...review.review, proposals: [first, second] },
      images: review.images.map((image) => ({
        ...image,
        targetState: "pending",
        describe: "ready",
      })),
    } satisfies PhotoRunReview,
  );
  restoreDispatch = overrideOperationDispatch(async (operation) => {
    if (operation === "photoImport.candidatesBatch")
      return { ok: true, data: { groups: [] } };
    if (operation !== "photoImport.approveGroups")
      throw new Error(`Unexpected operation ${operation}`);
    return {
      ok: true,
      data: reviewPhotoGroupsOutput.parse({
        ...review.review,
        proposals: [
          {
            ...first,
            state: "committed",
            committedProduct: {
              id: productShortcode.parse("PRD-4K7M"),
              name: "Ready fixture shirt",
              coverUrl: null,
            },
          },
          { ...second, lastError: "Synthetic approval failure" },
        ],
        results: [
          { groupKey: first.groupKey, outcome: "committed" },
          {
            groupKey: second.groupKey,
            outcome: "failed",
            error: "Synthetic approval failure",
          },
        ],
        frozenGroupKeys: [],
      }),
    };
  });
  render(<PhotoImportRunView run={run} />, { wrapper: harness.wrapper });
  await userEvent.click(
    await screen.findByRole("button", { name: "Select all ready items" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Approve 2 selected items" }),
  );
  await screen.findByRole("button", { name: "Approve 1 selected item" });
  const items = screen.getByRole("navigation", { name: "Items to review" });
  expect(
    within(items).queryByRole("checkbox", {
      name: /Select Ready fixture shirt/,
    }),
  ).not.toBeInTheDocument();
  expect(
    within(items).getByRole("checkbox", { name: /Select Retry fixture shirt/ }),
  ).toBeChecked();
  await userEvent.click(
    within(items).getByRole("button", { name: /Retry fixture shirt/ }),
  );
  expect(
    await screen.findByText("Last approval failed: Synthetic approval failure"),
  ).toBeVisible();
  expect(
    within(items).getByRole("button", { name: /Ready fixture shirt/ }),
  ).toHaveTextContent("Applied");
});
