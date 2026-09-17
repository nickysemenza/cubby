import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation, LocationType } from "@cubby/schemas/location";
import * as d3Hierarchy from "d3-hierarchy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/app/_components/entity-media/entity-display-images";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useLocationTree } from "~/hooks/useLocationTree";

interface TreeNode {
  name: string;
  id: LocationShortcode;
  type: LocationType | null;
  children?: TreeNode[];
}

function transformToTreeNode(location: InfLocation): TreeNode {
  return {
    name: location.name,
    id: location.id,
    type: location.type,
    children: location.children?.map(transformToTreeNode),
  };
}

export default function LocationTreeGraph() {
  const locations = useLocationTree();
  const data = locations.data;

  const treeData = useMemo(() => {
    const home = data?.[0];
    return home ? transformToTreeNode(home) : null;
  }, [data]);

  if (!treeData) return null;

  return <TidyTree data={treeData} />;
}

interface TidyTreeProps {
  data: TreeNode;
}

function TidyTree({ data }: TidyTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const isDragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (containerRef.current) {
      const { width, height } = containerRef.current.getBoundingClientRect();
      setDimensions({ width, height });
    }
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const scaleFactor = e.deltaY > 0 ? 0.9 : 1.1;
    setTransform((t) => ({
      ...t,
      scale: Math.max(0.2, Math.min(3, t.scale * scaleFactor)),
    }));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) {
      isDragging.current = true;
      lastPos.current = { x: e.clientX, y: e.clientY };
    }
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging.current) {
      const dx = e.clientX - lastPos.current.x;
      const dy = e.clientY - lastPos.current.y;
      lastPos.current = { x: e.clientX, y: e.clientY };
      setTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const hierarchy = useMemo(() => d3Hierarchy.hierarchy(data), [data]);

  // Calculate layout with nodeSize for consistent spacing
  const root = useMemo(() => {
    const dx = 28; // vertical spacing between nodes
    const dy = 220; // horizontal spacing between levels
    const layout = d3Hierarchy.tree<TreeNode>().nodeSize([dx, dy]);
    return layout(hierarchy);
  }, [hierarchy]);

  // Center the tree vertically
  const offsetY = dimensions.height / 2;
  const offsetX = 100; // Left margin for the root

  const nodes = useMemo(() => root.descendants(), [root]);
  const links = useMemo(() => root.links(), [root]);
  const imageRefs = useMemo(
    () =>
      nodes.map(({ data: node }) => ({
        entityType: "location" as const,
        entityId: node.id,
      })),
    [nodes],
  );
  const displayImages = useEntityDisplayImages(imageRefs);

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- The D3 viewport supports pointer pan and wheel zoom while its textual tree remains available elsewhere.
    <div
      ref={containerRef}
      className="h-[600px] w-full cursor-grab overflow-hidden border border-[var(--border)] active:cursor-grabbing"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <svg
        aria-hidden="true"
        width={dimensions.width}
        height={dimensions.height}
        style={{ overflow: "visible" }}
      >
        <g
          transform={`translate(${offsetX + transform.x}, ${offsetY + transform.y}) scale(${transform.scale})`}
        >
          {/* Links - curved bezier paths */}
          {links.map((link) => {
            // In d3 tree: x = vertical position, y = horizontal position
            // We swap them for horizontal layout
            const x1 = link.source.y; // horizontal start
            const y1 = link.source.x; // vertical start
            const x2 = link.target.y; // horizontal end
            const y2 = link.target.x; // vertical end
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

          {/* Nodes positioned using swapped x/y coordinates */}
          {nodes.map((node) => {
            const isRoot = node.depth === 0;
            const hasChildren = !!node.children?.length;

            return (
              <g
                key={node.data.id}
                transform={`translate(${node.y}, ${node.x})`}
              >
                <circle r={isRoot ? 6 : 4} className="fill-primary" />
                <foreignObject
                  x={isRoot ? 8 : hasChildren ? -200 : 8}
                  y={-12}
                  width={190}
                  height={24}
                  style={{ overflow: "visible" }}
                >
                  <div
                    className={`flex ${!isRoot && hasChildren ? "justify-end" : "justify-start"}`}
                  >
                    <EntityInlineLink
                      displayImage={
                        displayImages[
                          entityDisplayImageKey({
                            entityType: "location",
                            entityId: node.data.id,
                          })
                        ] ?? null
                      }
                      entity="location"
                      data={{
                        name: node.data.name,
                        id: node.data.id,
                        type: node.data.type,
                      }}
                    />
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
