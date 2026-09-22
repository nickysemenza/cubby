import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityMedia } from "~/entities/entity-media.functions";
import { recommendations } from "~/lib/recommendations.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import type { EntityBrowserMutationInput } from "~/server/entity-kernel/contracts";

import {
  productionRecommendationWorkbenchOperations,
  RecommendationWorkbench,
} from "./recommendation-workbench";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("RecommendationWorkbench tag propagation", () => {
  it("does not mutate tags until the proposal is explicitly accepted", async () => {
    const sourceId = testShortcode("product", "PRD-TAGS");
    const updates: Array<
      Extract<
        EntityBrowserMutationInput,
        { action: "update"; entity: "product" }
      >
    > = [];
    const productUpdateMutationOptions = entityMutationOptionsFactory(
      "product",
      "update",
      {
        execute: async (command) => {
          if (command.action !== "update" || command.entity !== "product") {
            throw new Error("Expected a product update command");
          }
          updates.push(command);
          return new Promise<never>(() => undefined);
        },
      },
    );
    const operations = {
      ...productionRecommendationWorkbenchOperations,
      tagPropagation: recommendations.tagPropagation.withTransport(
        async () => ({
          status: "ready",
          currentTags: ["existing"],
          proposals: [{ tag: "workshop", supportingProductCount: 3 }],
        }),
      ),
      productUpdateMutationOptions,
    };

    render(
      <RecommendationWorkbench
        sourceId={sourceId}
        kind="tag-propagation"
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );

    const accept = await screen.findByRole("button", { name: "Accept" });
    expect(updates).toEqual([]);
    fireEvent.click(accept);

    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({
      id: sourceId,
      data: { tags: ["existing", "workshop"] },
    });
  });
});

describe("RecommendationWorkbench product relationships", () => {
  it("renders canonical thumbnails and semantic icon fallbacks without losing evidence or actions", async () => {
    const sourceId = testShortcode("product", "PRD-SOURCE");
    const picturedId = testShortcode("product", "PRD-PICTURED");
    const unpicturedId = testShortcode("product", "PRD-UNPICTURED");
    const operations = {
      ...productionRecommendationWorkbenchOperations,
      product: recommendations.product.withTransport(async () => ({
        status: "ready" as const,
        items: [
          {
            entity: "product" as const,
            shortcode: picturedId,
            title: "Pictured workbench product",
            score: 0.91,
            evidence: [{ signal: "Similar meaning", detail: null, weight: 1 }],
          },
          {
            entity: "product" as const,
            shortcode: unpicturedId,
            title: "Unpictured workbench product",
            score: 0.72,
            evidence: [{ signal: "Shared tag", detail: null, weight: 1 }],
          },
        ],
      })),
      displayImages: entityMedia.displayImages.withTransport(async () => ({
        [`product:${picturedId}`]: {
          url: "https://images.example/workbench.jpg",
        },
        [`product:${unpicturedId}`]: null,
      })).queryOptions,
    };

    render(
      <RecommendationWorkbench
        sourceId={sourceId}
        kind="product-related"
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );

    const picturedLink = await screen.findByRole("link", {
      name: "Pictured workbench product",
    });
    const unpicturedLink = screen.getByRole("link", {
      name: "Unpictured workbench product",
    });
    await waitFor(() =>
      expect(picturedLink.querySelector("img")).toHaveAttribute(
        "src",
        "https://images.example/workbench.jpg",
      ),
    );
    expect(unpicturedLink.querySelector("img")).toBeNull();
    expect(unpicturedLink.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("Similar meaning")).toBeVisible();
    expect(screen.getByText("Shared tag")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /Dismiss/ })).toHaveLength(2);
  });
});

describe("RecommendationWorkbench product matches", () => {
  const keeperId = testShortcode("product", "PRD-KEEP");
  const photoId = testShortcode("product", "PRD-PHTO");
  const side = (
    id: typeof keeperId,
    name: string,
    role: "photo" | "purchase",
  ) => ({
    id,
    name,
    role,
    category: "Apparel",
    inventoryCount: role === "photo" ? 1 : 1,
    owner: null,
    purchase:
      role === "purchase"
        ? {
            id: testShortcode("purchase", "PUR-2ABC"),
            date: "2026-09-01",
            vendor: "Synthetic outfitter",
            line: "Crew tee, grey, M",
          }
        : null,
    gtins: [],
    sources: [],
  });
  const queue = {
    semanticRanking: false,
    items: [
      {
        source: "agent" as const,
        keeper: side(keeperId, "Crew tee, grey", "purchase"),
        other: side(photoId, "Gray crew t-shirt — M", "photo"),
        evidence: "Vendor photo shows the same pocket seam",
        sourceUrls: ["https://vendor.example/p/crew-tee"],
        signals: [],
        warnings: ["Both products have stock. Merging sums their quantities."],
      },
    ],
  };

  it("shows both covers with evidence, and dismisses the exact pair", async () => {
    const dismissed: unknown[] = [];
    const operations = {
      ...productionRecommendationWorkbenchOperations,
      productMatches: recommendations.productMatches.withTransport(
        async () => queue,
      ),
      dismissProductMatch: recommendations.dismissProductMatch.withTransport(
        async ({ input }) => {
          dismissed.push(input);
          return { ok: true as const };
        },
      ),
      displayImages: entityMedia.displayImages.withTransport(async () => ({
        [`product:${keeperId}`]: { url: "https://images.example/vendor.jpg" },
        [`product:${photoId}`]: { url: "https://images.example/photo.jpg" },
      })).queryOptions,
    };

    render(
      <RecommendationWorkbench kind="product-match" operations={operations} />,
      {
        wrapper: harness.wrapper,
      },
    );

    expect(
      await screen.findByText("Vendor photo shows the same pocket seam"),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getAllByRole("img").map((img) => img.getAttribute("alt")),
      ).toEqual(["Crew tee, grey", "Gray crew t-shirt — M"]),
    );
    expect(
      screen.getByRole("link", { name: "https://vendor.example/p/crew-tee" }),
    ).toHaveAttribute("href", "https://vendor.example/p/crew-tee");
    expect(screen.getByText(/Merging sums their quantities/)).toBeVisible();
    expect(screen.getByText("Keep · From a purchase")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Not the same/ }));
    await waitFor(() =>
      expect(dismissed).toEqual([{ productIds: [keeperId, photoId] }]),
    );
  });

  it("moves a matched neighbour out of the relationship list and links the match queue", async () => {
    const operations = {
      ...productionRecommendationWorkbenchOperations,
      product: recommendations.product.withTransport(async () => ({
        status: "ready" as const,
        items: [
          {
            entity: "product" as const,
            shortcode: keeperId,
            title: "Crew tee, grey",
            score: 0.93,
            evidence: [{ signal: "Similar meaning", detail: null, weight: 1 }],
          },
        ],
      })),
      productMatches: recommendations.productMatches.withTransport(
        async () => queue,
      ),
      displayImages: entityMedia.displayImages.withTransport(async () => ({
        [`product:${keeperId}`]: null,
      })).queryOptions,
    };

    render(
      <RecommendationWorkbench
        sourceId={photoId}
        kind="product-related"
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      await screen.findByRole("link", { name: "product match queue" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Crew tee, grey" }),
    ).not.toBeInTheDocument();
  });
});
