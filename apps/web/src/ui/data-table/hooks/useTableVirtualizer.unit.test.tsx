import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  tableOverscan,
  flatRowToVirtualIndex,
  type GroupedItem,
  resolveVirtualIndex,
  tableVirtualItemKey,
  useTableVirtualizer,
} from "./useTableVirtualizer";

class TestResizeObserver implements ResizeObserver {
  static instances: TestResizeObserver[] = [];

  readonly observedElements = new Set<Element>();
  readonly observe = vi.fn((element: Element) => {
    this.observedElements.add(element);
  });
  readonly unobserve = vi.fn((element: Element) => {
    this.observedElements.delete(element);
  });
  readonly disconnect = vi.fn(() => {
    this.observedElements.clear();
  });

  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  trigger() {
    this.callback([], this);
  }
}

const ROW_KEYS = Array.from({ length: 100 }, (_, index) => `row-${index}`);

function isScrollToOptions(
  value: number | ScrollToOptions | undefined,
): value is ScrollToOptions {
  return typeof value === "object" && value !== null;
}

function Harness() {
  const virtualizer = useTableVirtualizer({
    rowCount: ROW_KEYS.length,
    rowKeys: ROW_KEYS,
    groupedItems: null,
    rowHeight: 28,
    isMobile: false,
  });

  return (
    <div ref={virtualizer.paneWrapperRef} data-pane-wrapper="true">
      <div
        ref={virtualizer.tableContainerRef}
        data-testid="pane"
        data-max-height={virtualizer.paneMaxHeight ?? ""}
        data-virtual-count={virtualizer.virtualRows.length}
      >
        <button type="button" onClick={() => virtualizer.scrollToIndex(50)}>
          Jump to row
        </button>
      </div>
    </div>
  );
}

function RestoreHarness({
  rowCount,
  initialOffset,
}: {
  rowCount: number;
  initialOffset: number;
}) {
  const virtualizer = useTableVirtualizer({
    rowCount,
    rowKeys: ROW_KEYS.slice(0, rowCount),
    groupedItems: null,
    rowHeight: 28,
    isMobile: false,
    initialOffset,
  });
  return (
    <div ref={virtualizer.paneWrapperRef}>
      <div
        ref={virtualizer.tableContainerRef}
        data-testid="restore-pane"
        data-first-row={virtualizer.virtualRows[0]?.index ?? ""}
        data-total={virtualizer.totalSize}
      />
    </div>
  );
}

/** A pane whose scroll range follows its rendered total, like a real one. */
function fakeScrollablePane(pane: HTMLElement) {
  let top = 0;
  Object.defineProperties(pane, {
    clientHeight: { configurable: true, get: () => 300 },
    scrollHeight: {
      configurable: true,
      get: () => Number(pane.dataset.total ?? 0),
    },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, pane.scrollHeight - 300));
      },
    },
  });
}

// Regression: the router restored a deep offset while the pane was still one
// page tall, so the browser clamped scrollTop to 0 while the virtualizer kept
// rendering rows at the restored offset — a blank table, and range-driven
// prefetch then loaded page after page.
describe("useTableVirtualizer scroll restoration", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies a restored offset once enough rows exist to reach it", () => {
    const { rerender } = render(
      <RestoreHarness rowCount={10} initialOffset={1400} />,
    );
    const pane = screen.getByTestId("restore-pane");
    fakeScrollablePane(pane);
    rerender(<RestoreHarness rowCount={20} initialOffset={1400} />);
    expect(pane.scrollTop).toBe(0);
    rerender(<RestoreHarness rowCount={100} initialOffset={1400} />);
    expect(pane.scrollTop).toBe(1400);
  });

  it("drops a pending restore once the person scrolls", () => {
    const { rerender } = render(
      <RestoreHarness rowCount={10} initialOffset={1400} />,
    );
    const pane = screen.getByTestId("restore-pane");
    fakeScrollablePane(pane);
    fireEvent.wheel(pane);
    rerender(<RestoreHarness rowCount={100} initialOffset={1400} />);
    expect(pane.scrollTop).toBe(0);
  });
});

