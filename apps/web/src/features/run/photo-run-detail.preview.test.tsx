import { retryImageProcessingInput } from "@cubby/schemas/activity";
import {
  imageShortcode,
  productShortcode,
  shortcode,
} from "@cubby/schemas/identifiers";
import {
  photoProductCandidate,
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

import { photoImportContract } from "~/contracts/photo-import.contract";
import type { RunDetail } from "~/contracts/run.contract";
import { installFeatures } from "~/features/registry";
import { photoImport } from "~/integrations/tanstack-query/generated/catalog/photoImport.gen";
import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import type { UnparsedStartOperationData } from "~/server/operation-runtime/start-operation.contract";

import { PhotoImportRunView } from "./photo-run-detail";

installFeatures();
const initialUrl = window.location.href;

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
      await screen.findByRole("button", { name: "Create product" }),
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

    expect(await screen.findByText("Progress")).toBeInTheDocument();

    // Progress tally derived from `run.targets`, not from the review fetch.
    const progress = screen.getByText("Progress").closest("section");
    if (!progress) throw new Error("Photo progress section is missing");
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
      name: "Create product",
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

it("retries a failed candidate read without disabling approval", async () => {
  await page.viewport(402, 874);
  presentProposal();
  let calls = 0;
  restoreDispatch = overrideStartDispatch(async (operation) => {
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
  expect(screen.getByRole("button", { name: "Create product" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("No matching existing Products."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Create product" })).toBeEnabled();
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
  expect(screen.getByRole("button", { name: "Create product" })).toBeEnabled();
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
    const approve = screen.getByRole("button", { name: "Create product" });
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
  restoreDispatch = overrideStartDispatch(async (operation, input) => {
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
  const approve = screen.getByRole("button", { name: "Create product" });
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
  restoreDispatch = overrideStartDispatch(async (operation, input) => {
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
  restoreDispatch = overrideStartDispatch(async (operation, input) => {
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
