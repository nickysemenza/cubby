import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShelfGrid } from "~/entity/table/shelf";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { EntityShelf } from "./entity-shelf";
import { recordCaption } from "./record-caption";

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;
afterEach(() => {
  harness?.dispose();
});

describe("entity cards", () => {
  it("keeps dedicated Product fields out of the table identity caption", () => {
    expect(
      recordCaption(
        "product",
        {
          id: "PRD-2345",
          price: 12,
          categoryId: "CAT-2345",
          category: { id: "CAT-2345", name: "Synthetic category" },
        },
        { excludeListFields: true },
      ),
    ).toBeUndefined();
  });

  it("retains card identity while deferred media is pending or fails", () => {
    harness = createBrowserTestHarness();
    const { rerender } = render(
      <EntityShelf
        entity="product"
        items={[{ id: "PRD-2345", name: "Synthetic product" }]}
        enrichmentState={() => ({ state: "loading" })}
      />,
      { wrapper: harness.wrapper },
    );
    expect(
      screen.getByRole("link", { name: "Synthetic product" }),
    ).toHaveAttribute("href", "/products/PRD-2345");
    expect(screen.getAllByLabelText("Loading media").length).toBeGreaterThan(0);
    rerender(
      <EntityShelf
        entity="product"
        items={[{ id: "PRD-2345", name: "Synthetic product" }]}
        enrichmentState={() => ({
          state: "error",
          error: "Synthetic media failure",
        })}
      />,
    );
    expect(screen.getByText("Synthetic media failure")).toBeVisible();
  });

  it("sections cards by explicit membership and filters to a section", () => {
    const onFilter = vi.fn();
    render(
      <ShelfGrid
        items={["Alpha one", "Alpha two", "Beta one", "No value one"]}
        getItemId={(item) => item}
        renderCard={(item) => <div key={item}>{item}</div>}
        grouping={{
          choice: {
            key: "category",
            label: "Category",
            noValueLabel: "No category",
            reason: null,
            multiple: false,
            dateKind: null,
            buckets: [],
            value: { kind: "derived", options: null },
            filter: {
              columnId: "category",
              noValue: false,
              subtree: null,
            },
            levels: 0,
            levelReason: "Category has no levels.",
          },
          groups: [
            { value: "alpha", label: "Alpha", count: 2 },
            { value: "beta", label: "Beta", count: 1 },
            { value: FILTER_NONE, label: "No category", count: 1 },
            { value: "gamma", label: "Gamma", count: 3 },
          ].map(({ value, label, count }) => ({
            key: JSON.stringify([value]),
            path: [value],
            label,
            count,
            parentCount: 7,
            fraction: count / 7,
            overlapping: false,
          })),
          memberships: [
            { id: "Alpha one", path: ["alpha"] },
            { id: "Alpha two", path: ["alpha"] },
            { id: "Beta one", path: ["beta"] },
            { id: "No value one", path: [FILTER_NONE] },
          ],
          onFilter,
        }}
      />,
    );
    const sections = screen.getAllByRole("region");
    expect(
      sections.map((section) => section.getAttribute("aria-label")),
    ).toEqual(["Alpha", "Beta", "No category"]);
    expect(within(sections[0]!).getByText("2")).toBeVisible();
    expect(within(sections[1]!).getByText("Beta one")).toBeVisible();
    expect(within(sections[2]!).getByText("No value one")).toBeVisible();
    expect(
      within(sections[2]!).queryByRole("button", { name: /Filter to this/ }),
    ).toBeNull();
    fireEvent.click(
      within(sections[1]!).getByRole("button", { name: /Filter to this/ }),
    );
    expect(onFilter).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ["beta"],
        label: "Beta",
        count: 1,
      }),
    );
  });

  it("uses uploaded image records directly and keeps unfinished uploads as icon tiles", () => {
    harness = createBrowserTestHarness();
    render(
      <EntityShelf
        entity="image"
        items={[
          {
            id: "IMG-2345",
            filename: "Uploaded photo",
            status: "UPLOADED",
            url: "https://example.com/photo.jpg",
          },
          {
            id: "IMG-6789",
            filename: "Pending photo",
            status: "PENDING",
            url: "https://example.com/pending.jpg",
          },
        ]}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByRole("img", { name: "Uploaded photo" })).toHaveAttribute(
      "src",
      expect.stringContaining("photo.jpg"),
    );
    expect(
      screen.getByRole("img", { name: "Pending photo" }),
    ).not.toHaveAttribute("src");
    expect(screen.getByRole("link", { name: "Pending photo" })).toHaveAttribute(
      "href",
      "/images/IMG-6789",
    );
  });

  it("retains loaded cards after a page failure and exposes retry", () => {
    harness = createBrowserTestHarness();
    const retry = vi.fn();
    render(
      <ShelfGrid
        items={["Loaded record"]}
        getItemId={(item) => item}
        renderCard={(item) => <div key={item}>{item}</div>}
        error={new Error("Page unavailable")}
        onRetry={retry}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByText("Loaded record")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
