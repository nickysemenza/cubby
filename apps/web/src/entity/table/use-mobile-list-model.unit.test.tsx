import { displayImagesField } from "@cubby/schemas/display-images";
import { computedFieldEnvelope } from "@cubby/schemas/field-envelope";
import { publicImageUrlSummary } from "@cubby/schemas/image-summary";
import { renderHook, screen } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { renderWithEditorMetadata as render } from "#web/tests/editor-metadata.fixtures.ts";
import { createEditorBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";

import type { CubbyTable as Table } from "../../ui/data-table/table-features";
import { useMobileListModel } from "./use-mobile-list-model";

interface TestRow {
  id: string;
  name: string;
  previewId?: string;
}

describe("useMobileListModel", () => {
  let harness: ReturnType<typeof createEditorBrowserTestHarness>;
  beforeEach(() => {
    harness = createEditorBrowserTestHarness();
  });
  afterEach(() => {
    harness.dispose();
  });
  it("rebuilds pre-rendered cells when external row content changes", () => {
    let preview = "…";
    const column = {
      id: "related:product.vendors",
      columnDef: {
        header: "Vendors",
        cell: () => preview,
        meta: {
          mobile: { slot: "meta" },
          provenance: {
            kind: "derived",
            sources: [
              { entity: null, label: "Vendor projection", relation: null },
            ],
          },
        },
      },
      accessorFn: undefined,
    };
    const table = fromPartial<Table<TestRow>>({
      getRowModel: () => ({
        rows: [
          {
            id: "row-1",
            original: { id: "PRD-TEST", name: "Test product" },
            getVisibleCells: () => [
              {
                column,
                getContext: () => ({}),
                getValue: () => undefined,
              },
            ],
          },
        ],
      }),
    });

    const firstVersion = {};
    const { result, rerender } = renderHook(
      ({ rowContentVersion }) =>
        useMobileListModel({ table, rowContentVersion }),
      {
        initialProps: { rowContentVersion: firstVersion },
        wrapper: harness.wrapper,
      },
    );

    const { rerender: rerenderCell } = render(
      result.current[0]?.metaValues[0]?.value ?? null,
    );
    expect(screen.getByText("…")).toBeInTheDocument();
    expect(
      screen.getByRole("note", { name: "From Vendor projection" }),
    ).toBeInTheDocument();
    preview = "<vendor name>";
    rerender({ rowContentVersion: {} });
    rerenderCell(result.current[0]?.metaValues[0]?.value ?? null);
    expect(screen.getByText("<vendor name>")).toBeInTheDocument();
  });

  it("uses a per-row canonical detail route for heterogeneous lists", () => {
    const column = {
      id: "name",
      columnDef: { header: "Name", cell: () => "Candidate" },
      accessorFn: () => "Candidate",
    };
    const table = fromPartial<Table<TestRow>>({
      getVisibleLeafColumns: () => [column],
      getRowModel: () => ({
        rows: [
          {
            id: "WSH-ONE:PRD-TWO",
            original: {
              id: "WSH-ONE:PRD-TWO",
              name: "Candidate",
              previewId: "PRD-TWO",
            },
            getVisibleCells: () => [],
          },
        ],
      }),
    });

    const { result } = renderHook(
      () =>
        useMobileListModel({
          table,
          entity: "wish",
          getDetailsHref: (row) => `/products/${row.previewId}`,
        }),
      { wrapper: harness.wrapper },
    );

    expect(result.current[0]?.detailsHref).toBe("/products/PRD-TWO");
  });

  it("suppresses implicit entity routes for specialist mobile interactions", () => {
    const column = {
      id: "name",
      columnDef: { header: "Name", cell: () => "Ingredient" },
      accessorFn: () => "Ingredient",
    };
    const table = fromPartial<Table<TestRow>>({
      getVisibleLeafColumns: () => [column],
      getRowModel: () => ({
        rows: [
          {
            id: "ING-ONE",
            original: { id: "ING-ONE", name: "Ingredient" },
            getVisibleCells: () => [],
          },
        ],
      }),
    });

    const { result } = renderHook(
      () =>
        useMobileListModel({
          table,
          entity: "ingredient",
          getDetailsHref: () => "/ingredients/ING-ONE",
          disableDetailsHref: true,
        }),
      { wrapper: harness.wrapper },
    );

    expect(result.current[0]?.detailsHref).toBeUndefined();
  });
});

it("reserves mobile image slots for canonical covers and bounded specialist inputs", () => {
  const cover = computedFieldEnvelope(displayImagesField);
  const image = {
    fields: {
      url: fieldValueFixture(
        publicImageUrlSummary.shape.fields.shape.url,
        "https://example.test/own.jpg",
      ),
    },
  };
  const images = computedFieldEnvelope(z.array(publicImageUrlSummary));
  const cases = [
    {
      fields: {
        displayImages: fieldValueFixture(cover, [
          { id: "IMG-4K7M", url: "https://example.test/cover.jpg" },
        ]),
      },
      expected: true,
    },
    {
      fields: { displayImages: fieldValueFixture(cover, undefined) },
      imageUrl: "https://example.test/stale.jpg",
      expected: false,
    },
    {
      fields: { displayImages: fieldValueFixture(cover, []) },
      imageUrl: "https://example.test/stale.jpg",
      expected: false,
    },
    { fields: { images: fieldValueFixture(images, [image]) }, expected: true },
    {
      product: { fields: { images: fieldValueFixture(images, [image]) } },
      expected: true,
    },
    { imageUrl: "https://example.test/snapshot.jpg", expected: true },
    {
      displayImages: [
        { id: "IMG-4K7M", url: "https://example.test/retired.jpg" },
      ],
      expected: false,
    },
  ];
  for (const { expected, ...input } of cases) {
    const original = { id: "PRD-4K7M", ...input };
    const table = fromPartial<Table<typeof original>>({
      getRowModel: () => ({
        rows: [
          {
            id: original.id,
            original,
            getVisibleCells: () => [
              {
                column: {
                  id: "image",
                  columnDef: {
                    cell: () => <span>Image slot</span>,
                    meta: { mobile: { slot: "image" } },
                  },
                },
                getContext: () => ({}),
                getValue: () => null,
              },
            ],
          },
        ],
      }),
    });
    const { result, unmount } = renderHook(
      () => useMobileListModel({ table }),
      { wrapper: harness.wrapper },
    );
    expect(Boolean(result.current[0]?.imageSlot)).toBe(expected);
    unmount();
  }
});
