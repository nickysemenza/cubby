import type { RelatedPreviewGroup } from "@cubby/schemas/related-view";
import { relatedViewsFor } from "@cubby/schemas/related-view";
import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityPreviewQueryOptions } from "~/entities/entity-query";
import { relatedData } from "~/lib/related-data.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type RelationshipPreviewOperations,
  RelationshipRoutePreview,
  relationshipRoutePreviewModel,
  relationshipRouteSourceFromRecord,
  useRelationshipRouteSource,
} from "./relationship-route-preview";

const sourceId = "VEN-ROUTE";
const groups: RelatedPreviewGroup[] = [
  {
    sourceId,
    relationKey: "vendor.products",
    totalCount: 5,
    items: [
      {
        entity: "product",
        id: "PRD-ONE",
        label: "First endpoint",
        displayImage: null,
      },
      {
        entity: "product",
        id: "PRD-TWO",
        label: "Second endpoint",
        displayImage: null,
      },
      {
        entity: "product",
        id: "PRD-THREE",
        label: "Third endpoint",
        displayImage: null,
      },
    ],
  },
];

let harness: ReturnType<typeof createBrowserTestHarness>;

interface RelationshipPreviewTestAdapter {
  operations: RelationshipPreviewOperations;
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
): RelationshipPreviewTestAdapter {
  let requests = 0;
  return {
    operations: {
      previews: relatedData.previews.withTransport(async () => {
        requests += 1;
        return result();
      }),
    },
    requestCount: () => requests,
  };
}

function previewKey(operations: RelationshipPreviewOperations) {
  return operations.previews.queryOptions({
    source: "vendor",
    sourceIds: [sourceId],
    relationKeys: relatedViewsFor("vendor").map((view) => view.key),
  }).queryKey;
}

function renderPreview(
  operations: RelationshipPreviewOperations,
  cachedGroups?: RelatedPreviewGroup[],
) {
  if (cachedGroups)
    harness.queryClient.setQueryData(previewKey(operations), cachedGroups);
  return render(
    <RelationshipRoutePreview
      entity="vendor"
      sourceId={sourceId}
      source={{ entity: "vendor", id: sourceId, label: "Fixture vendor" }}
      operations={operations}
    />,
    { wrapper: harness.wrapper },
  );
}

describe("relationshipRoutePreviewModel", () => {
  it("selects the first registered nonempty edge and preserves endpoint siblings", () => {
    const model = relationshipRoutePreviewModel({
      source: { entity: "vendor", id: sourceId, label: "Fixture vendor" },
      views: relatedViewsFor("vendor"),
      groups,
    });

    expect(model?.relation).toMatchObject({
      key: "vendor.products",
      label: "Products",
      totalCount: 5,
    });
    expect(model?.relation.endpoints.map((endpoint) => endpoint.id)).toEqual([
      "PRD-ONE",
      "PRD-TWO",
      "PRD-THREE",
    ]);
  });

  it("uses record identity and keeps an unnamed meal's date identity", () => {
    expect(
      relationshipRouteSourceFromRecord("vendor", {
        id: sourceId,
        name: "Fixture vendor",
      }),
    ).toEqual({ entity: "vendor", id: sourceId, label: "Fixture vendor" });
    expect(
      relationshipRouteSourceFromRecord("meal", {
        id: "MEL-ROUTE",
        name: "",
        date: "2026-01-02",
      }),
    ).toEqual({ entity: "meal", id: "MEL-ROUTE", label: "Jan 2" });
  });
});

describe("RelationshipRoutePreview", () => {
  it("renders canonical source and sibling endpoint links from the query cache", () => {
    const adapter = createOperations(async () => groups);
    renderPreview(adapter.operations, groups);

    expect(screen.getByTestId("relationship-route-preview")).toBeVisible();
    expect(screen.getByText("Fixture vendor").closest("a")).toHaveAttribute(
      "href",
      `/vendors/${sourceId}`,
    );
    expect(screen.getByText("First endpoint").closest("a")).toHaveAttribute(
      "href",
      "/products/PRD-ONE",
    );
    expect(screen.getByText("+2")).toBeVisible();
  });

  it("keeps an empty relationship preview distinct from unavailable state", () => {
    const empty = createOperations(async () => []);
    renderPreview(empty.operations, []);
    expect(
      screen.getByTestId("relationship-route-preview-state"),
    ).toHaveTextContent("No linked records.");
  });

  it("offers retry when the relationship operation fails", async () => {
    const failure = createOperations(async () => {
      throw new Error("Fixture failure");
    });
    renderPreview(failure.operations);
    expect(await screen.findByText("Fixture failure")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(failure.requestCount()).toBe(2));
  });

  it.each(["cookbook", "usda-food", "vendor"] as const)(
    "waits for a source ID before observing a %s preview",
    (entity) => {
      const { result } = renderHook(
        () => useRelationshipRouteSource(entity, undefined),
        { wrapper: harness.wrapper },
      );
      expect(result.current).toBeNull();
      expect(harness.queryClient.isFetching()).toBe(0);
    },
  );

  it("reads an already-loaded source preview without fetching it", () => {
    harness.queryClient.setQueryData(
      entityPreviewQueryOptions("vendor", sourceId).queryKey,
      { id: sourceId, name: "Fixture vendor" },
    );
    const { result } = renderHook(
      () => useRelationshipRouteSource("vendor", sourceId),
      { wrapper: harness.wrapper },
    );

    expect(result.current).toEqual({
      entity: "vendor",
      id: sourceId,
      label: "Fixture vendor",
    });
  });
});
