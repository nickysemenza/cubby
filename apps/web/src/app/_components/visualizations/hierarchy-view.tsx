import { Link, useNavigate } from "@tanstack/react-router";
import * as d3Hierarchy from "d3-hierarchy";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  CATEGORY_HIERARCHY_ROOT_ID,
  type CategoryHierarchyNode,
} from "~/app/product-categories/category-tree";
import {
  categoryNodeColor,
  useCategoryHierarchy,
} from "~/app/product-categories/use-category-hierarchy";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Grid } from "~/components/layout";
import { entityDetailLink } from "~/entities/entities";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import {
  type LocationHierarchyNode,
  useLocationHierarchy,
} from "~/hooks/useLocationHierarchy";
import { getAppErrorDetails } from "~/lib/error-utils";

import { VisualizationPanel } from "./visualization-panel";
import { VisualizationPlaceholder } from "./visualization-placeholder";
import { VizTooltip } from "./viz-overlay";

export type HierarchyEntity = "location" | "productCategory";

/** One node of any parent-linked entity's rolled-up count tree. */
interface HierarchyNode {
  id: string;
  name: string;
  /** False for a synthetic root that names no real record. */
  linked: boolean;
  /** Items held directly by this node. */
  own: number;
  /** Items held by this node and every descendant. */
  total: number;
  /** Declared ink (a category's feature); depth-ramped when absent. */
  color: string | null;
  children?: HierarchyNode[];
}

const fromCategory = (node: CategoryHierarchyNode): HierarchyNode => ({
  id: node.id,
  name: node.name,
  linked: node.id !== CATEGORY_HIERARCHY_ROOT_ID,
  own: node.directCount,
  total: node.totalCount,
  color:
    node.id === CATEGORY_HIERARCHY_ROOT_ID ? null : categoryNodeColor(node),
  children: node.children?.map(fromCategory),
});

const fromLocation = (node: LocationHierarchyNode): HierarchyNode => ({
  id: node.id,
  name: node.name,
  linked: true,
  own: node.directCount,
  total: node.totalCount,
  color: null,
  children: node.children?.map(fromLocation),
});

const UNIT = { location: "items", productCategory: "products" } as const;

type HierarchyStateProps = {
  entity: HierarchyEntity;
  height: number;
  children: (data: HierarchyNode) => React.ReactNode;
};

/** Each entity's own query, so a page only fetches the tree it shows. */
function HierarchyState(props: HierarchyStateProps) {
  return props.entity === "location" ? (
    <LocationHierarchyState {...props} />
  ) : (
    <CategoryHierarchyState {...props} />
  );
}

function LocationHierarchyState(props: HierarchyStateProps) {
  const query = useLocationHierarchy({ valuationMode: "itemCount" });
  const data = useMemo(
    () => (query.data ? fromLocation(query.data) : null),
    [query.data],
  );
  return <HierarchyResult {...props} {...query} data={data} />;
}

function CategoryHierarchyState(props: HierarchyStateProps) {
  const query = useCategoryHierarchy();
  const data = useMemo(
    () => (query.data ? fromCategory(query.data) : null),
    [query.data],
  );
  return <HierarchyResult {...props} {...query} data={data} />;
}

function HierarchyResult({
  entity,
  height,
  children,
  data,
  isLoading,
  isError,
  error,
  refetch,
}: HierarchyStateProps & {
  data: HierarchyNode | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}) {
  if (isLoading)
    return <VisualizationPlaceholder message="Loading…" height={height} />;
  if (isError)
    return (
      <VisualizationPlaceholder
        message="This hierarchy is unavailable"
        subMessage={getAppErrorDetails(error).message}
        height={height}
        onRetry={() => void refetch()}
      />
    );
  if (!data || data.total === 0)
    return (
      <VisualizationPlaceholder
        message={`No ${UNIT[entity]} to display`}
        height={height}
      />
    );
  return children(data);
}

type ArcNode = d3Hierarchy.HierarchyRectangularNode<HierarchyNode>;

