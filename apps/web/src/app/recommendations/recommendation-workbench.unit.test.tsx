import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
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
