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
