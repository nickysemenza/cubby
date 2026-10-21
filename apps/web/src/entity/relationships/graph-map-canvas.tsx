import type {
  EntityGraphEdge,
  EntityGraphNode,
} from "@cubby/schemas/entity-graph";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  MarkerType,
  Position,
  ReactFlow,
  type Viewport,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { EntityIcon, entityLabel } from "~/entity/entities";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "~/ui/primitives/dropdown-menu";

import { graphRefKey } from "./entity-graph-state";
import {
  GRAPH_CARD_WIDTH,
  GRAPH_CARD_HEIGHT,
  graphMapLayoutOutputSchema,
  type GraphMapRect,
} from "./graph-map-layout";
import { GraphRecordContent, GraphRecordLink } from "./graph-record-content";

import "@xyflow/react/dist/style.css";
import "./graph-map.css";

type RecordNode = Node<{
  record: EntityGraphNode;
  related: EntityGraphNode[];
  depth: number;
}>;
const GraphRecord = memo(function GraphRecord({
  data,
  selected,
}: NodeProps<RecordNode>) {
  return (
    <div className="graph-map-record" data-selected={selected}>
      {Object.values(Position).map((position) => (
        <Handle
          key={`target-${position}`}
          id={`target-${position}`}
          type="target"
          position={position}
          isConnectable={false}
        />
      ))}
      <Row gap="sm" align="center" className="text-xs text-muted-foreground">
        <EntityIcon entity={data.record.entityKind} className="size-3.5" />
        <span>{entityLabel(data.record.entityKind)}</span>
      </Row>
      <span className="graph-record-depth">
        {data.depth === 0
          ? "Focus"
          : `${data.depth} ${data.depth === 1 ? "link" : "links"}`}
      </span>
      <GraphRecordContent node={data.record} />
      <nav
        className="graph-record-links nodrag nopan"
        aria-label="Linked records"
      >
        {data.related.slice(0, 2).map((node) => (
          <GraphRecordLink key={graphRefKey(node)} node={node} />
        ))}
        {data.related.length > 2 ? (
          <span className="text-2xs text-muted-foreground">
            +{data.related.length - 2} linked records
          </span>
        ) : null}
      </nav>
      {Object.values(Position).map((position) => (
        <Handle
          key={`source-${position}`}
          id={`source-${position}`}
          type="source"
          position={position}
          isConnectable={false}
        />
      ))}
    </div>
  );
});
const NODE_TYPES = { record: GraphRecord };
const DEFAULT_VIEWPORT = { x: 32, y: 32, zoom: 1 };
const EMPTY_POSITIONS: Record<string, GraphMapRect> = {};
export interface GraphMapCamera {
  positions: Record<string, GraphMapRect>;
  viewport: Viewport;
}

