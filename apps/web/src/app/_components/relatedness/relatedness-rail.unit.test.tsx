import { imageOut, type ImageOut } from "@cubby/schemas/image";
import type { RelatednessOut } from "@cubby/schemas/relatedness";
import { testShortcode } from "@cubby/schemas/testing";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { relatedness } from "~/lib/recommendations.functions";
import { search } from "~/lib/search.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type RelatednessRailOperations,
  RelatednessRail,
} from "./relatedness-rail";
import {
  EMBEDDING_READINESS_POLL_INTERVAL_MS,
  EMBEDDING_READINESS_POLL_TIMEOUT_MS,
} from "./use-embedding-readiness-poll";

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

interface RelatednessRailTestAdapter {
  operations: RelatednessRailOperations;
  relatednessRequestCount: () => number;
}

/**
 * `relatednessResults` is consumed in order, one entry per request, and the
 * LAST entry repeats once exhausted — a stand-in for a query that stops
 * changing once the transport has nothing further to report.
 */
function createTestOperations(
  relatednessResults: readonly RelatednessOut[],
): RelatednessRailTestAdapter {
  let requestCount = 0;
  return {
    // These stay actual operation descriptors: only their remote transport is
    // in-memory, so input/output parsing and cache metadata are exercised.
    operations: {
      relatedness: relatedness.product.withTransport(async () => {
        const index = Math.min(requestCount, relatednessResults.length - 1);
        const result = relatednessResults[index]!;
        requestCount += 1;
        return result;
      }),
      requestEmbeddingRefresh: search.requestEmbeddingRefresh.withTransport(
        async () => ({ accepted: true as const }),
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

function renderRail(
  adapter: RelatednessRailTestAdapter,
  wrapper: React.ComponentType<{ children: React.ReactNode }>,
) {
  render(
    <RelatednessRail
      product={{ id: testShortcode("product", "PRD-SOURCE"), tags: [] }}
      operations={adapter.operations}
    />,
    { wrapper },
  );
}

describe("RelatednessRail", () => {
  it("polls readiness after Index now and stops on ready", async () => {
    harness = createBrowserTestHarness({ clock: { now: 0 } });
    const adapter = createTestOperations([
      { status: "stale", items: [] },
      { status: "ready", items: [] },
    ]);
    renderRail(adapter, harness.wrapper);

    await act(async () => {
      await harness!.clock!.advanceBy(0);
    });
    expect(adapter.relatednessRequestCount()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Index now" }));
    await act(async () => {
      await harness!.clock!.advanceBy(0);
    });
    expect(screen.getByText("Indexing…")).toBeInTheDocument();

    await act(async () => {
      await harness!.clock!.advanceBy(EMBEDDING_READINESS_POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(adapter.relatednessRequestCount()).toBe(2);
    await act(async () => {
      await harness!.clock!.advanceBy(1);
    });
    expect(screen.queryByText("Indexing…")).not.toBeInTheDocument();

    // The poll stopped once status turned "ready" — nothing further fires
    // even well past another interval tick.
    await act(async () => {
      await harness!.clock!.advanceBy(EMBEDDING_READINESS_POLL_INTERVAL_MS * 5);
      await Promise.resolve();
    });
    expect(adapter.relatednessRequestCount()).toBe(2);
  });

  it("shows a check-again affordance once the poll times out", async () => {
    harness = createBrowserTestHarness({ clock: { now: 0 } });
    const adapter = createTestOperations([{ status: "stale", items: [] }]);
    renderRail(adapter, harness.wrapper);

    await act(async () => {
      await harness!.clock!.advanceBy(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "Index now" }));
    await act(async () => {
      await harness!.clock!.advanceBy(0);
    });

    await act(async () => {
      await harness!.clock!.advanceBy(EMBEDDING_READINESS_POLL_TIMEOUT_MS);
      await Promise.resolve();
    });

    expect(
      screen.getByText("Still indexing — this can take a minute."),
    ).toBeInTheDocument();
    const checkAgainButton = screen.getByRole("button", {
      name: "Check again",
    });

    const requestsBeforeCheck = adapter.relatednessRequestCount();
    fireEvent.click(checkAgainButton);
    await act(async () => {
      await harness!.clock!.advanceBy(0);
    });
    expect(adapter.relatednessRequestCount()).toBe(requestsBeforeCheck + 1);
    expect(
      screen.queryByText("Still indexing — this can take a minute."),
    ).not.toBeInTheDocument();
  });

  it("renders image and icon identity marks for ready related products", async () => {
    harness = createBrowserTestHarness();
    const pictured = testShortcode("product", "PRD-PICTURED");
    const unpictured = testShortcode("product", "PRD-UNPICTURED");
    const relatednessResult: RelatednessOut = {
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
    };
    const adapter = createTestOperations([relatednessResult]);
    render(
      <RelatednessRail
        product={{ id: testShortcode("product", "PRD-SOURCE"), tags: [] }}
        operations={adapter.operations}
        imageSummaries={{
          [pictured]: [
            productImage(
              testShortcode("image", "IMG-PICTURED"),
              "https://images.example/cover.jpg",
            ),
          ],
        }}
      />,
      { wrapper: harness.wrapper },
    );

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
