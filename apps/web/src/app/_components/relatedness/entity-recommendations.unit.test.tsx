import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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
    const targetId = testShortcode("product", "PRD-TARGET");
    render(
      <EntityRecommendations
        source={{ entityType: "product", entityId: sourceId }}
        operations={{
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
                    target: { id: targetId, name: "Same fitting" },
                    score: 0,
                    evidence: [
                      { signal: "Shared tag", detail: "m18", weight: 1 },
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
    expect(screen.getByRole("link", { name: "Same fitting" })).toBeVisible();
    expect(screen.getByText("Shared tag")).toBeVisible();
  });
});
