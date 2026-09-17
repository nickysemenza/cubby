import type { EntityRecommendationsOut } from "@cubby/schemas/entity-recommendations";
import { testShortcode } from "@cubby/schemas/testing";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { recommendations } from "~/lib/recommendations.functions";
import { search } from "~/lib/search.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { entityDisplayImageKey } from "../entity-media/entity-display-images";
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
  relatednessResults: readonly EntityRecommendationsOut[],
): RelatednessRailTestAdapter {
  let requestCount = 0;
  return {
    // These stay actual operation descriptors: only their remote transport is
    // in-memory, so input/output parsing and cache metadata are exercised.
    operations: {
      recommendations: recommendations.forEntity.withTransport(async () => {
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

function result(
  status: "ready" | "stale" | "uncomputed" | "unavailable",
  proposals: Extract<
    EntityRecommendationsOut["groups"][number],
    { kind: "product-related" }
  >["proposals"] = [],
): EntityRecommendationsOut {
  return {
    source: {
      entityType: "product",
      entityId: testShortcode("product", "PRD-SOURCE"),
    },
    basisKey: `basis-${status}`,
    groups: [{ kind: "product-related", status, proposals }],
  };
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
    const adapter = createTestOperations([result("stale"), result("ready")]);
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
    const adapter = createTestOperations([result("stale")]);
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
    const relatednessResult = result("ready", [
      {
        kind: "product-related",
        target: { id: pictured, name: "Pictured related product" },
        score: 0.92,
        evidence: [{ signal: "Semantic match", detail: null, weight: 1 }],
      },
      {
        kind: "product-related",
        target: { id: unpictured, name: "Unpictured related product" },
        score: 0,
        evidence: [{ signal: "Shared tag", detail: null, weight: 0 }],
      },
    ]);
    const adapter = createTestOperations([relatednessResult]);
    render(
      <RelatednessRail
        product={{ id: testShortcode("product", "PRD-SOURCE"), tags: [] }}
        operations={adapter.operations}
        seededDisplayImages={{
          [entityDisplayImageKey({
            entityType: "product",
            entityId: pictured,
          })]: { url: "https://images.example/cover.jpg" },
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

  it("keeps factual tag proposals visible when semantic similarity is unavailable", async () => {
    harness = createBrowserTestHarness();
    const tagged = testShortcode("product", "PRD-TAGGED");
    const adapter = createTestOperations([
      result("unavailable", [
        {
          kind: "product-related",
          target: { id: tagged, name: "Same fitting" },
          score: 0,
          evidence: [{ signal: "Shared tag", detail: "m18", weight: 1 }],
        },
      ]),
    ]);
    renderRail(adapter, harness.wrapper);

    expect(
      await screen.findByRole("link", { name: "Same fitting" }),
    ).toBeVisible();
    expect(screen.getByText("Shared tag")).toBeVisible();
    expect(
      screen.getByText(
        "Similarity is unavailable until embeddings are configured.",
      ),
    ).toBeVisible();
  });
});