// Sequential ink ramp by depth for nodes without a declared color: the root
// ring reads heaviest and each nested ring lightens, keeping the interaction
// accent free (DESIGN.md's One Loud Thing).
const DEPTH_RAMP = [
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];
/** Deeper rings of a declared color fade so one color reads as one family. */
const RING_OPACITY = [1, 1, 0.75, 0.55];

const arcFill = (node: ArcNode) =>
  node.data.total === 0
    ? "var(--muted)"
    : (node.data.color ??
      DEPTH_RAMP[Math.min(node.depth - 1, DEPTH_RAMP.length - 1)] ??
      "var(--chart-6)");

function arcPath(node: ArcNode) {
  const { x0: start, x1: end, y0: inner, y1: outer } = node;
  const sx = Math.cos(start - Math.PI / 2);
  const sy = Math.sin(start - Math.PI / 2);
  const ex = Math.cos(end - Math.PI / 2);
  const ey = Math.sin(end - Math.PI / 2);
  const largeArc = end - start > Math.PI ? 1 : 0;
  return `M ${inner * sx} ${inner * sy}
    A ${inner} ${inner} 0 ${largeArc} 1 ${inner * ex} ${inner * ey}
    L ${outer * ex} ${outer * ey}
    A ${outer} ${outer} 0 ${largeArc} 0 ${outer * sx} ${outer * sy} Z`;
}

function labelPlacement(node: ArcNode) {
  const angle = (node.x0 + node.x1) / 2;
  const r = (node.y0 + node.y1) / 2;
  const x = Math.cos(angle - Math.PI / 2) * r;
  const y = Math.sin(angle - Math.PI / 2) * r;
  const rotation = ((angle * 180) / Math.PI - 90) % 360;
  const flip = rotation > 90 && rotation < 270;
  const fits = (node.x1 - node.x0) * r > 40 && node.y1 - node.y0 > 20;
  return { x, y, rotation: flip ? rotation + 180 : rotation, fits };
}

/** Rings one level deeper each, sized by rolled-up count. */
export function HierarchySunburst({ entity }: { entity: HierarchyEntity }) {
  return (
    <HierarchyState entity={entity} height={500}>
      {(data) => <Sunburst entity={entity} data={data} />}
    </HierarchyState>
  );
}

