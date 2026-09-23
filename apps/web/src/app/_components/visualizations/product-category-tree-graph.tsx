import { Link } from "@tanstack/react-router";
import * as d3Hierarchy from "d3-hierarchy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CATEGORY_HIERARCHY_ROOT_ID,
  type CategoryHierarchyNode,
} from "~/app/product-categories/category-tree";
import {
  categoryNodeColor,
  useCategoryHierarchy,
} from "~/app/product-categories/use-category-hierarchy";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import { getAppErrorDetails } from "~/lib/error-utils";

import { VisualizationPlaceholder } from "./visualization-placeholder";

const NODE_SPACING = 28;
const LEVEL_SPACING = 200;
const LABEL_WIDTH = 180;
const MARGIN = 24;

export default function ProductCategoryTreeGraph() {
  const { data, isLoading, isError, error, refetch } = useCategoryHierarchy();

  if (isLoading) {
    return (
      <VisualizationPlaceholder message="Loading categories..." height={600} />
    );
  }
  if (isError) {
    return (
      <VisualizationPlaceholder
        message="Product categories are unavailable"
        subMessage={getAppErrorDetails(error).message}
        height={600}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!data?.children?.length) {
    return (
      <VisualizationPlaceholder
        message="No product categories to display"
        height={600}
      />
    );
  }
  return <TidyTree data={data} />;
}

function TidyTree({ data }: { data: CategoryHierarchyNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dimensions = useContainerDimensions(containerRef, {
    minHeight: 600,
    initialWidth: 800,
    initialHeight: 600,
  });

  const root = useMemo(
    () =>
      d3Hierarchy
        .tree<CategoryHierarchyNode>()
        .nodeSize([NODE_SPACING, LEVEL_SPACING])(d3Hierarchy.hierarchy(data)),
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
    // Let clicks on category links through.
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
        aria-label={`Product category tree: ${data.children?.length ?? 0} root categories, ${data.totalCount} categorized products`}
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
            const isRoot = node.data.id === CATEGORY_HIERARCHY_ROOT_ID;
            const empty = node.data.totalCount === 0;
            return (
              <g
                key={node.data.id}
                transform={`translate(${node.y}, ${node.x})`}
              >
                <circle
                  r={isRoot ? 6 : 4.5}
                  fill={
                    isRoot
                      ? "var(--foreground)"
                      : empty
                        ? "var(--background)"
                        : categoryNodeColor(node.data)
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
                    {isRoot ? (
                      <span className="font-medium">{node.data.name}</span>
                    ) : (
                      <Link
                        to="/product-categories/$shortcode"
                        params={{ shortcode: node.data.id }}
                        className="truncate font-medium hover:underline"
                      >
                        {node.data.name}
                      </Link>
                    )}
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {node.data.totalCount}
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
