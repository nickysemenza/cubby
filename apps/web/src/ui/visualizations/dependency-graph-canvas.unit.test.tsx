import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { DependencyGraphCanvas } from "./dependency-graph-canvas";
import { DependencyGraphViewer } from "./dependency-graph-viewer";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g class="graph"><g class="node"><title>product:PRD-1</title><a href="/products/PRD-1"><text>Impact driver</text></a></g></g></svg>`;
const originalScrollTo = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);
type LayoutResponse = { svg?: string; error?: string };

class LayoutWorker {
  static response: LayoutResponse = { svg };
  private message?: (
    event: MessageEvent<{ svg?: string; error?: string }>,
  ) => void;

  addEventListener(
    type: string,
    listener: (event: MessageEvent<{ svg?: string; error?: string }>) => void,
  ) {
    if (type === "message") this.message = listener;
  }

  postMessage() {
    this.message?.(
      new MessageEvent("message", { data: LayoutWorker.response }),
    );
  }

  terminate() {}
}

afterEach(() => {
  cleanup();
  LayoutWorker.response = { svg };
  vi.unstubAllGlobals();
  if (originalScrollTo)
    Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

it("selects a graph node for inspection without losing its list/detail navigation", async () => {
  vi.stubGlobal("Worker", LayoutWorker);
  vi.stubGlobal("scrollTo", vi.fn());
  Object.defineProperty(SVGSVGElement.prototype, "viewBox", {
    configurable: true,
    value: { baseVal: { width: 100, height: 100 } },
  });
  const onSelectNode = vi.fn();
  const { container } = render(
    <DependencyGraphCanvas
      dot="digraph {}"
      hierarchyEdges={[]}
      onSelectNode={onSelectNode}
    />,
  );

  const node = await screen.findByRole("button", { name: /Impact driver/ });
  const link = container.querySelector('a[href="/products/PRD-1"]');
  expect(link).not.toBeNull();
  expect(link).toHaveAttribute("tabindex", "-1");
  expect(link).toHaveAttribute("aria-hidden", "true");
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  expect(link?.dispatchEvent(event)).toBe(false);
  expect(onSelectNode).toHaveBeenCalledWith("product:PRD-1");
  expect(node.getAttribute("tabindex")).toBe("0");
});

it("keeps a keyboard-accessible explorer action in the relationship list", async () => {
  vi.stubGlobal("Worker", LayoutWorker);
  vi.stubGlobal("scrollTo", vi.fn());
  Object.defineProperty(SVGSVGElement.prototype, "viewBox", {
    configurable: true,
    value: { baseVal: { width: 100, height: 100 } },
  });
  const onSelectNode = vi.fn();
  render(
    <DependencyGraphViewer
      data={{
        nodes: [
          {
            id: "product:PRD-1",
            kind: "product",
            kindLabel: "Product",
            name: "Impact driver",
            metadata: [],
            href: "/products/PRD-1",
          },
        ],
        edges: [],
      }}
      filters={{
        direction: "all",
        hideCompleted: false,
        hideUnconnected: false,
        reduceEdges: false,
        grouped: false,
      }}
      onSelectNode={onSelectNode}
    />,
  );

  const explore = await screen.findByRole("button", {
    name: "Explore Impact driver",
  });
  explore.click();
  expect(onSelectNode).toHaveBeenCalledWith(
    expect.objectContaining({ id: "product:PRD-1" }),
  );
  expect(screen.getByLabelText("Graph legend")).toHaveTextContent("Product");
  expect(screen.getByLabelText("Graph legend")).not.toHaveTextContent(
    "Dashed border",
  );
  expect(screen.getByLabelText("Graph legend")).not.toHaveTextContent(
    "Red border",
  );
});

it("retains navigable relationships when worker layout fails", async () => {
  LayoutWorker.response = { error: "layout unavailable" };
  vi.stubGlobal("Worker", LayoutWorker);
  render(
    <DependencyGraphViewer
      data={{
        nodes: [
          {
            id: "product:PRD-1",
            kind: "product",
            name: "Impact driver",
            href: "/products/PRD-1",
          },
        ],
        edges: [],
      }}
      filters={{
        direction: "all",
        hideCompleted: false,
        hideUnconnected: false,
        reduceEdges: false,
        grouped: false,
      }}
    />,
  );
  expect(
    await screen.findByText(/Couldn't load the dependency graph layout/),
  ).toBeVisible();
  expect(screen.getByText("layout unavailable")).toBeVisible();
  fireEvent.click(screen.getByText("Record and relationship list (1)"));
  expect(screen.getByRole("link", { name: "Impact driver" })).toHaveAttribute(
    "href",
    "/products/PRD-1",
  );
  expect(screen.getByRole("button", { name: /retry/i })).toBeEnabled();
});

it("zooms at the trackpad pointer while leaving ordinary scrolling alone", async () => {
  vi.stubGlobal("Worker", LayoutWorker);
  vi.stubGlobal("scrollTo", vi.fn());
  Object.defineProperty(SVGSVGElement.prototype, "viewBox", {
    configurable: true,
    value: { baseVal: { width: 100, height: 100 } },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  render(<DependencyGraphCanvas dot="digraph {}" hierarchyEdges={[]} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeEnabled(),
  );
  const canvas = screen.getByRole("region", {
    name: "Scrollable dependency graph",
  });
  const scrollTo = vi.fn();
  Object.defineProperty(canvas, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  canvas.scrollLeft = 100;
  canvas.scrollTop = 50;
  const pinch = new WheelEvent("wheel", {
    ctrlKey: true,
    deltaY: -10,
    clientX: 20,
    clientY: 30,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(canvas, pinch);
  expect(pinch.defaultPrevented).toBe(true);
  expect(screen.getByLabelText("Graph zoom")).toHaveTextContent("111%");
  expect(scrollTo).toHaveBeenLastCalledWith({
    left: expect.closeTo(120 * Math.exp(0.1) - 20),
    top: expect.closeTo(80 * Math.exp(0.1) - 30),
  });
  const scroll = new WheelEvent("wheel", {
    deltaY: 20,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(canvas, scroll);
  expect(scroll.defaultPrevented).toBe(false);
  expect(scrollTo).toHaveBeenCalledTimes(1);
  fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -1000 });
  expect(screen.getByLabelText("Graph zoom")).toHaveTextContent("200%");
  fireEvent.wheel(canvas, { ctrlKey: true, deltaY: 1000 });
  expect(screen.getByLabelText("Graph zoom")).toHaveTextContent("5%");
  fireEvent.click(screen.getByRole("button", { name: "Readable view" }));
  fireEvent(canvas, new Event("gesturestart", { cancelable: true }));
  const gesture = Object.assign(
    new Event("gesturechange", { cancelable: true }),
    { scale: 1.5 },
  );
  fireEvent(canvas, gesture);
  expect(gesture.defaultPrevented).toBe(true);
  expect(screen.getByLabelText("Graph zoom")).toHaveTextContent("150%");
  fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -10 });
  expect(screen.getByLabelText("Graph zoom")).toHaveTextContent("150%");
  fireEvent(canvas, new Event("gestureend", { cancelable: true }));
});

it("highlights and inspects parallel connections without restarting layout or zoom", async () => {
  const edges = [
    {
      id: "one",
      source: "a",
      target: "b",
      kind: "relationship" as const,
      label: "Purchases",
    },
    {
      id: "two",
      source: "a",
      target: "b",
      kind: "relationship" as const,
      label: "Expenses",
    },
    {
      id: "other",
      source: "b",
      target: "c",
      kind: "relationship" as const,
      label: "Vendor",
    },
  ];
  LayoutWorker.response = {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g class="graph"><g class="node"><title>a</title><text>Record A</text></g><g class="edge graph-edge-one"><path/><text>Purchases</text></g><g class="edge graph-edge-two"><path/><text>Expenses</text></g><g class="edge graph-edge-other"><path/><text>Vendor</text></g></g></svg>',
  };
  vi.stubGlobal("Worker", LayoutWorker);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(SVGSVGElement.prototype, "viewBox", {
    configurable: true,
    value: { baseVal: { width: 100, height: 100 } },
  });
  const post = vi.spyOn(LayoutWorker.prototype, "postMessage");
  const select = vi.fn();
  const { rerender } = render(
    <DependencyGraphCanvas
      dot="example"
      edges={edges}
      hierarchyEdges={[]}
      onSelectNode={() => {}}
      onSelectEdge={select}
    />,
  );
  const purchase = await screen.findByRole("button", {
    name: "Purchases: a to b",
  });
  const expense = screen.getByRole("button", { name: "Expenses: a to b" });
  const vendor = screen.getByRole("button", { name: "Vendor: b to c" });
  fireEvent.mouseEnter(screen.getByRole("button", { name: /Record A/ }));
  expect(purchase).toHaveClass("graph-edge-active");
  expect(expense).toHaveClass("graph-edge-active");
  expect(vendor).toHaveClass("graph-edge-muted");
  fireEvent.focus(expense);
  fireEvent.keyDown(expense, { key: "Enter" });
  expect(select).toHaveBeenLastCalledWith("two");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  const zoom = screen.getByLabelText("Graph zoom").textContent;
  rerender(
    <DependencyGraphCanvas
      dot="example"
      edges={[...edges]}
      hierarchyEdges={[]}
      selectedEdgeId="two"
      onSelectNode={() => {}}
      onSelectEdge={select}
    />,
  );
  expect(expense).toHaveClass("graph-edge-active");
  expect(purchase).toHaveClass("graph-edge-muted");
  expect(post).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Graph zoom").textContent).toBe(zoom);
  rerender(
    <DependencyGraphCanvas
      dot="example"
      edges={[...edges]}
      hierarchyEdges={[]}
      selectedEdgeId="missing"
      onSelectNode={() => {}}
      onSelectEdge={select}
    />,
  );
  expect(expense).not.toHaveClass("graph-edge-active");
  expect(expense).not.toHaveClass("graph-edge-muted");
  expect(purchase).not.toHaveClass("graph-edge-muted");
  expect(vendor).not.toHaveClass("graph-edge-muted");
  expect(post).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Graph zoom").textContent).toBe(zoom);
  fireEvent.keyDown(expense, { key: "Escape" });
  expect(select).toHaveBeenLastCalledWith(undefined);
  expect(expense).not.toHaveClass("graph-edge-active");
  post.mockRestore();
});
