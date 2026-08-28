import type { Entity } from "@cubby/schemas/entity";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { entityPreviewQueryOptions } from "~/entities/entity-query";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type EntityPreviewBrowserOperations,
  type EntityPreviewRendererProps,
  type PreviewPresentation,
  type PreviewPresentationPort,
  useEntityPreview,
  type UseEntityPreviewOptions,
} from "./useEntityPreview";

const row = (id: string) => ({ original: { id } });

class MemoryPreviewOperations implements EntityPreviewBrowserOperations {
  readonly navigations: Array<{ entity: Entity; id: string }> = [];
  readonly prefetches: Array<{ entity: Entity; id: string }> = [];
  readonly cancellations: Array<readonly unknown[]> = [];

  navigateToDetail(entity: Entity, id: string) {
    this.navigations.push({ entity, id });
  }

  prefetchDetail(entity: Entity, id: string) {
    this.prefetches.push({ entity, id });
  }

  cancelPrefetch(queryKey: readonly unknown[]) {
    this.cancellations.push(queryKey);
  }
}

class MemoryPreviewPresentation implements PreviewPresentationPort {
  private presentation: PreviewPresentation = "mobile";
  private readonly listeners = new Set<() => void>();

  getSnapshot = () => this.presentation;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(presentation: PreviewPresentation) {
    this.presentation = presentation;
    for (const listener of this.listeners) listener();
  }
}

const renderTestInspector = ({ preview }: EntityPreviewRendererProps) => (
  <div data-testid="workbench-inspector">
    {preview.entityType}:{preview.id}
  </div>
);

let harness: ReturnType<typeof createBrowserTestHarness>;
let browserOperations: MemoryPreviewOperations;
let presentationPort: MemoryPreviewPresentation;

function renderPreviewHook(
  entity?: Entity,
  options: UseEntityPreviewOptions = {},
) {
  return renderHook(
    () =>
      useEntityPreview(entity, {
        renderInspector: renderTestInspector,
        ...options,
        browserOperations,
        presentationPort,
      }),
    { wrapper: harness.wrapper },
  );
}

