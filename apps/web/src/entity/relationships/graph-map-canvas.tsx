import type {
  EntityGraphEdge,
  EntityGraphNode,
  EntityGraphBranch,
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

import { graphRefKey, graphBranchKey } from "./entity-graph-state";
import {
  GRAPH_CARD_WIDTH,
  GRAPH_CARD_HEIGHT,
  graphMapLayoutOutputSchema,
  type GraphMapRect,
} from "./graph-map-layout";
import { graphBranchCount } from "./graph-map-state";
import { GraphRecordContent } from "./graph-record-content";

import "@xyflow/react/dist/style.css";
import "./graph-map.css";

type RecordNode = Node<{
  record: EntityGraphNode;
  related: EntityGraphNode[];
  depth: number;
  branch?: EntityGraphBranch;
  count?: number;
  toggle?: () => void;
  more?: () => void;
}>;
const GraphRecord = memo(function GraphRecord({
  data,
  selected,
}: NodeProps<RecordNode>) {
  return (
    <div
      className={data.branch ? "graph-map-branch" : "graph-map-record"}
      data-selected={selected}
    >
      {Object.values(Position).map((position) => (
        <Handle
          key={`target-${position}`}
          id={`target-${position}`}
          type="target"
          position={position}
          isConnectable={false}
        />
      ))}
      {data.branch ? (
        <>
          <button
            className="nodrag nopan graph-branch-button"
            aria-label={`${data.count ? "Collapse" : "Expand"} ${data.branch.label} (${data.branch.totalCount})`}
            aria-expanded={Boolean(data.count)}
            onClick={(event) => {
              event.stopPropagation();
              data.toggle?.();
            }}
          >
            <span>{data.branch.label}</span>
            <span className="text-xs text-muted-foreground">
              {data.count
                ? `${data.count} of ${data.branch.totalCount} · Collapse`
                : `${data.branch.totalCount} · Expand`}
            </span>
          </button>
          {Boolean(data.count) && (data.count ?? 0) < data.branch.totalCount ? (
            <button
              className="nodrag nopan px-3 text-xs"
              aria-label={`Load more ${data.branch.label}`}
              onClick={(event) => {
                event.stopPropagation();
                data.more?.();
              }}
            >
              More
            </button>
          ) : null}
        </>
      ) : (
        <>
          <Row
            gap="sm"
            align="center"
            className="text-xs text-muted-foreground"
          >
            <EntityIcon entity={data.record.entityKind} className="size-3.5" />
            <span>{entityLabel(data.record.entityKind)}</span>
          </Row>
          <span className="graph-record-depth">
            {data.depth === 0
              ? "Focus"
              : `${data.depth} ${data.depth === 1 ? "link" : "links"}`}
          </span>
          <GraphRecordContent node={data.record} compact />
        </>
      )}
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
const MIN_READABLE_ZOOM = 0.85;
function edgeHandles(a?: GraphMapRect, b?: GraphMapRect) {
  const dx = (b ? b.x + b.width / 2 : 0) - (a ? a.x + a.width / 2 : 0);
  const dy = (b ? b.y + b.height / 2 : 0) - (a ? a.y + a.height / 2 : 0);
  const horizontal =
    Math.abs(dx) / GRAPH_CARD_WIDTH > Math.abs(dy) / GRAPH_CARD_HEIGHT;
  const source = horizontal
    ? dx >= 0
      ? Position.Right
      : Position.Left
    : dy >= 0
      ? Position.Bottom
      : Position.Top;
  const target = horizontal
    ? dx >= 0
      ? Position.Left
      : Position.Right
    : dy >= 0
      ? Position.Top
      : Position.Bottom;
  return { sourceHandle: `source-${source}`, targetHandle: `target-${target}` };
}
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
  branches = [],
  counts = new Map(),
  onToggleBranch,
  showSiblings = false,
  onToggleSiblings,
  onMoreBranch,
  onCollapseAll,
}: {
  root: { entityKind: EntityGraphNode["entityKind"]; entityId: string };
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
  branches?: EntityGraphBranch[];
  counts?: ReadonlyMap<string, number>;
  onToggleBranch?: (branch: EntityGraphBranch) => void;
  showSiblings?: boolean;
  onToggleSiblings?: () => void;
  onMoreBranch?: (branch: EntityGraphBranch) => void;
  onCollapseAll?: () => void;
}) {
  const [positions, setPositions] = useState(
    camera.positions ?? EMPTY_POSITIONS,
  );
  const positionsRef = useRef(positions);
  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [layingOut, setLayingOut] = useState(false);
  const worker = useRef<Worker>(null);
  const requestID = useRef(0);
  const flow = useRef<ReactFlowInstance<RecordNode>>(null);
  const needsInitialCenter = useRef(Object.keys(camera.positions).length === 0);
  const [showOverview, setShowOverview] = useState(false);
  const groups = useMemo(() => {
    const visible = new Map(nodes.map((node) => [graphRefKey(node), node]));
    return branches.flatMap((branch) => {
      const owner = graphRefKey(branch.root);
      const record = visible.get(owner);
      if (
        !record ||
        (owner !== graphRefKey(root) && owner !== selected) ||
        !branch.totalCount
      )
        return [];
      const count = graphBranchCount(branch, counts, root, showSiblings);
      if (
        branch.totalCount === 1 &&
        branch.items.every((item) => visible.has(graphRefKey(item)))
      )
        return [];
      return [
        {
          id: `branch:${graphBranchKey(branch.root, branch.relationshipKey)}`,
          owner,
          record,
          branch,
          count,
        },
      ];
    });
  }, [nodes, branches, counts, root, selected, showSiblings]);
  const topology = JSON.stringify([
    { id: graphRefKey(root) },
    ...groups.map((group) => ({
      id: group.id,
      anchor: group.owner,
      height: 64,
    })),
    ...nodes
      .filter((node) => graphRefKey(node) !== graphRefKey(root))
      .map((node) => {
        const id = graphRefKey(node);
        const parent = anchors.get(id);
        const group = groups.find(
          (item) =>
            item.owner === parent &&
            item.branch.items.some((ref) => graphRefKey(ref) === id),
        );
        return { id, anchor: group?.id ?? parent ?? graphRefKey(root) };
      }),
  ]);
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
    const first = root;
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
  }, [root, relatedRecords]);
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
    () => [
      ...baseNodes.map((node) => ({ ...node, selected: node.id === selected })),
      ...groups.flatMap((group): RecordNode[] => {
        const position = positions[group.id];
        return position
          ? [
              {
                id: group.id,
                type: "record",
                position,
                width: position.width,
                height: position.height,
                draggable: false,
                selectable: false,
                focusable: false,
                data: {
                  record: group.record,
                  related: [],
                  depth: 0,
                  branch: group.branch,
                  count: group.count,
                  toggle: () => onToggleBranch?.(group.branch),
                  more: () => onMoreBranch?.(group.branch),
                },
              },
            ]
          : [];
      }),
    ],
    [baseNodes, selected, groups, positions, onToggleBranch, onMoreBranch],
  );
  const flowEdges = useMemo(
    () => [
      ...edges.map((edge) => {
        const group = groups.find((item) =>
          item.branch.edgeIds.includes(edge.id),
        );
        const from = graphRefKey(edge.source);
        const to = graphRefKey(edge.target);
        const source = group?.owner === from ? group.id : from;
        const target = group?.owner === to ? group.id : to;
        const handles = edgeHandles(positions[source], positions[target]);
        const active = highlightedEdges.size
          ? highlightedEdges.has(edge.id)
          : edge.id === selectedEdge ||
            source === selected ||
            target === selected;
        return {
          id: edge.id,
          source,
          target,
          type: "default",
          ...handles,
          selected: edge.id === selectedEdge,
          label: edge.id === selectedEdge ? edge.label : undefined,
          className: active ? "graph-map-edge-active" : "graph-map-edge",
          ariaLabel: edge.label,
          markerEnd: { type: MarkerType.ArrowClosed },
        };
      }),
      ...groups.map((group) => ({
        id: `stem:${group.id}`,
        source: group.owner,
        target: group.id,
        ...edgeHandles(positions[group.owner], positions[group.id]),
        type: "default",
        selectable: false,
        focusable: false,
        style: { stroke: "var(--border)" },
      })),
    ],
    [edges, positions, selected, selectedEdge, highlightedEdges, groups],
  );
  const center = () => {
    const rect = positionsRef.current[selected];
    if (rect)
      void flow.current?.setCenter(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        { zoom: Math.max(MIN_READABLE_ZOOM, flow.current.getZoom()) },
      );
  };
  const fitFocus = () =>
    void flow.current?.fitView({
      padding: 0.08,
      minZoom: MIN_READABLE_ZOOM,
      maxZoom: 1,
      nodes: recordNodes.filter(
        (node) =>
          node.id === graphRefKey(root) ||
          groups.some(
            (group) =>
              group.id === node.id && group.owner === graphRefKey(root),
          ) ||
          anchors.get(node.id) === graphRefKey(root),
      ),
    });
  const fitFocusRef = useRef(fitFocus);
  fitFocusRef.current = fitFocus;
  useEffect(() => {
    if (reveal) centerRef.current();
  }, [reveal]);
  useEffect(() => {
    if (needsInitialCenter.current && positions[selected] && flow.current) {
      const frame = requestAnimationFrame(() => {
        fitFocusRef.current();
        needsInitialCenter.current = false;
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [positions, selected]);
  const toolbar = (
    <Row gap="sm">
      <Button variant="outline" size="sm" onClick={fitFocus}>
        Fit focus
      </Button>
      {onCollapseAll ? (
        <Button variant="outline" size="sm" onClick={onCollapseAll}>
          Collapse all
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
          Map options
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={center}>Center selection</DropdownMenuItem>
          {onToggleSiblings ? (
            <DropdownMenuItem onClick={onToggleSiblings}>
              {showSiblings ? "Hide siblings" : "Show siblings"}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => setShowOverview((value) => !value)}>
            {showOverview ? "Hide overview" : "Show overview"}
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
  );
  return (
    <Stack gap="sm" className="h-full min-h-0">
      {toolbarTarget ? createPortal(toolbar, toolbarTarget) : toolbar}
      <section
        className="graph-map min-h-0 flex-1"
        aria-label="Relationship graph"
      >
        <ReactFlow<RecordNode>
          nodes={recordNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          onInit={(instance) => {
            flow.current = instance;
          }}
          onNodeClick={(_, node) => {
            if (!node.data.branch) onSelect(node.id);
          }}
          onNodesChange={(changes) => {
            const selection = changes.find(
              (change) => change.type === "select" && change.selected,
            );
            if (selection?.type === "select" && selection.id !== selected)
              onSelect(selection.id);
          }}
          onEdgeClick={(_, edge) => {
            if (!edge.id.startsWith("stem:")) onSelectEdge(edge.id);
          }}
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
          minZoom={MIN_READABLE_ZOOM}
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
          <Controls showInteractive={false} showFitView={false} />
          {showOverview ? (
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
