import type { RelatedPreviewGroup } from "@cubby/schemas/related-view";
import { relatedViewsFor } from "@cubby/schemas/related-view";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { relatedData } from "~/lib/related-data.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type RelationshipExplorerOperations,
  RelationshipExplorer,
} from "./relationship-explorer";

const sourceId = "VEN-4K7M";
let harness: ReturnType<typeof createBrowserTestHarness>;

interface RelationshipExplorerTestAdapter {
  operations: RelationshipExplorerOperations;
  requestCount: () => number;
}

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function createOperations(
  result: () => Promise<RelatedPreviewGroup[]>,
): RelationshipExplorerTestAdapter {
  let requests = 0;
  return {
    operations: {
      previews: relatedData.previews.withTransport(async () => {
        requests += 1;
        return result();
      }),
      branch: relatedData.branch.withTransport(async ({ input }) => ({
        sourceId: input.sourceId,
        relationKey: input.relationKey,
        items: [],
        totalCount: 0,
        nextOffset: null,
      })),
    },
    requestCount: () => requests,
  };
}

function cacheGroups(
  operations: RelationshipExplorerOperations,
  groups: RelatedPreviewGroup[],
) {
  harness.queryClient.setQueryData(
    operations.previews.queryOptions({
      source: "vendor",
      sourceIds: [sourceId],
      relationKeys: relatedViewsFor("vendor").map((view) => view.key),
    }).queryKey,
    groups,
  );
}

describe("RelationshipExplorer", () => {
  it("states when registered relationships have no linked records", () => {
    const adapter = createOperations(async () => []);
    cacheGroups(adapter.operations, [
      { relationKey: "vendor.purchases", totalCount: 0, items: [], sourceId },
    ]);

    render(
      <RelationshipExplorer
        entity="vendor"
        sourceId={sourceId}
        operations={adapter.operations}
      />,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByText("No linked records.")).toBeVisible();
  });

  it("offers a top-level retry when the preview operation fails", async () => {
    const adapter = createOperations(async () => {
      throw new Error("relationship service unavailable");
    });
    render(
      <RelationshipExplorer
        entity="vendor"
        sourceId={sourceId}
        operations={adapter.operations}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      await screen.findByText("Relationships could not be loaded."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(adapter.requestCount()).toBe(2));
  });
});
