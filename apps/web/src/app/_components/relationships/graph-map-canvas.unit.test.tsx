import type { EntityGraphNode } from "@cubby/schemas/entity-graph";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { graphRefKey } from "./entity-graph-state";
import { GraphMapCanvas, type GraphMapCamera } from "./graph-map-canvas";
import { graphMapLayoutInputSchema, placeGraphMap } from "./graph-map-layout";

// jsdom has no Worker runtime; exercise the real layout through its message boundary.
class LayoutWorker extends EventTarget {
  private terminated = false;

  postMessage(input: unknown) {
    const result = placeGraphMap(graphMapLayoutInputSchema.parse(input));
    queueMicrotask(() => {
      if (!this.terminated)
        this.dispatchEvent(new MessageEvent("message", { data: result }));
    });
  }

  terminate() {
    this.terminated = true;
  }
}

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
  vi.stubGlobal("Worker", LayoutWorker);
});
afterEach(() => {
  cleanup();
  harness.dispose();
  vi.unstubAllGlobals();
});

it("reorganizes retained positions only when clicked and anchors later expansion to the new layout", async () => {
  const nodes: EntityGraphNode[] = [
    {
      entityType: "vendor",
      entityId: "VEN-2345",
      label: "Example Hardware",
      metadata: {},
    },
    {
      entityType: "purchase",
      entityId: "PUR-2345",
      label: "Timber order",
      metadata: {},
    },
  ];
  const root = graphRefKey(nodes[0]!);
  const member = graphRefKey(nodes[1]!);
  const initialPositions = {
    [root]: { x: 228, y: 136, width: 196, height: 104 },
    [member]: { x: 456, y: 136, width: 196, height: 104 },
    "purchase:PUR-3456": { x: -228, y: 136, width: 196, height: 104 },
  };
  const camera: GraphMapCamera = {
    positions: initialPositions,
    viewport: { x: 32, y: 32, zoom: 1 },
  };
  const props = {
    nodes,
    edges: [],
    anchors: new Map([[member, root]]),
    selected: root,
    onSelect: vi.fn(),
    onSelectEdge: vi.fn(),
    reveal: 0,
    highlightedEdges: new Set<string>(),
    camera,
  };
  const { rerender } = render(<GraphMapCanvas {...props} />, {
    wrapper: harness.wrapper,
  });
  await waitFor(() => expect(camera.positions).not.toBe(initialPositions));
  expect(camera.positions).toEqual(initialPositions);

  rerender(<GraphMapCanvas {...props} selected={member} />);
  expect(camera.positions).toEqual(initialPositions);
  fireEvent.click(screen.getByRole("button", { name: "Reorganize" }));
  await waitFor(() =>
    expect(camera.positions[root]).toMatchObject({ x: 0, y: 0 }),
  );
  expect(camera.positions).not.toHaveProperty("purchase:PUR-3456");
  expect(camera.viewport).toEqual({ x: 32, y: 32, zoom: 1 });

  const reorganized = camera.positions;
  const added: EntityGraphNode = {
    entityType: "purchase",
    entityId: "PUR-4567",
    label: "Paint order",
    metadata: {},
  };
  rerender(<GraphMapCanvas {...props} nodes={[...nodes, added]} />);
  await waitFor(() =>
    expect(camera.positions[graphRefKey(added)]).toBeDefined(),
  );
  expect(camera.positions[root]).toEqual(reorganized[root]);
  expect(camera.positions[member]).toEqual(reorganized[member]);
});
