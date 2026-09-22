import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { NativeSelect } from "~/components/ui/native-select";

import { appendGraphImages, type GraphImage } from "./dependency-graph-images";
import { bindGraphInteractions } from "./dependency-graph-interactions";
import type { GraphEdge } from "./dependency-graph-model";
import { graphScrollTarget, overviewScale } from "./dependency-graph-viewport";

const NO_IMAGES: readonly GraphImage[] = [];
const NO_EDGES: readonly GraphEdge[] = [];

const gestureSchema = z.object({ scale: z.number().positive() });

function appendHierarchyLinks(
  svg: SVGSVGElement,
  edges: readonly { source: string; target: string }[],
) {
  if (edges.length === 0) return;
  for (const graph of svg.querySelectorAll<SVGGElement>(".graph")) {
    const bounds = new Map(
      [...graph.querySelectorAll<SVGGElement>(".node")].map((node) => [
        node.querySelector("title")?.textContent,
        node.getBBox(),
      ]),
    );
    const layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    layer.setAttribute("class", "dependency-graph-hierarchy-overlays");
    layer.setAttribute("aria-hidden", "true");
    for (const edge of edges) {
      const source = bounds.get(edge.source);
      const target = bounds.get(edge.target);
      if (!source || !target) continue;
      const x1 = source.x + source.width;
      const y1 = source.y + source.height / 2;
      const x2 = target.x;
      const y2 = target.y + target.height / 2;
      const middle = (x1 + x2) / 2;
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute(
        "d",
        `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`,
      );
      path.setAttribute("fill", "none");
      path.setAttribute("class", "dependency-graph-hierarchy-link");
      const title = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "title",
      );
      title.textContent = `${edge.source} contains ${edge.target}`;
      path.append(title);
      layer.append(path);
    }
    // Group backgrounds stay behind links; records and labels stay above them.
    const firstRecord = graph.querySelector(":scope > .node, :scope > .edge");
    graph.insertBefore(layer, firstRecord);
  }
}

function reveal(container: HTMLElement, element: Element) {
  const bounds = element.getBoundingClientRect();
  const viewport = container.getBoundingClientRect();
  container.scrollTo(
    graphScrollTarget(
      {
        x: bounds.left - viewport.left + container.scrollLeft,
        y: bounds.top - viewport.top + container.scrollTop,
        width: bounds.width,
        height: bounds.height,
      },
      {
        x: 0,
        y: 0,
        width: container.clientWidth,
        height: container.clientHeight,
      },
    ),
  );
}

function resize(container: HTMLElement, scale: number) {
  const svg = container.querySelector("svg");
  if (!svg) return;
  const { width, height } = svg.viewBox.baseVal;
  svg.setAttribute("width", String(width * scale));
  svg.setAttribute("height", String(height * scale));
}

