import type { RelatedPreviewGroup } from "@cubby/schemas/related-view";
import { relatedViewsFor } from "@cubby/schemas/related-view";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { relatedData } from "~/integrations/tanstack-query/generated/catalog.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { createCubbyColumnHelper } from "../data-table/table-features";
import {
  type RelatedPreviewOperations,
  useRelatedPreviewColumns,
} from "./useRelatedPreviewColumns";

interface TestRow {
  id: string;
}

const columnHelper = createCubbyColumnHelper<TestRow>();
const relatedViews = relatedViewsFor("product").filter(
  (view) => view.key === "product.vendors",
);
const result: RelatedPreviewGroup[] = [
  {
    sourceId: "PRD-TEST",
    relationKey: "product.vendors",
    totalCount: 1,
    items: [
      {
        entity: "vendor",
        id: "VEN-TEST",
        label: "Moore Newton",
        displayImage: null,
      },
    ],
  },
];

let harness: ReturnType<typeof createBrowserTestHarness>;

interface RelatedPreviewTestAdapter {
  operations: RelatedPreviewOperations;
  resolve: () => void;
}

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function createOperations(): RelatedPreviewTestAdapter {
  let deliver: ((groups: RelatedPreviewGroup[]) => void) | undefined;
  return {
    operations: {
      previews: relatedData.previews.withTransport(
        async () =>
          await new Promise<RelatedPreviewGroup[]>((resolve) => {
            deliver = resolve;
          }),
      ),
    },
    resolve: () => deliver?.(result),
  };
}

describe("useRelatedPreviewColumns", () => {
  it("does not construct preview queries when no relation columns are visible", () => {
    const requestedIds: string[][] = [];
    const operations: RelatedPreviewOperations = {
      previews: relatedData.previews.withTransport(async ({ input }) => {
        requestedIds.push(input.sourceIds);
        return [];
      }),
    };

    expect(() =>
      renderHook(
        () =>
          useRelatedPreviewColumns({
            entity: "product",
            sourceIds: Array.from(
              { length: 1001 },
              (_, index) => `PRD-${index}`,
            ),
            visibleRelationKeys: [],
            relatedViews,
            columnHelper,
            supportsServerSorting: true,
            operations,
          }),
        { wrapper: harness.wrapper },
      ),
    ).not.toThrow();

    expect(requestedIds).toEqual([]);
  });

  it("loads and merges preview groups across the 1000 source ID boundary", async () => {
    const requestedIds: string[][] = [];
    const sourceIds = Array.from(
      { length: 1001 },
      (_, index) => `PRD-${index}`,
    );
    const operations: RelatedPreviewOperations = {
      previews: relatedData.previews.withTransport(async ({ input }) => {
        requestedIds.push(input.sourceIds);
        return input.sourceIds.map((sourceId) => ({
          sourceId,
          relationKey: "product.vendors" as const,
          totalCount: 0,
          items: [],
        }));
      }),
    };

    const { result: hook } = renderHook(
      () =>
        useRelatedPreviewColumns({
          entity: "product",
          sourceIds,
          visibleRelationKeys: ["product.vendors"],
          relatedViews,
          columnHelper,
          supportsServerSorting: true,
          operations,
        }),
      { wrapper: harness.wrapper },
    );

    await waitFor(() =>
      expect(hook.current.rowContentVersion.byCell.size).toBe(1001),
    );

    expect(requestedIds.map((ids) => ids.length)).toEqual([1000, 1]);
    expect(
      hook.current.rowContentVersion.byCell.has("PRD-0:product.vendors"),
    ).toBe(true);
    expect(
      hook.current.rowContentVersion.byCell.has("PRD-1000:product.vendors"),
    ).toBe(true);
  });

  it("keeps loaded chunks visible while other source IDs are still loading", async () => {
    const sourceIds = Array.from(
      { length: 1001 },
      (_, index) => `PRD-${index}`,
    );
    let finishLastChunk: (() => void) | undefined;
    const operations: RelatedPreviewOperations = {
      previews: relatedData.previews.withTransport(async ({ input }) => {
        if (input.sourceIds[0] === "PRD-1000") {
          return await new Promise<RelatedPreviewGroup[]>((resolve) => {
            finishLastChunk = () => resolve([]);
          });
        }
        return input.sourceIds.map((sourceId) => ({
          sourceId,
          relationKey: "product.vendors" as const,
          totalCount: 0,
          items: [],
        }));
      }),
    };

    const { result: hook } = renderHook(
      () =>
        useRelatedPreviewColumns({
          entity: "product",
          sourceIds,
          visibleRelationKeys: ["product.vendors"],
          relatedViews,
          columnHelper,
          supportsServerSorting: true,
          operations,
        }),
      { wrapper: harness.wrapper },
    );

    await waitFor(() =>
      expect(hook.current.rowContentVersion.byCell.size).toBe(1000),
    );

    expect(hook.current.rowContentVersion.loadingSourceIds.has("PRD-0")).toBe(
      false,
    );
    expect(
      hook.current.rowContentVersion.loadingSourceIds.has("PRD-1000"),
    ).toBe(true);

    act(() => finishLastChunk?.());
  });

  it("exposes the raw error for the source IDs in a failed chunk", async () => {
    const sourceIds = Array.from(
      { length: 1001 },
      (_, index) => `PRD-${index}`,
    );
    const failure = new Error("synthetic related preview failure");
    const operations: RelatedPreviewOperations = {
      previews: relatedData.previews.withTransport(async ({ input }) => {
        if (input.sourceIds[0] === "PRD-1000") throw failure;
        return [];
      }),
    };

    const { result: hook } = renderHook(
      () =>
        useRelatedPreviewColumns({
          entity: "product",
          sourceIds,
          visibleRelationKeys: ["product.vendors"],
          relatedViews,
          columnHelper,
          supportsServerSorting: true,
          operations,
        }),
      { wrapper: harness.wrapper },
    );

    await waitFor(() =>
      expect(
        hook.current.rowContentVersion.errorsBySourceId.get("PRD-1000"),
      ).toBe(failure),
    );
  });

  it("keeps definitions stable while its real preview operation resolves", async () => {
    const adapter = createOperations();
    const { result: hook } = renderHook(
      () =>
        useRelatedPreviewColumns({
          entity: "product",
          sourceIds: ["PRD-TEST"],
          visibleRelationKeys: ["product.vendors"],
          relatedViews,
          columnHelper,
          supportsServerSorting: true,
          operations: adapter.operations,
        }),
      { wrapper: harness.wrapper },
    );
    const columnsWhileLoading = hook.current.relatedColumns;
    const versionWhileLoading = hook.current.rowContentVersion;

    act(adapter.resolve);
    await waitFor(() =>
      expect(hook.current.rowContentVersion).not.toBe(versionWhileLoading),
    );

    expect(hook.current.relatedColumns).toBe(columnsWhileLoading);
    expect(hook.current.relatedColumns).toHaveLength(1);
  });
});
