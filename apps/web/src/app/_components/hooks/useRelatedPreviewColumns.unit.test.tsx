import type { RelatedPreviewGroup } from "@cubby/schemas/related-view";
import { relatedViewsFor } from "@cubby/schemas/related-view";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { relatedData } from "~/lib/related-data.functions";
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
