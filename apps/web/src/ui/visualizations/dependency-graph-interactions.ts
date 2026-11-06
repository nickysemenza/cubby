import {
  graphEdgeClass,
  graphEdgeIdentity,
  type GraphEdge,
} from "./dependency-graph-model";

function appendConnectionLabel(element: SVGGElement, edge: GraphEdge) {
  if (!edge.label || element.querySelector("text")) return;
  const path = element.querySelector("path");
  if (!path) return;
  const midpoint = path.getPointAtLength(path.getTotalLength() / 2);
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.textContent = edge.label;
  label.setAttribute("x", String(midpoint.x));
  label.setAttribute("y", String(midpoint.y - 5));
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("font-size", "12");
  element.append(label);
}

function appendEdgeTarget(element: SVGGElement) {
  const curve = element.querySelector("path");
  if (!curve) return;
  const target = document.createElementNS("http://www.w3.org/2000/svg", "path");
  target.setAttribute("d", curve.getAttribute("d") ?? "");
  target.setAttribute("class", "graph-edge-hit");
  target.setAttribute("aria-hidden", "true");
  element.append(target);
}

/** Ephemeral SVG state is independent of worker layout and React selection renders. */
export function bindGraphInteractions(
  svg: SVGSVGElement,
  edges: readonly GraphEdge[],
  onSelect: (id: string | undefined) => void,
) {
  let selected: string | undefined;
  const byClass = new Map(edges.map((edge) => [graphEdgeClass(edge), edge]));
  const records = [...svg.querySelectorAll<SVGGElement>(".edge")].flatMap(
    (element) => {
      const edge = [...element.classList]
        .map((name) => byClass.get(name))
        .find(Boolean);
      return edge ? [{ element, edge }] : [];
    },
  );
  const paint = (nodeId?: string, edgeId = selected) => {
    const active = nodeId != null || edgeId != null;
    for (const { element, edge } of records) {
      const match =
        nodeId != null
          ? edge.source === nodeId || edge.target === nodeId
          : graphEdgeIdentity(edge) === edgeId;
      element.classList.toggle("graph-edge-active", active && match);
      element.classList.toggle("graph-edge-muted", active && !match);
      element.setAttribute(
        "aria-pressed",
        String(graphEdgeIdentity(edge) === selected),
      );
    }
  };
  for (const node of svg.querySelectorAll<SVGGElement>(".node")) {
    const activate = () =>
      paint(node.querySelector("title")?.textContent ?? undefined);
    node.addEventListener("mouseenter", activate);
    node.addEventListener("focusin", activate);
    node.addEventListener("mouseleave", () => paint());
    node.addEventListener("focusout", () => paint());
  }
  for (const { element, edge } of records) {
    appendConnectionLabel(element, edge);
    appendEdgeTarget(element);
    element.setAttribute("tabindex", "0");
    element.setAttribute("role", "button");
    element.setAttribute(
      "aria-label",
      `${edge.label ?? "Connection"}: ${edge.source} to ${edge.target}`,
    );
    const select = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      selected = graphEdgeIdentity(edge);
      paint();
      onSelect(selected);
    };
    element.addEventListener("click", select);
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") select(event);
    });
    element.addEventListener("mouseenter", () =>
      paint(undefined, graphEdgeIdentity(edge)),
    );
    element.addEventListener("focusin", () =>
      paint(undefined, graphEdgeIdentity(edge)),
    );
    element.addEventListener("mouseleave", () => paint());
    element.addEventListener("focusout", () => paint());
  }
  svg.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    selected = undefined;
    paint();
    onSelect(undefined);
  });
  return {
    selectEdge(id?: string) {
      selected = records.some(({ edge }) => graphEdgeIdentity(edge) === id)
        ? id
        : undefined;
      paint();
    },
  };
}