describe("useEntityPreview intent prefetch", () => {
  beforeEach(() => {
    harness = createBrowserTestHarness();
    browserOperations = new MemoryPreviewOperations();
    presentationPort = new MemoryPreviewPresentation();
    vi.useFakeTimers();
  });

  it("opens the selected record through the shared desktop inspector command", () => {
    presentationPort.set("dock");
    const { result } = renderPreviewHook("product", {
      responsiveInspector: true,
    });

    act(() => result.current.inspectRow(row("PRD-4K7M")));

    expect(result.current.preview).toMatchObject({
      entityType: "product",
      id: "PRD-4K7M",
    });
    expect(result.current.isInspectorOpen).toBe(true);
    expect(browserOperations.navigations).toEqual([]);
  });

  it("publishes the responsive presentation for card rosters that retain phone navigation", () => {
    const { result } = renderPreviewHook("product", {
      responsiveInspector: true,
    });

    expect(result.current.presentation).toBe("mobile");
    act(() => presentationPort.set("sheet"));
    expect(result.current.presentation).toBe("sheet");
    act(() => presentationPort.set("dock"));
    expect(result.current.presentation).toBe("dock");
  });

  it("sends a selected USDA record to its canonical phone route", () => {
    const { result } = renderPreviewHook("usda-food", {
      idField: "fdc_id",
      responsiveInspector: true,
    });

    act(() =>
      result.current.inspectRow({ original: { id: "row-1", fdc_id: 12345 } }),
    );

    expect(browserOperations.navigations).toEqual([
      { entity: "usda-food", id: "12345" },
    ]);
    expect(result.current.preview).toBeNull();
  });

  afterEach(() => {
    vi.useRealTimers();
    harness.dispose();
  });

  it("does not fan out detail requests while the pointer sweeps rows", () => {
    const { result } = renderPreviewHook("product");

    act(() => {
      for (let index = 0; index < 10; index += 1) {
        result.current.onRowHover(row(`PRD-${index}`));
      }
    });

    expect(browserOperations.prefetches).toEqual([]);
    act(() => vi.advanceTimersByTime(199));
    expect(browserOperations.prefetches).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    expect(browserOperations.prefetches).toEqual([
      { entity: "product", id: "PRD-9" },
    ]);
  });

  it("cancels a dispatched prefetch after intent ends", () => {
    const { result } = renderPreviewHook("product");
    const hovered = row("PRD-4K7M");

    act(() => result.current.onRowHover(hovered));
    act(() => vi.advanceTimersByTime(200));
    act(() => result.current.onRowHoverEnd(hovered));

    expect(browserOperations.cancellations).toEqual([
      entityPreviewQueryOptions("product", "PRD-4K7M").queryKey,
    ]);
  });

  it("commits a pending intent on click without starting a second prefetch", () => {
    const { result } = renderPreviewHook("product");
    const hovered = row("PRD-4K7M");

    act(() => result.current.onRowHover(hovered));
    act(() => result.current.onRowClick(hovered));
    act(() => vi.advanceTimersByTime(200));

    expect(result.current.preview).toEqual({
      entityType: "product",
      id: "PRD-4K7M",
      rowKey: "PRD-4K7M",
    });
    expect(browserOperations.prefetches).toEqual([]);
    expect(browserOperations.cancellations).toEqual([]);
  });

  it("docks the selected inspector at desktop widths", () => {
    presentationPort.set("dock");
    const { result } = renderPreviewHook("product", {
      responsiveInspector: true,
    });

    act(() => result.current.onRowClick(row("PRD-4K7M")));
    render(result.current.dockedInspector);

    expect(screen.getByTestId("workbench-inspector")).toHaveTextContent(
      "product:PRD-4K7M",
    );
  });

  it("retains the selected row while closing and reopening the inspector", () => {
    presentationPort.set("dock");
    const { result } = renderPreviewHook("product", {
      responsiveInspector: true,
    });
    const view = render(
      <>
        {result.current.inspectorToggle}
        {result.current.dockedInspector}
      </>,
    );

    expect(
      screen.getByRole("button", { name: "Open inspector" }),
    ).toBeDisabled();

    act(() => result.current.onRowClick(row("PRD-4K7M")));
    view.rerender(
      <>
        {result.current.inspectorToggle}
        {result.current.dockedInspector}
      </>,
    );
    expect(
      screen.getByRole("button", { name: "Close inspector" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("workbench-inspector")).toHaveTextContent(
      "product:PRD-4K7M",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    view.rerender(
      <>
        {result.current.inspectorToggle}
        {result.current.dockedInspector}
      </>,
    );
    expect(result.current.preview).toEqual({
      entityType: "product",
      id: "PRD-4K7M",
      rowKey: "PRD-4K7M",
    });
    expect(result.current.dockedInspector).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open inspector" }),
    ).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Open inspector" }));
    view.rerender(
      <>
        {result.current.inspectorToggle}
        {result.current.dockedInspector}
      </>,
    );
    expect(screen.getByTestId("workbench-inspector")).toHaveTextContent(
      "product:PRD-4K7M",
    );

    act(() => result.current.onRowClick(row("PRD-9T2Q")));
    expect(result.current.preview?.id).toBe("PRD-9T2Q");
    expect(result.current.isInspectorOpen).toBe(true);
  });

  it("uses a list-owned inspector renderer through the shared presentation", () => {
    presentationPort.set("dock");
    const rendered: EntityPreviewRendererProps[] = [];
    const renderInspector = (props: EntityPreviewRendererProps) => {
      rendered.push(props);
      return <div data-testid="custom-inspector">{props.preview.id}</div>;
    };
    const { result } = renderPreviewHook("product", {
      responsiveInspector: true,
      renderInspector,
    });

    act(() => result.current.onRowClick(row("PRD-4K7M")));
    const docked = render(result.current.dockedInspector);

    expect(screen.getByTestId("custom-inspector")).toHaveTextContent(
      "PRD-4K7M",
    );
    expect(rendered).toContainEqual(
      expect.objectContaining({
        preview: expect.objectContaining({ id: "PRD-4K7M" }),
      }),
    );

    docked.unmount();
    act(() => presentationPort.set("sheet"));
    render(<result.current.PreviewSheet />);
    expect(screen.getByRole("dialog")).toContainElement(
      screen.getByTestId("custom-inspector"),
    );
  });

  it("uses the same inspector in a compact Sheet at medium widths", () => {
    presentationPort.set("sheet");
    const { result } = renderPreviewHook("product", {
      responsiveInspector: true,
    });

    act(() => result.current.onRowClick(row("PRD-4K7M")));
    render(<result.current.PreviewSheet />);

    expect(result.current.dockedInspector).toBeNull();
    expect(screen.getByRole("dialog")).toContainElement(
      screen.getByTestId("workbench-inspector"),
    );
  });

  it("keeps selection state but renders no inspector on mobile", () => {
    const { result } = renderPreviewHook("product", {
      responsiveInspector: true,
    });

    act(() => result.current.onRowClick(row("PRD-4K7M")));
    render(<result.current.PreviewSheet />);

    expect(result.current.preview).toEqual({
      entityType: "product",
      id: "PRD-4K7M",
      rowKey: "PRD-4K7M",
    });
    expect(result.current.dockedInspector).toBeNull();
    expect(result.current.inspectorToggle).toBeNull();
    expect(screen.queryByTestId("workbench-inspector")).not.toBeInTheDocument();
  });

  it("moves an open preview between dock and Sheet when the viewport changes", () => {
    presentationPort.set("dock");
    const { result } = renderPreviewHook("product", {
      responsiveInspector: true,
    });
    act(() => result.current.onRowClick(row("PRD-4K7M")));

    expect(result.current.dockedInspector).not.toBeNull();
    act(() => presentationPort.set("sheet"));
    render(<result.current.PreviewSheet />);

    expect(result.current.dockedInspector).toBeNull();
    expect(screen.getByTestId("workbench-inspector")).toHaveTextContent(
      "product:PRD-4K7M",
    );
  });

  it("keeps the legacy Sheet visible at desktop widths", () => {
    presentationPort.set("dock");
    const { result } = renderPreviewHook("product");

    act(() => result.current.onRowClick(row("PRD-4K7M")));
    render(<result.current.PreviewSheet />);

    expect(result.current.dockedInspector).toBeNull();
    expect(screen.getByRole("dialog")).toContainElement(
      screen.getByTestId("workbench-inspector"),
    );
  });

  it("keeps the legacy Sheet visible at mobile widths", () => {
    const { result } = renderPreviewHook("product");

    act(() => result.current.onRowClick(row("PRD-4K7M")));
    render(<result.current.PreviewSheet />);

    expect(result.current.dockedInspector).toBeNull();
    expect(screen.getByRole("dialog")).toContainElement(
      screen.getByTestId("workbench-inspector"),
    );
    expect(
      screen.getByRole("heading", { name: "Product PRD-4K7M preview" }),
    ).toBeInTheDocument();
  });

  it("keeps a namespaced roster row selected while previewing its target", () => {
    const { result } = renderPreviewHook(undefined, { idField: "previewId" });
    const candidateRow = {
      id: "WSH-8F2:PRD-4K7M",
      original: {
        id: "WSH-8F2",
        previewId: "PRD-4K7M",
        entityType: "product" as const,
      },
    };

    act(() => result.current.onRowClick(candidateRow));

    expect(result.current.preview).toEqual({
      entityType: "product",
      id: "PRD-4K7M",
      rowKey: "WSH-8F2:PRD-4K7M",
    });
  });
});
