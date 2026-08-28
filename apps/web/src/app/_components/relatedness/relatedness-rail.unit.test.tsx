import {
  backgroundBatchBrowserSummarySchema,
  type BackgroundBatchStatus,
} from "@cubby/schemas/background-jobs";
import { imageOut, type ImageOut } from "@cubby/schemas/image";
import type { RelatednessOut } from "@cubby/schemas/relatedness";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { backgroundBatch } from "~/lib/background-batch.functions";
import { relatedness } from "~/lib/recommendations.functions";
import { search } from "~/lib/search.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type RelatednessRailOperations,
  RelatednessRail,
} from "./relatedness-rail";

const BATCH_ID = "00000000-0000-4000-8000-000000000001";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function completedBatch(status: BackgroundBatchStatus = "succeeded") {
  return backgroundBatchBrowserSummarySchema.parse({
    id: BATCH_ID,
    kind: "entity-embedding.refresh",
    source: "ui",
    processor: "inline",
    status,
    totalJobs: 1,
    queuedJobs: 0,
    runningJobs: 0,
    succeededJobs: status === "succeeded" ? 1 : 0,
    failedJobs: status === "failed" ? 1 : 0,
    skippedJobs: 0,
    cancelledJobs: 0,
    firstEnqueuedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastEnqueuedAt: new Date("2026-01-01T00:00:00.000Z"),
    firstJobStartedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastJobFinishedAt: new Date("2026-01-01T00:00:01.000Z"),
    processingDurationMs: 1_000,
    wallDurationMs: 1_000,
    activeDurationMs: 1_000,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:01.000Z"),
  });
}

interface RelatednessRailTestAdapter {
  operations: RelatednessRailOperations;
  relatednessRequestCount: () => number;
}

function createTestOperations(
  relatednessResult: RelatednessOut,
): RelatednessRailTestAdapter {
  let requestCount = 0;
  return {
    // These stay actual operation descriptors: only their remote transport is
    // in-memory, so input/output parsing and cache metadata are exercised.
    operations: {
      relatedness: relatedness.product.withTransport(async () => {
        requestCount += 1;
        return relatednessResult;
      }),
      requestEmbeddingRefresh: search.requestEmbeddingRefresh.withTransport(
        async () => ({
          batchId: BATCH_ID,
          totalJobs: 1,
        }),
      ),
      batchSummary: backgroundBatch.summary.withTransport(async () =>
        completedBatch(),
      ),
    },
    relatednessRequestCount: () => requestCount,
  };
}

function productImage(id: string, url: string): ImageOut {
  return imageOut.parse({
    id,
    url,
    key: "related-product.jpg",
    filename: "related-product.jpg",
    size: 100,
    contentType: "image/jpeg",
    status: "UPLOADED",
    width: 800,
    height: 600,
    detectedContentType: null,
    sha256: null,
    renderStatus: null,
    storageStatus: null,
    verifiedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

function renderRail({
  relatednessResult,
  imageSummaries,
}: {
  relatednessResult: RelatednessOut;
  imageSummaries?: Record<string, ImageOut[]>;
}) {
  const adapter = createTestOperations(relatednessResult);
  render(
    <RelatednessRail
      product={{ id: testShortcode("product", "PRD-SOURCE"), tags: [] }}
      operations={adapter.operations}
      imageSummaries={imageSummaries}
    />,
    { wrapper: harness.wrapper },
  );
  return adapter;
}

describe("RelatednessRail", () => {
  it("refetches relatedness after its Index now batch reaches a terminal state", async () => {
    const adapter = renderRail({
      relatednessResult: { status: "stale", items: [] },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Index now" }));

    await waitFor(() => {
      expect(adapter.relatednessRequestCount()).toBe(2);
    });
  });

  it("renders image and icon identity marks for ready related products", async () => {
    const pictured = testShortcode("product", "PRD-PICTURED");
    const unpictured = testShortcode("product", "PRD-UNPICTURED");
    renderRail({
      relatednessResult: {
        status: "ready",
        items: [
          {
            entity: "product",
            shortcode: pictured,
            title: "Pictured related product",
            score: 0.92,
            evidence: [{ signal: "Semantic match", detail: null, weight: 1 }],
          },
          {
            entity: "product",
            shortcode: unpictured,
            title: "Unpictured related product",
            score: 0,
            evidence: [{ signal: "Shared tag", detail: null, weight: 0 }],
          },
        ],
      },
      imageSummaries: {
        [pictured]: [
          productImage(
            testShortcode("image", "IMG-PICTURED"),
            "https://images.example/cover.jpg",
          ),
        ],
      },
    });

    const picturedLink = await screen.findByRole("link", {
      name: "Pictured related product",
    });
    const unpicturedLink = screen.getByRole("link", {
      name: "Unpictured related product",
    });

    const picturedImage = picturedLink.querySelector("img");
    if (!picturedImage) throw new Error("Expected the pictured product cover");

    expect(picturedImage).toHaveAttribute(
      "src",
      "https://images.example/cover.jpg",
    );
    expect(unpicturedLink.querySelector("svg")).toBeInTheDocument();
    expect(screen.getByText("92% similar")).toBeVisible();
    expect(screen.getByText("Shared tag")).toBeVisible();
  });
});