function startPosition(container: HTMLElement, focus?: string) {
  const nodes = [...container.querySelectorAll(".node")];
  const focused = nodes.find(
    (node) => node.querySelector("title")?.textContent === focus,
  );
  const first = nodes
    .map((element) => ({ element, bounds: element.getBoundingClientRect() }))
    .sort(
      (a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left,
    )[0]?.element;
  const target = focused ?? first;
  if (target) reveal(container, target);
}

export function DependencyGraphCanvas({
  dot,
  componentDots,
  images = NO_IMAGES,
  focus,
  hierarchyEdges,
  onSelectNode,
  edges = NO_EDGES,
  onSelectEdge,
  selectedEdgeId,
}: {
  dot: string;
  componentDots?: string[];
  images?: readonly GraphImage[];
  focus?: string;
  hierarchyEdges: readonly { source: string; target: string }[];
  onSelectNode?: (id: string) => void;
  edges?: readonly GraphEdge[];
  onSelectEdge?: (id: string | undefined) => void;
  selectedEdgeId?: string;
}) {
  const host = useRef<HTMLElement>(null);
  const selectNode = useRef(onSelectNode);
  selectNode.current = onSelectNode;
  const selectEdge = useRef(onSelectEdge);
  selectEdge.current = onSelectEdge;
  const selection = useRef(selectedEdgeId);
  selection.current = selectedEdgeId;
  const interactions = useRef<ReturnType<typeof bindGraphInteractions> | null>(
    null,
  );
  const renderInput = useRef({
    dot,
    componentDots,
    images,
    hierarchyEdges,
    edges,
  });
  renderInput.current = { dot, componentDots, images, hierarchyEdges, edges };
  const renderKey = JSON.stringify(renderInput.current);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
  } | null>(null);
  const [state, setState] = useState("Loading graph layout…");
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [group, setGroup] = useState("");
  useEffect(() => {
    const { dot, componentDots, images, hierarchyEdges, edges } =
      renderInput.current;
    let disposed = false;
    const container = host.current;
    setState("Loading graph layout…");
    setError(null);
    setGroups([]);
    setGroup("");
    const worker = new Worker(
      new URL("./dependency-graph-layout.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.addEventListener(
      "message",
      (event: MessageEvent<{ svg?: string; error?: string }>) => {
        try {
          if (disposed || !container) return;
          if (!event.data.svg) throw new Error(event.data.error);
          const document = new DOMParser().parseFromString(
            event.data.svg,
            "image/svg+xml",
          );
          const svg = document.querySelector("svg");
          if (!svg) throw new Error("Missing graph SVG");
          svg.setAttribute("aria-label", "Entity dependency graph");
          for (const link of svg.querySelectorAll("a")) {
            link.setAttribute("tabindex", "0");
            link.setAttribute("aria-label", link.textContent ?? "Open record");
            link.addEventListener("focus", () => reveal(container, link));
          }
          if (selectNode.current) {
            for (const node of svg.querySelectorAll<SVGGElement>(".node")) {
              const id = node.querySelector("title")?.textContent;
              if (!id) continue;
              for (const link of node.querySelectorAll("a")) {
                link.setAttribute("tabindex", "-1");
                link.setAttribute("aria-hidden", "true");
              }
              node.setAttribute("role", "button");
              node.setAttribute("tabindex", "0");
              node.setAttribute(
                "aria-label",
                `Inspect ${node.textContent ?? id}`,
              );
              const select = (event: Event) => {
                event.preventDefault();
                selectNode.current?.(id);
              };
              node.addEventListener("click", select);
              node.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") select(event);
              });
              node.addEventListener("focus", () => reveal(container, node));
            }
          }
          const headings = [...svg.querySelectorAll(".cluster")].map(
            (cluster, index) => {
              const id = `graph-group-${index}`;
              cluster.id = id;
              return {
                id,
                name: cluster.querySelector("text")?.textContent ?? "Group",
              };
            },
          );
          container.replaceChildren(svg);
          appendGraphImages(svg, images);
          appendHierarchyLinks(svg, hierarchyEdges);
          interactions.current = bindGraphInteractions(svg, edges, (id) =>
            selectEdge.current?.(id),
          );
          interactions.current.selectEdge(selection.current);
          resize(container, 1);
          startPosition(container, focus);
          scaleRef.current = 1;
          setScale(1);
          setGroups(headings);
          setState("");
        } catch (err) {
          if (!disposed) {
            setState("");
            setError(err);
          }
        }
      },
    );
    worker.addEventListener("error", (event) => {
      if (!disposed) {
        setState("");
        setError(
          event.error ??
            new Error(event.message || "Graph layout worker failed"),
        );
      }
    });
    worker.postMessage({ dot, componentDots }, []);
    return () => {
      disposed = true;
      worker.terminate();
      interactions.current = null;
      container?.replaceChildren();
    };
  }, [renderKey, focus, attempt]);
  useEffect(() => {
    interactions.current?.selectEdge(selectedEdgeId);
  }, [selectedEdgeId]);

  const changeScale = useCallback(
    (next: number, point?: { x: number; y: number }) => {
      const container = host.current;
      if (!container) return;
      const anchor = point ?? {
        x: container.clientWidth / 2,
        y: container.clientHeight / 2,
      };
      const x = (container.scrollLeft + anchor.x) / scaleRef.current;
      const y = (container.scrollTop + anchor.y) / scaleRef.current;
      resize(container, next);
      container.scrollTo({
        left: x * next - anchor.x,
        top: y * next - anchor.y,
      });
      scaleRef.current = next;
      setScale(next);
    },
    [],
  );

  useEffect(() => {
    const container = host.current;
    if (!container || state || error) return;
    let gestureScale: number | null = null;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      // Trackpad pinches arrive as Ctrl-wheel. A native non-passive listener
      // cancels page zoom without intercepting ordinary two-finger scrolling.
      event.preventDefault();
      if (gestureScale !== null) return;
      const bounds = container.getBoundingClientRect();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? container.clientHeight
            : 1;
      const next = Math.min(
        2,
        Math.max(
          0.05,
          scaleRef.current * Math.exp(-event.deltaY * unit * 0.01),
        ),
      );
      changeScale(next, {
        x: event.clientX - bounds.left - container.clientLeft,
        y: event.clientY - bounds.top - container.clientTop,
      });
    };
    // WebKit exposes native pinch gestures separately from Ctrl-wheel.
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureScale = scaleRef.current;
    };
    const onGestureChange = (event: Event) => {
      const gesture = gestureSchema.safeParse(event);
      if (gestureScale === null || !gesture.success) return;
      event.preventDefault();
      changeScale(
        Math.min(2, Math.max(0.05, gestureScale * gesture.data.scale)),
      );
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      gestureScale = null;
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("gesturestart", onGestureStart, {
      passive: false,
    });
    container.addEventListener("gesturechange", onGestureChange, {
      passive: false,
    });
    container.addEventListener("gestureend", onGestureEnd, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("gesturestart", onGestureStart);
      container.removeEventListener("gesturechange", onGestureChange);
      container.removeEventListener("gestureend", onGestureEnd);
    };
  }, [changeScale, state, error]);
  const ready = !state && !error;
  return (
    <Stack gap="sm">
      <Row wrap gap="sm">
        <Button
          variant="outline"
          disabled={!ready || scale >= 2}
          onClick={() => changeScale(Math.min(2, scale * 1.25))}
        >
          Zoom in
        </Button>
        <Button
          variant="outline"
          disabled={!ready || scale <= 0.05}
          onClick={() => changeScale(Math.max(0.05, scale / 1.25))}
        >
          Zoom out
        </Button>
        <Button
          variant="outline"
          disabled={!ready}
          onClick={() => {
            const container = host.current;
            const svg = container?.querySelector("svg");
            if (container && svg) {
              changeScale(
                overviewScale(svg.viewBox.baseVal, {
                  x: 0,
                  y: 0,
                  width: container.clientWidth,
                  height: container.clientHeight,
                }),
              );
              container.scrollTo({ left: 0, top: 0 });
            }
          }}
        >
          Fit graph
        </Button>
        <Button
          variant="outline"
          disabled={!ready}
          onClick={() => {
            changeScale(1);
            if (host.current) startPosition(host.current, focus);
            setGroup("");
          }}
        >
          Readable view
        </Button>
        <span className="text-xs text-muted-foreground" aria-label="Graph zoom">
          {Math.round(scale * 100)}%
        </span>
        {groups.length > 0 && (
          <Row as="label" align="center" gap="sm">
            <span className="text-sm">Jump to group</span>
            <NativeSelect
              className="max-w-full"
              value={group}
              onChange={(event) => {
                const id = event.target.value;
                setGroup(id);
                const container = host.current;
                const target = container?.querySelector(`#${id}`);
                if (container && target) {
                  changeScale(1);
                  reveal(container, target);
                }
              }}
            >
              <option value="" disabled>
                Choose a group…
              </option>
              {groups.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </NativeSelect>
          </Row>
        )}
      </Row>
      <p className="text-xs text-muted-foreground">
        Pinch to zoom; scroll or drag to explore. Tab to records; arrow keys
        scroll the canvas. Fit graph shows the overview.
      </p>
      {state && !error && <output>{state}</output>}
      {error !== null && (
        <ErrorDisplay
          error={error}
          title="the dependency graph layout"
          onRetry={() => setAttempt((value) => value + 1)}
        />
      )}
      <section
        ref={host}
        aria-label="Scrollable dependency graph"
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to focus and scroll this two-dimensional canvas.
        tabIndex={0}
        className="dependency-graph rounded-panel h-[65dvh] min-h-80 min-w-0 overflow-auto border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onPointerDown={(event) => {
          if (event.button !== 0 || event.pointerType === "touch") return;
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: event.currentTarget.scrollLeft,
            top: event.currentTarget.scrollTop,
            moved: false,
          };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          const x = event.clientX - start.x;
          const y = event.clientY - start.y;
          if (!start.moved && Math.hypot(x, y) < 5) return;
          start.moved = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.scrollTo({
            left: start.left - x,
            top: start.top - y,
          });
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          if (!drag.current?.moved) drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onClickCapture={(event) => {
          if (drag.current?.moved) {
            event.preventDefault();
            event.stopPropagation();
          }
          drag.current = null;
        }}
      />
    </Stack>
  );
}
