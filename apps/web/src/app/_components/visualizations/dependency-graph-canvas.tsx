import { useEffect, useRef, useState } from "react";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { NativeSelect } from "~/components/ui/native-select";

import { graphScrollTarget, overviewScale } from "./dependency-graph-viewport";

function appendHierarchyLinks(
  svg: SVGSVGElement,
  edges: readonly { source: string; target: string }[],
) {
  const graph = svg.querySelector<SVGGElement>(".graph");
  if (!graph || edges.length === 0) return;
  const bounds = new Map(
    [...svg.querySelectorAll<SVGGElement>(".node")].map((node) => [
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
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
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
  focus,
  hierarchyEdges,
}: {
  dot: string;
  focus?: string;
  hierarchyEdges: readonly { source: string; target: string }[];
}) {
  const host = useRef<HTMLElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
  } | null>(null);
  const [state, setState] = useState("Loading graph layout…");
  const [attempt, setAttempt] = useState(0);
  const [scale, setScale] = useState(1);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [group, setGroup] = useState("");
  useEffect(() => {
    let disposed = false;
    const container = host.current;
    setState("Loading graph layout…");
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
          appendHierarchyLinks(svg, hierarchyEdges);
          resize(container, 1);
          startPosition(container, focus);
          setScale(1);
          setGroups(headings);
          setState("");
        } catch {
          if (!disposed)
            setState(
              "Graph layout could not load. Use the record and relationship list below or retry.",
            );
        }
      },
    );
    worker.addEventListener("error", () => {
      if (!disposed)
        setState(
          "Graph layout could not load. Use the record and relationship list below or retry.",
        );
    });
    worker.postMessage(dot, []);
    return () => {
      disposed = true;
      worker.terminate();
      container?.replaceChildren();
    };
  }, [dot, focus, attempt, hierarchyEdges]);

  const changeScale = (next: number) => {
    const container = host.current;
    if (!container) return;
    const x = (container.scrollLeft + container.clientWidth / 2) / scale;
    const y = (container.scrollTop + container.clientHeight / 2) / scale;
    resize(container, next);
    container.scrollTo({
      left: x * next - container.clientWidth / 2,
      top: y * next - container.clientHeight / 2,
    });
    setScale(next);
  };
  const ready = !state;
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
        Scroll or drag to explore. Tab to records; arrow keys scroll the canvas.
        Fit graph shows the overview.
      </p>
      {state && (
        <output>
          {state}
          {state.includes("could not") && (
            <Button
              variant="outline"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry layout
            </Button>
          )}
        </output>
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