describe("useTableVirtualizer pane scrolling", () => {
  let wrapperTop = 220;
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    wrapperTop = 220;
    TestResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    window.innerHeight = 900;

    rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const top = this.dataset.paneWrapper === "true" ? wrapperTop : 0;
        return {
          x: 0,
          y: top,
          top,
          right: 0,
          bottom: top,
          left: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        };
      });
  });

  afterEach(() => {
    rectSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("scrolls the pane rather than the window", () => {
    render(<Harness />);

    const pane = screen.getByTestId("pane");
    const scrollRequests: ScrollToOptions[] = [];
    pane.scrollTo = (options) => {
      if (isScrollToOptions(options)) scrollRequests.push(options);
    };

    fireEvent.click(screen.getByRole("button", { name: "Jump to row" }));

    expect(scrollRequests.at(-1)).toEqual(
      expect.objectContaining({ top: expect.any(Number) }),
    );
    expect(pane).toHaveAttribute("data-virtual-count");
  });

  it("bounds the pane to the viewport left beneath the wrapper", () => {
    render(<Harness />);

    expect(screen.getByTestId("pane")).toHaveAttribute(
      "data-max-height",
      "672",
    );
  });

  it("remeasures when the wrapper moves", () => {
    const { unmount } = render(<Harness />);

    const wrapper = screen.getByTestId("pane").parentElement;
    if (!wrapper) throw new Error("Pane wrapper was not created");
    const wrapperObserver = TestResizeObserver.instances.find((observer) =>
      observer.observedElements.has(wrapper),
    );
    expect(wrapperObserver?.observe).toHaveBeenCalled();

    wrapperTop = 400;
    act(() => {
      wrapperObserver?.trigger();
    });

    expect(screen.getByTestId("pane")).toHaveAttribute(
      "data-max-height",
      "492",
    );

    unmount();
    expect(wrapperObserver?.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps a usable height on a short viewport", () => {
    window.innerHeight = 300;
    wrapperTop = 260;
    render(<Harness />);

    expect(screen.getByTestId("pane")).toHaveAttribute(
      "data-max-height",
      "320",
    );
  });
});

const grouped: GroupedItem[] = [
  { kind: "header", title: "A", count: 2, color: "var(--chart-1)" },
  { kind: "row", rowIndex: 0, groupRowIndex: 0 },
  { kind: "row", rowIndex: 1, groupRowIndex: 1 },
  { kind: "header", title: "B", count: 1, color: "var(--chart-2)" },
  { kind: "row", rowIndex: 2, groupRowIndex: 0 },
];

describe("tableOverscan", () => {
  // Regression: overscan was sized from the window, so a 60vh related table
  // (18 visible rows) rendered ~30 extra rows each side — every row of a
  // 50-row table, in every table on a detail page.
  it("sizes overscan from the pane, not the window", () => {
    expect(tableOverscan(576, 32)).toBe(6);
    expect(tableOverscan(1440, 32)).toBe(15);
  });

  it("keeps a floor for short panes and a ceiling for tall ones", () => {
    expect(tableOverscan(0, 32)).toBe(6);
    expect(tableOverscan(4000, 32)).toBe(16);
  });
});

describe("resolveVirtualIndex", () => {
  it("maps virtual index directly to a flat row index when ungrouped", () => {
    expect(resolveVirtualIndex(0, null)).toEqual({ kind: "row", rowIndex: 0 });
    expect(resolveVirtualIndex(5, null)).toEqual({ kind: "row", rowIndex: 5 });
  });

  it("returns the header item at header positions when grouped", () => {
    expect(resolveVirtualIndex(0, grouped)).toEqual({
      kind: "header",
      title: "A",
      count: 2,
      color: "var(--chart-1)",
    });
    expect(resolveVirtualIndex(3, grouped)).toEqual({
      kind: "header",
      title: "B",
      count: 1,
      color: "var(--chart-2)",
    });
  });

  it("resolves grouped row positions to their flat row index (offset by headers)", () => {
    expect(resolveVirtualIndex(1, grouped)).toEqual({
      kind: "row",
      rowIndex: 0,
      groupRowIndex: 0,
    });
    expect(resolveVirtualIndex(2, grouped)).toEqual({
      kind: "row",
      rowIndex: 1,
      groupRowIndex: 1,
    });
    expect(resolveVirtualIndex(4, grouped)).toEqual({
      kind: "row",
      rowIndex: 2,
      groupRowIndex: 0,
    });
  });

  it("maps the trailing index to the infinite-scroll sentinel", () => {
    expect(resolveVirtualIndex(3, null, true, 3)).toEqual({
      kind: "sentinel",
    });
    expect(resolveVirtualIndex(5, grouped, true, 3)).toEqual({
      kind: "sentinel",
    });
  });
});

describe("tableVirtualItemKey", () => {
  const rowKeys = ["EXP-A", "EXP-B", "EXP-C"];

  it("uses entity ids rather than virtual indexes for flat rows", () => {
    expect(tableVirtualItemKey(1, rowKeys, null)).toBe("row:EXP-B");
  });

  it("keeps grouped headers, rows, and the sentinel in separate key spaces", () => {
    expect(tableVirtualItemKey(0, rowKeys, grouped, true)).toBe("group:A");
    expect(tableVirtualItemKey(2, rowKeys, grouped, true)).toBe("row:EXP-B");
    expect(tableVirtualItemKey(grouped.length, rowKeys, grouped, true)).toBe(
      "sentinel:infinite",
    );
  });
});

describe("flatRowToVirtualIndex", () => {
  it("is the identity mapping when ungrouped", () => {
    expect(flatRowToVirtualIndex(0, null)).toBe(0);
    expect(flatRowToVirtualIndex(7, null)).toBe(7);
  });

  it("skips past section headers when grouped", () => {
    expect(flatRowToVirtualIndex(0, grouped)).toBe(1);
    expect(flatRowToVirtualIndex(1, grouped)).toBe(2);
    expect(flatRowToVirtualIndex(2, grouped)).toBe(4);
  });

  it("returns -1 for a flat row index that isn't present", () => {
    expect(flatRowToVirtualIndex(99, grouped)).toBe(-1);
  });

  it("round-trips: a flat row maps to a virtual index that resolves back", () => {
    for (const rowIndex of [0, 1, 2]) {
      const virtualIndex = flatRowToVirtualIndex(rowIndex, grouped);
      expect(resolveVirtualIndex(virtualIndex, grouped)).toMatchObject({
        kind: "row",
        rowIndex,
      });
    }
  });
});