export function GraphMapCanvas({
  nodes,
  root,
  edges,
  anchors,
  selected,
  selectedEdge,
  onSelect,
  onSelectEdge,
  reveal,
  highlightedEdges,
  camera,
  toolbarTarget,
}: {
  root?: { entityKind: EntityGraphNode["entityKind"]; entityId: string };
  nodes: EntityGraphNode[];
  edges: EntityGraphEdge[];
  anchors: ReadonlyMap<string, string>;
  selected: string;
  selectedEdge?: string;
  onSelect: (key: string) => void;
  onSelectEdge: (key: string | undefined) => void;
  reveal: number;
  highlightedEdges: ReadonlySet<string>;
  camera: GraphMapCamera;
  toolbarTarget?: HTMLElement | null;
}) {
  const [positions, setPositions] = useState(
    camera.positions ?? EMPTY_POSITIONS,
  );
  const positionsRef = useRef(positions);
  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);
  const [compact, setCompact] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [layingOut, setLayingOut] = useState(false);
  const worker = useRef<Worker>(null);
  const requestID = useRef(0);
  const flow = useRef<ReactFlowInstance<RecordNode>>(null);
  const needsInitialCenter = useRef(Object.keys(camera.positions).length === 0);
  const topology = JSON.stringify(
    nodes.map((node) => ({
      id: graphRefKey(node),
      anchor: anchors.get(graphRefKey(node)),
    })),
  );
  useEffect(() => {
    let layoutWorker: Worker;
    try {
      layoutWorker = new Worker(
        new URL("./graph-map-layout.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch (err) {
      setError(err);
      setLayingOut(false);
      return;
    }
    worker.current = layoutWorker;
    layoutWorker.addEventListener("message", (event: MessageEvent<unknown>) => {
      const result = graphMapLayoutOutputSchema.safeParse(event.data);
      if (!result.success || result.data.revision !== requestID.current) return;
      setPositions(result.data.positions);
      camera.positions = result.data.positions;
      setLayingOut(false);
      setError(null);
    });
    layoutWorker.addEventListener("error", (event) => {
      setError(
        event.error ?? new Error(event.message || "Graph layout worker failed"),
      );
      setLayingOut(false);
    });
    return () => {
      layoutWorker.terminate();
      worker.current = null;
    };
  }, [revision, camera]);
  useEffect(() => {
    if (!worker.current) return;
    requestID.current++;
    setLayingOut(true);
    worker.current?.postMessage({
      revision: requestID.current,
      nodes: JSON.parse(topology),
      previous: positionsRef.current,
    });
  }, [topology, revision]);
  const relatedRecords = useMemo(() => {
    const byKey = new Map(nodes.map((node) => [graphRefKey(node), node]));
    const related = new Map<string, EntityGraphNode[]>();
    for (const edge of edges) {
      for (const [from, to] of [
        [edge.source, edge.target],
        [edge.target, edge.source],
      ]) {
        if (!from || !to) continue;
        const node = byKey.get(graphRefKey(to));
        const key = graphRefKey(from);
        if (
          node &&
          !(related.get(key) ?? []).some(
            (item) => graphRefKey(item) === graphRefKey(node),
          )
        )
          related.set(key, [...(related.get(key) ?? []), node]);
      }
    }
    return related;
  }, [nodes, edges]);
  const depths = useMemo(() => {
    const first = root ?? nodes[0];
    const result = new Map<string, number>();
    if (!first) return result;
    const queue = [graphRefKey(first)];
    result.set(queue[0] ?? "", 0);
    for (const key of queue)
      for (const next of relatedRecords.get(key) ?? []) {
        const nextKey = graphRefKey(next);
        if (!result.has(nextKey)) {
          result.set(nextKey, (result.get(key) ?? 0) + 1);
          queue.push(nextKey);
        }
      }
    return result;
  }, [root, nodes, relatedRecords]);
  const baseNodes: RecordNode[] = useMemo(
    () =>
      nodes.flatMap((record) => {
        const id = graphRefKey(record);
        const position = positions[id];
        return position
          ? [
              {
                id,
                type: "record",
                position: { x: position.x, y: position.y },
                width: position.width,
                height: position.height,
                data: {
                  record,
                  related: relatedRecords.get(id) ?? [],
                  depth: depths.get(id) ?? 0,
                },
                ariaLabel: `Inspect ${record.label}`,
                draggable: false,
              },
            ]
          : [];
      }),
    [nodes, positions, relatedRecords, depths],
  );
  const recordNodes = useMemo(
    () =>
      baseNodes.map((node) => ({ ...node, selected: node.id === selected })),
    [baseNodes, selected],
  );
  const flowEdges = useMemo(
    () =>
      edges.map((edge) => {
        const source = graphRefKey(edge.source);
        const target = graphRefKey(edge.target);
        const a = positions[source];
        const b = positions[target];
        const dx = (b?.x ?? 0) - (a?.x ?? 0);
        const dy = (b?.y ?? 0) - (a?.y ?? 0);
        const horizontal =
          Math.abs(dx) / GRAPH_CARD_WIDTH > Math.abs(dy) / GRAPH_CARD_HEIGHT;
        const sourceSide = horizontal
          ? dx >= 0
            ? Position.Right
            : Position.Left
          : dy >= 0
            ? Position.Bottom
            : Position.Top;
        const targetSide = horizontal
          ? dx >= 0
            ? Position.Left
            : Position.Right
          : dy >= 0
            ? Position.Top
            : Position.Bottom;
        const active = highlightedEdges.size
          ? highlightedEdges.has(edge.id)
          : edge.id === selectedEdge ||
            source === selected ||
            target === selected;
        return {
          id: edge.id,
          source,
          target,
          type: "smoothstep",
          sourceHandle: `source-${sourceSide}`,
          targetHandle: `target-${targetSide}`,
          selected: edge.id === selectedEdge,
          label: edge.id === selectedEdge ? edge.label : undefined,
          className: active ? "graph-map-edge-active" : "graph-map-edge",
          ariaLabel: edge.label,
          markerEnd: { type: MarkerType.ArrowClosed },
        };
      }),
    [edges, positions, selected, selectedEdge, highlightedEdges],
  );
  const center = () => {
    const rect = positionsRef.current[selected];
    if (rect)
      void flow.current?.setCenter(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        { zoom: Math.max(0.7, flow.current.getZoom()) },
      );
  };
  const centerRef = useRef(center);
  centerRef.current = center;
  useEffect(() => {
    if (reveal) centerRef.current();
  }, [reveal]);
  useEffect(() => {
    if (needsInitialCenter.current && positions[selected] && flow.current) {
      centerRef.current();
      needsInitialCenter.current = false;
    }
  }, [positions, selected]);
  return (
    <Stack gap="sm" className="h-full min-h-0">
      {toolbarTarget ? (
        createPortal(
          <Row gap="sm">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void flow.current?.fitView({ padding: 0.15, maxZoom: 1 })
              }
            >
              Fit map
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" size="sm" />}
              >
                Map options
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setCompact((value) => !value)}>
                  {compact ? "Detailed cards" : "Compact cards"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={center}>
                  Center selection
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    positionsRef.current = {};
                    setRevision((old) => old + 1);
                  }}
                >
                  Reorganize
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {layingOut ? (
              <output className="sr-only">Placing new records…</output>
            ) : null}
          </Row>,
          toolbarTarget,
        )
      ) : (
        <Row gap="sm">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void flow.current?.fitView({ padding: 0.15, maxZoom: 1 })
            }
          >
            Fit map
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="sm" />}
            >
              Map options
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setCompact((value) => !value)}>
                {compact ? "Detailed cards" : "Compact cards"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={center}>
                Center selection
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  positionsRef.current = {};
                  setRevision((old) => old + 1);
                }}
              >
                Reorganize
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {layingOut ? (
            <output className="sr-only">Placing new records…</output>
          ) : null}
        </Row>
      )}
      <section
        className="graph-map min-h-0 flex-1"
        data-compact={compact}
        aria-label="Relationship graph"
      >
        <ReactFlow<RecordNode>
          nodes={recordNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          onInit={(instance) => {
            flow.current = instance;
          }}
          onNodeClick={(_, node) => onSelect(node.id)}
          onNodesChange={(changes) => {
            const selection = changes.find(
              (change) => change.type === "select" && change.selected,
            );
            if (selection?.type === "select" && selection.id !== selected)
              onSelect(selection.id);
          }}
          onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
          onEdgesChange={(changes) => {
            const selection = changes.find(
              (change) => change.type === "select" && change.selected,
            );
            if (selection?.type === "select") onSelectEdge(selection.id);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") onSelectEdge(undefined);
          }}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          onlyRenderVisibleElements
          minZoom={0.05}
          maxZoom={2.5}
          defaultViewport={camera.viewport ?? DEFAULT_VIEWPORT}
          onMoveEnd={(_, viewport) => {
            camera.viewport = viewport;
          }}
          panOnScroll
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          fitView={false}
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} />
          {nodes.length > 8 ? (
            <MiniMap
              pannable
              zoomable
              nodeColor={(node) =>
                node.selected ? "var(--primary)" : "var(--muted-foreground)"
              }
              className="hidden md:block"
            />
          ) : null}
        </ReactFlow>
      </section>
      {error !== null && (
        <ErrorDisplay
          error={error}
          title="the relationship graph layout"
          onRetry={() => setRevision((old) => old + 1)}
        />
      )}
    </Stack>
  );
}
