import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { entityMedia } from "~/entities/entity-media.functions";
import { recommendations } from "~/lib/recommendations.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { EntityRecommendations } from "./entity-recommendations";

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

describe("EntityRecommendations", () => {
  it("renders factual product proposals alongside unavailable semantic status", async () => {
    harness = createBrowserTestHarness();
    const sourceId = testShortcode("product", "PRD-SOURCE");
    const picturedId = testShortcode("product", "PRD-PICTURED");
    const unpicturedId = testShortcode("product", "PRD-UNPICTURED");
    render(
      <EntityRecommendations
        source={{ entityType: "product", entityId: sourceId }}
        operations={{
          displayImages: entityMedia.displayImages.withTransport(async () => ({
            [`product:${picturedId}`]: {
              url: "https://images.example/pictured.jpg",
            },
            [`product:${unpicturedId}`]: null,
          })).queryOptions,
          forEntity: recommendations.forEntity.withTransport(async () => ({
            source: { entityType: "product", entityId: sourceId },
            basisKey: "product-tags",
            groups: [
              {
                kind: "product-related",
                status: "unavailable",
                proposals: [
                  {
                    kind: "product-related",
                    target: { id: picturedId, name: "Same fitting" },
                    score: 0,
                    evidence: [
                      { signal: "Shared tag", detail: "m18", weight: 1 },
                    ],
                  },
                  {
                    kind: "product-related",
                    target: { id: unpicturedId, name: "No product photo" },
                    score: 0.8,
                    evidence: [
                      { signal: "Similar meaning", detail: null, weight: 1 },
                    ],
                  },
                ],
              },
            ],
          })),
        }}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      await screen.findByText(
        "Similarity is unavailable until embeddings are configured.",
      ),
    ).toBeVisible();
    const picturedLink = screen.getByRole("link", { name: "Same fitting" });
    const unpicturedLink = screen.getByRole("link", {
      name: "No product photo",
    });
    expect(picturedLink.querySelector("img")).toHaveAttribute(
      "src",
      "https://images.example/pictured.jpg",
    );
    expect(unpicturedLink.querySelector("img")).toBeNull();
    expect(unpicturedLink.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("Shared tag")).toBeVisible();
  });
});