function Sunburst({
  entity,
  data,
}: {
  entity: HierarchyEntity;
  data: HierarchyNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const summaryId = useId();
  const navigate = useNavigate();
  const dimensions = useContainerDimensions(containerRef, {
    minHeight: 400,
    initialWidth: 500,
    initialHeight: 500,
  });
  const [hovered, setHovered] = useState<ArcNode | null>(null);
  const radius = Math.min(dimensions.width, dimensions.height) / 2;
  const unit = UNIT[entity];

  const nodes = useMemo(() => {
    // `sum` adds each node's own count to its descendants', so items held
    // directly by a branch still count toward that branch's arc.
    const hierarchy = d3Hierarchy
      .hierarchy(data)
      .sum((node) => node.own)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return d3Hierarchy
      .partition<HierarchyNode>()
      .size([2 * Math.PI, radius])(hierarchy)
      .descendants()
      .filter(
        (node) => node.depth > 0 && node.x1 - node.x0 > 0.002 && node.value,
      );
  }, [data, radius]);

  const topRoots = useMemo(
    () => nodes.filter((node) => node.depth === 1).slice(0, 4),
    [nodes],
  );
  const summary = `${data.name}: ${topRoots
    .map((node) => `${node.data.name} ${node.data.total}`)
    .join("; ")}; ${data.total} ${unit} total`;

  return (
    <div
      ref={containerRef}
      className="relative h-[500px] w-full overflow-hidden border border-[var(--border)]"
    >
      <svg
        aria-label={summary}
        aria-describedby={summaryId}
        width={dimensions.width}
        height={dimensions.height}
      >
        <title>{summary}</title>
        <g
          transform={`translate(${dimensions.width / 2}, ${dimensions.height / 2})`}
        >
          {nodes.map((node) => {
            const isHovered = hovered?.data.id === node.data.id;
            const label = labelPlacement(node);
            return (
              <g key={node.data.id}>
                <path
                  d={arcPath(node)}
                  fill={arcFill(node)}
                  fillOpacity={
                    node.data.color ? (RING_OPACITY[node.depth] ?? 0.5) : 1
                  }
                  stroke={isHovered ? "var(--primary)" : "var(--background)"}
                  strokeWidth={isHovered ? 2 : 1}
                  className="cursor-pointer"
                  onMouseEnter={() => setHovered(node)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() =>
                    void navigate(entityDetailLink(entity, node.data.id))
                  }
                />
                {label.fits && (
                  <text
                    x={label.x}
                    y={label.y}
                    transform={`rotate(${label.rotation}, ${label.x}, ${label.y})`}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="pointer-events-none text-2xs font-medium"
                    fill="var(--foreground)"
                    stroke="var(--background)"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {node.data.name.length > 12
                      ? `${node.data.name.slice(0, 10)}…`
                      : node.data.name}
                  </text>
                )}
              </g>
            );
          })}
          <text
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-foreground text-sm font-medium"
          >
            {hovered ? hovered.data.name : `${data.total} ${unit}`}
          </text>
          {hovered && (
            <text
              y={16}
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-muted-foreground text-xs"
            >
              {hovered.data.total} {unit}
            </text>
          )}
        </g>
      </svg>

      <p id={summaryId} className="sr-only">
        {summary}. Use the links below to open one.
      </p>

      {topRoots.length > 0 && (
        <nav
          aria-label={`Largest by ${unit}`}
          className="absolute inset-x-2 bottom-2 flex flex-wrap gap-1 border border-[var(--border)] bg-background/95 p-1"
        >
          {topRoots.map((node) => (
            <Link
              key={node.data.id}
              {...entityDetailLink(entity, node.data.id)}
              className="inline-flex min-h-11 items-center px-2 text-xs text-primary hover:underline sm:min-h-0"
            >
              {node.data.name} ({node.data.total})
            </Link>
          ))}
        </nav>
      )}

      {hovered && (
        <VizTooltip>
          <div className="font-medium">
            {hovered
              .ancestors()
              .reverse()
              .filter((ancestor) => ancestor.data.linked)
              .map((ancestor) => ancestor.data.name)
              .join(" / ")}
          </div>
          <div className="mt-1 text-muted-foreground">
            {unit}: {hovered.data.own} direct / {hovered.data.total} total
          </div>
        </VizTooltip>
      )}
    </div>
  );
}

const NODE_SPACING = 28;
const LEVEL_SPACING = 200;
const LABEL_WIDTH = 180;
const MARGIN = 24;

/** The whole structure as a pannable, zoomable tidy tree. */
export function HierarchyTree({ entity }: { entity: HierarchyEntity }) {
  return (
    <HierarchyState entity={entity} height={600}>
      {(data) => <TidyTree entity={entity} data={data} />}
    </HierarchyState>
  );
}

function TidyTree({
  entity,
  data,
}: {
  entity: HierarchyEntity;
  data: HierarchyNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dimensions = useContainerDimensions(containerRef, {
    minHeight: 600,
    initialWidth: 800,
    initialHeight: 600,
  });

  const root = useMemo(
    () =>
      d3Hierarchy.tree<HierarchyNode>().nodeSize([NODE_SPACING, LEVEL_SPACING])(
        d3Hierarchy.hierarchy(data),
      ),
    [data],
  );
  const nodes = useMemo(() => root.descendants(), [root]);
  const links = useMemo(() => root.links(), [root]);

  // Fit the whole tree on first paint; pan and zoom from there. In d3's tree
  // layout `x` is the vertical position and `y` the horizontal one.
  const fit = useMemo(() => {
    let minX = 0;
    let maxX = 0;
    let maxY = 0;
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    }
    const contentWidth = maxY + LABEL_WIDTH + MARGIN * 2;
    const contentHeight = maxX - minX + NODE_SPACING + MARGIN * 2;
    const scale = Math.min(
      1,
      dimensions.width / contentWidth,
      dimensions.height / contentHeight,
    );
    return {
      scale,
      x: MARGIN,
      y: (dimensions.height - (maxX + minX) * scale) / 2,
    };
  }, [nodes, dimensions]);

  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  useEffect(() => setView(fit), [fit]);

  // A native listener: React's `onWheel` is passive, so it cannot stop the
  // page from scrolling while the pointer zooms the tree.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY > 0 ? 0.9 : 1.1;
      setView((current) => ({
        ...current,
        scale: Math.max(0.2, Math.min(3, current.scale * factor)),
      }));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const drag = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = useCallback((event: React.PointerEvent) => {
    // Let clicks on node links through.
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest("a"))
    )
      return;
    drag.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);
  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const last = drag.current;
    if (!last) return;
    drag.current = { x: event.clientX, y: event.clientY };
    setView((current) => ({
      ...current,
      x: current.x + event.clientX - last.x,
      y: current.y + event.clientY - last.y,
    }));
  }, []);
  const endDrag = useCallback(() => {
    drag.current = null;
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-[600px] w-full cursor-grab touch-none overflow-hidden border border-[var(--border)] active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <svg
        width={dimensions.width}
        height={dimensions.height}
        aria-label={`${data.name}: ${data.children?.length ?? 0} top-level nodes, ${data.total} ${UNIT[entity]}`}
      >
        <g transform={`translate(${view.x}, ${view.y}) scale(${view.scale})`}>
          {links.map((link) => {
            const x1 = link.source.y;
            const y1 = link.source.x;
            const x2 = link.target.y;
            const y2 = link.target.x;
            const midX = (x1 + x2) / 2;
            return (
              <path
                key={`${link.source.data.id}-${link.target.data.id}`}
                d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                fill="none"
                className="stroke-muted-foreground/50"
                strokeWidth={1.5}
              />
            );
          })}
          {nodes.map((node) => {
            const empty = node.data.total === 0;
            return (
              <g
                key={node.data.id}
                transform={`translate(${node.y}, ${node.x})`}
              >
                <circle
                  r={node.depth === 0 ? 6 : 4.5}
                  fill={
                    node.depth === 0
                      ? "var(--foreground)"
                      : empty
                        ? "var(--background)"
                        : (node.data.color ?? "var(--chart-3)")
                  }
                  stroke={empty ? "var(--muted-foreground)" : "none"}
                  strokeWidth={1.5}
                />
                <foreignObject
                  x={8}
                  y={-12}
                  width={LABEL_WIDTH}
                  height={24}
                  style={{ overflow: "visible" }}
                >
                  <div className="flex h-6 items-center gap-1.5 truncate bg-background/80 pr-1 text-xs">
                    {node.data.linked ? (
                      <Link
                        {...entityDetailLink(entity, node.data.id)}
                        className="truncate font-medium hover:underline"
                      >
                        {node.data.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{node.data.name}</span>
                    )}
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {node.data.total}
                    </span>
                  </div>
                </foreignObject>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

/** Structure (every node) beside weight (where items concentrate). */
export function HierarchyView({ entity }: { entity: HierarchyEntity }) {
  const unit = UNIT[entity];
  return (
    <Grid cols="pair">
      <VisualizationPanel
        title="Tree"
        description={`Each count includes the ${unit} in every node below it; hollow dots have none.`}
        fallback={<SimpleLoading text="Loading tree..." />}
      >
        <HierarchyTree entity={entity} />
      </VisualizationPanel>
      <VisualizationPanel
        title="Sunburst"
        description={`Rings go one level deeper each, sized by ${unit}.`}
        fallback={<SimpleLoading text="Loading sunburst..." />}
      >
        <HierarchySunburst entity={entity} />
      </VisualizationPanel>
    </Grid>
  );
}
