import type { EntityRef } from "@cubby/schemas/entity";
import type { EntityGraphNode } from "@cubby/schemas/entity-graph";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ListIcon } from "@phosphor-icons/react/dist/csr/List";
import { NetworkIcon } from "@phosphor-icons/react/dist/csr/Network";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import {
  entities,
  entityDetailParams,
  entityLabel,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { entityGraph } from "~/entities/entity-graph.functions";
import { useIsMobile } from "~/hooks/useMobile";
import { cn } from "~/lib/utils";

import { EntityGraphPicker } from "./entity-graph-picker";
import { graphBranchKey, graphRefKey } from "./entity-graph-state";
import type { GraphMapCamera } from "./graph-map-canvas";
import { graphBranchCount, parseGraphRecord } from "./graph-map-state";
import { PhysicalConnectionsPanel } from "./physical-connections";
import {
  useGraphExplorer,
  type GraphExplorerOperations,
} from "./use-graph-explorer";

const GraphMapCanvas = lazy(() =>
  import("./graph-map-canvas").then((module) => ({
    default: module.GraphMapCanvas,
  })),
);

export function GraphExplorer({
  root,
  initialSelected,
  initialDestination,
  initialPathStart,
  onRootChange,
  onNavigationChange,
  onList,
  fill = false,
  operations = entityGraph,
}: {
  root: EntityRef;
  initialSelected?: string;
  initialDestination?: string;
  initialPathStart?: string;
  onRootChange: (root: EntityRef) => void;
  onNavigationChange?: (state: {
    selected: string;
    destination?: string;
    start?: string;
  }) => void;
  onList?: () => void;
  fill?: boolean;
  operations?: GraphExplorerOperations;
}) {
  const model = useGraphExplorer(root, operations, initialSelected);
  const queryClient = useQueryClient();
  const rootKey = graphRefKey(root);
  const [camera] = useState<GraphMapCamera>(
    () =>
      queryClient.getQueryData<GraphMapCamera>(["graph-camera", rootKey]) ?? {
        positions: {},
        viewport: { x: 32, y: 32, zoom: 1 },
      },
  );
  useEffect(
    () => () => {
      queryClient.setQueryData(["graph-camera", rootKey], camera);
    },
    [queryClient, rootKey, camera],
  );
  const isMobile = useIsMobile();
  const [inspecting, setInspecting] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [showList, setShowList] = useState(false);
  const listing = showList || Boolean(query.trim());
  const [reveal, setReveal] = useState(0);
  const [canvasGeneration, setCanvasGeneration] = useState(0);
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const pathSearch = useGraphPathSearch(
    root,
    initialSelected,
    initialDestination,
    model,
    operations,
    initialPathStart,
  );
  const { destination, clearPath, path, navigation } = pathSearch;
  const frame = graphFrameClasses(fill);
  const displayed = model.map;
  const highlightedEdges = useMemo(
    () => new Set(destination ? path?.edgeIds : []),
    [destination, path],
  );
  const edge = displayed.edges.find(
    (candidate) => candidate.id === selectedEdge,
  );
  const matches = displayed.nodes.filter(
    (node) =>
      (!kind || node.entityType === kind) &&
      `${node.label} ${node.entityId}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const select = (key: string, center = false) => {
    model.select(key);
    setSelectedEdge(undefined);
    setInspecting(true);
    if (center) setReveal((old) => old + 1);
  };
  const selectionChange = useRef(onNavigationChange);
  selectionChange.current = onNavigationChange;
  useEffect(() => {
    selectionChange.current?.({
      selected: model.selected,
      ...navigation,
    });
  }, [model.selected, navigation]);
  const inspector = (
    <Stack gap="md">
      <GraphRecordInspector
        model={model}
        root={root}
        operations={operations}
        onRootChange={onRootChange}
        onClearPath={clearPath}
        onResetCamera={() => {
          camera.positions = {};
          camera.viewport = { x: 32, y: 32, zoom: 1 };
          setCanvasGeneration((value) => value + 1);
        }}
      />
      {edge && (
        <Stack
          gap="sm"
          className="border-t border-border pt-3"
          aria-label="Connection evidence"
        >
          <h3 className="text-sm font-medium">{edge.label}</h3>
          <p className="text-xs text-muted-foreground">
            {edge.source.entityId} → {edge.target.entityId}
          </p>
          <p className="text-xs break-words">Source: {edge.sourceKey}</p>
          {edge.provenance.map((source) => (
            <p
              key={source}
              className="text-xs break-words text-muted-foreground"
            >
              {source}
            </p>
          ))}
        </Stack>
      )}
      <GraphPathInspector
        search={pathSearch}
        root={root}
        selected={model.selected}
      />
    </Stack>
  );
  if (model.loading) return <output>Loading relationships…</output>;
  if (model.initial.isError && !model.data.nodes.length)
    return (
      <ErrorDisplay
        error={model.initial.error}
        title="relationships"
        onRetry={() => void model.initial.refetch()}
      />
    );
  if (!model.data.nodes.length)
    return (
      <p role="alert">
        This record is unavailable or has been deleted. Choose another starting
        record.
      </p>
    );
  return (
    <Stack gap="md" className={cn("min-w-0", frame.outer)}>
      <Row gap="sm" wrap>
        <Button
          variant="outline"
          size="icon"
          aria-label="Previous record"
          disabled={model.history.cursor === 0}
          onClick={() => {
            model.back(-1);
            setReveal((old) => old + 1);
          }}
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Next record"
          disabled={model.history.cursor >= model.history.trail.length - 1}
          onClick={() => {
            model.back(1);
            setReveal((old) => old + 1);
          }}
        >
          <ArrowRightIcon />
        </Button>
        <Input
          aria-label="Find explored records"
          placeholder="Find in this map…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="order-first w-full min-w-0 basis-full md:order-none md:w-auto md:flex-1 md:basis-auto"
        />
        <NativeSelect
          aria-label="Filter map records"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value);
            setShowList(true);
          }}
        >
          <option value="">All types</option>
          {[...new Set(displayed.nodes.map((node) => node.entityType))]
            .sort()
            .map((type) => (
              <option value={type} key={type}>
                {entityLabel(type)}
              </option>
            ))}
        </NativeSelect>
        <Button
          variant="outline"
          size="icon"
          aria-label={showList ? "Show graph" : "Show record list"}
          onClick={() => setShowList((old) => !old)}
        >
          {showList ? <NetworkIcon /> : <ListIcon />}
        </Button>
        {onList ? (
          <>
            <Link
              to="/graph"
              search={{
                entity: root.entityType,
                root: root.entityId,
                selected: model.selected,
              }}
              className="text-sm text-primary"
            >
              Open graph
            </Link>
            <Button variant="ghost" onClick={onList}>
              Relations list
            </Button>
          </>
        ) : (
          <Link to="/entities" className="text-xs text-primary">
            Entity tools
          </Link>
        )}
      </Row>
      <Row gap="sm" wrap>
        <span className="text-xs text-muted-foreground">
          {displayed.nodes.length} visible · {model.data.nodes.length} loaded ·{" "}
          {displayed.edges.length} connections
        </span>
        {isMobile && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setInspecting(true)}
          >
            Inspect selection
          </Button>
        )}
      </Row>
      {model.atCapacity && (
        <output className="text-sm">
          Map capacity reached: 500 records or 1,000 connections. Start a new
          map from a selected record to continue.
        </output>
      )}
      <div
        className={cn(
          "grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_280px]",
          frame.grid,
        )}
      >
        <div className="relative min-h-0">
          <div
            className="h-full"
            style={{
              visibility: listing ? "hidden" : "visible",
            }}
            inert={listing}
          >
            <Suspense fallback={<output>Loading graph…</output>}>
              <GraphMapCanvas
                key={canvasGeneration}
                camera={camera}
                nodes={displayed.nodes}
                edges={displayed.edges}
                anchors={model.map.anchors}
                selected={model.selected}
                selectedEdge={selectedEdge}
                onSelect={select}
                onSelectEdge={(key) => {
                  setSelectedEdge(key);
                  setInspecting(true);
                }}
                reveal={reveal}
                highlightedEdges={highlightedEdges}
              />
            </Suspense>
          </div>
          {listing && (
            <div
              className="absolute inset-0 overflow-auto rounded-md border border-border bg-card"
              aria-label="Map records"
            >
              <ul className="divide-y">
                {matches.map((node) => (
                  <li key={graphRefKey(node)}>
                    <Button
                      variant="ghost"
                      className="h-auto min-h-11 w-full justify-start text-left whitespace-normal"
                      onClick={() => {
                        select(graphRefKey(node), true);
                        setQuery("");
                        setShowList(false);
                      }}
                    >
                      {node.label}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {entityLabel(node.entityType)}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
              {!matches.length && (
                <p className="p-4 text-sm">No explored records match.</p>
              )}
            </div>
          )}
        </div>
        {!isMobile && (
          <aside
            className="overflow-auto border-l border-border pl-4"
            aria-label="Graph inspector"
          >
            {inspector}
          </aside>
        )}
      </div>
      {isMobile && (
        <Sheet open={inspecting} onOpenChange={setInspecting}>
          <SheetContent
            side="bottom"
            className="max-h-[75dvh] overflow-auto p-4"
          >
            <SheetHeader>
              <SheetTitle>Graph inspector</SheetTitle>
            </SheetHeader>
            {inspector}
          </SheetContent>
        </Sheet>
      )}
    </Stack>
  );
}

function GraphRecordInspector({
  model,
  root,
  operations,
  onRootChange,
  onResetCamera,
  onClearPath,
}: {
  model: ReturnType<typeof useGraphExplorer>;
  root: EntityRef;
  operations: GraphExplorerOperations;
  onRootChange: (root: EntityRef) => void;
  onResetCamera: () => void;
  onClearPath: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const rootKey = graphRefKey(root);
  const selected = model.data.nodes.find(
    (node) => graphRefKey(node) === model.selected,
  );
  const branches = model.data.branches.filter(
    (branch) =>
      graphRefKey(branch.root) === model.selected && branch.totalCount > 0,
  );
  const recordLink = (node: EntityGraphNode) =>
    isBrowserRoutedEntity(node.entityType)
      ? node.entityType === "usda-food"
        ? router.buildLocation({
            to: "/usda/$id",
            params: { id: node.entityId },
          }).href
        : router.buildLocation({
            to: entities[node.entityType].routes.detail,
            params: entityDetailParams(node.entityId),
          }).href
      : undefined;
  return (
    <Stack gap="md">
      {selected ? (
        <>
          <Stack gap="sm">
            <span className="text-xs text-muted-foreground">
              {entityLabel(selected.entityType)} · {selected.entityId}
            </span>
            <h2 className="text-base font-semibold break-words">
              {selected.label}
            </h2>
            {recordLink(selected) && (
              <Link
                to={recordLink(selected)}
                className="text-sm text-primary underline"
              >
                Open record
              </Link>
            )}
            <Row gap="sm" wrap>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  model.busy.has(model.selected) ||
                  model.expanded.has(model.selected) ||
                  model.selected === graphRefKey(root) ||
                  model.atCapacity
                }
                onClick={() => void model.expand(selected)}
              >
                {model.busy.has(model.selected)
                  ? "Loading connections…"
                  : "Expand connections"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onClearPath();
                  if (graphRefKey(selected) === rootKey) {
                    model.restart();
                    onResetCamera();
                  } else {
                    queryClient.removeQueries({
                      queryKey: ["graph-workspace", graphRefKey(selected)],
                      exact: true,
                    });
                    queryClient.removeQueries({
                      queryKey: ["graph-camera", graphRefKey(selected)],
                      exact: true,
                    });
                    onRootChange(selected);
                  }
                }}
              >
                Start new map here
              </Button>
            </Row>
            {model.errors.has(model.selected) && (
              <ErrorDisplay
                error={model.errors.get(model.selected)}
                title="connections"
                onRetry={() => void model.expand(selected)}
              />
            )}
          </Stack>
          <Stack gap="sm" aria-label="Relationship branches">
            {branches.map((branch) => {
              const key = graphBranchKey(branch.root, branch.relationshipKey);
              const count = graphBranchCount(branch, model.counts);
              return (
                <Stack
                  key={key}
                  gap="sm"
                  className="border-t border-border pt-3"
                >
                  <Row align="center" gap="sm">
                    <h3 className="flex-1 text-sm font-medium">
                      {branch.label}
                    </h3>
                    <span className="text-xs text-muted-foreground">
                      {count} of {branch.totalCount}
                    </span>
                  </Row>
                  <Row gap="sm" wrap>
                    {count < branch.totalCount && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          model.busy.has(key) ||
                          (model.atCapacity && count >= branch.items.length)
                        }
                        onClick={() => void model.more(branch)}
                      >
                        {model.busy.has(key)
                          ? "Loading…"
                          : count
                            ? "Show more"
                            : "Expand"}
                      </Button>
                    )}
                    {count > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => model.collapse(branch)}
                      >
                        Collapse
                      </Button>
                    )}
                    {model.errors.has(key) && (
                      <ErrorDisplay
                        error={model.errors.get(key)}
                        title="this branch"
                        onRetry={() => void model.more(branch)}
                      />
                    )}
                  </Row>
                </Stack>
              );
            })}
          </Stack>
          <PhysicalConnectionsPanel
            subject={selected}
            operations={operations}
          />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Select a record to inspect its connections.
        </p>
      )}
    </Stack>
  );
}

function useGraphPathSearch(
  root: EntityRef,
  initialSelected: string | undefined,
  initialDestination: string | undefined,
  model: ReturnType<typeof useGraphExplorer>,
  operations: GraphExplorerOperations = entityGraph,
  initialPathStart?: string,
) {
  const [destination, setDestination] = useState(() =>
    parseGraphRecord(
      initialDestination ??
        (initialSelected !== graphRefKey(root) &&
        !model.map.nodes.some((node) => graphRefKey(node) === initialSelected)
          ? initialSelected
          : undefined),
    ),
  );
  const [pathStart, setPathStart] = useState(
    () => parseGraphRecord(initialPathStart) ?? root,
  );
  const [pathIndex, setPathIndex] = useState(0);
  const paths = useQuery({
    ...(operations.graphPaths ?? entityGraph.graphPaths).queryOptions({
      start: pathStart,
      destination: destination ?? root,
    }),
    enabled: Boolean(destination),
  });
  const path = paths.data?.paths[pathIndex];
  const applyPath = model.applyPath;
  useEffect(() => {
    applyPath(
      destination && paths.data && path
        ? {
            nodes: paths.data.nodes.filter((node) =>
              path.nodeRefs.some(
                (ref) => graphRefKey(ref) === graphRefKey(node),
              ),
            ),
            edges: paths.data.edges.filter((edge) =>
              path.edgeIds.includes(edge.id),
            ),
            branches: [],
            truncated: false,
          }
        : undefined,
    );
  }, [destination, paths.data, path, applyPath]);
  const navigation = useMemo(
    () => ({
      destination: destination ? graphRefKey(destination) : undefined,
      start: destination ? graphRefKey(pathStart) : undefined,
    }),
    [destination, pathStart],
  );
  const clearPath = () => {
    model.clearPath();
    setDestination(undefined);
  };
  return {
    clearPath,
    navigation,
    destination,
    setDestination,
    pathStart,
    setPathStart,
    pathIndex,
    setPathIndex,
    paths,
    path,
  };
}

function GraphPathInspector({
  search,
  root,
  selected,
}: {
  search: ReturnType<typeof useGraphPathSearch>;
  root: EntityRef;
  selected: string;
}) {
  const {
    destination,
    setDestination,
    clearPath,
    setPathStart,
    pathIndex,
    setPathIndex,
    paths,
  } = search;
  return (
    <details
      className="border-t border-border pt-3"
      open={Boolean(destination)}
    >
      <summary className="cursor-pointer text-sm font-medium">
        Find a path
      </summary>
      <Stack gap="sm" className="pt-3">
        <EntityGraphPicker
          label="Destination"
          placeholder="Find a destination record…"
          onSelect={(value) => {
            setPathStart(parseGraphRecord(selected) ?? root);
            setDestination({ entityType: value.entity, entityId: value.id });
            setPathIndex(0);
          }}
        />
        {destination && (
          <>
            {paths.isFetching && <output>Searching for paths…</output>}
            {paths.isError && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void paths.refetch()}
              >
                Retry path search
              </Button>
            )}
            {paths.data?.paths.map((candidate, index) => (
              <Button
                key={candidate.edgeIds.join(":")}
                variant={index === pathIndex ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setPathIndex(index)}
              >
                Path {index + 1} · {candidate.edgeIds.length} connections
              </Button>
            ))}
            {paths.data && !paths.data.paths.length && (
              <p className="text-xs">
                {paths.data.completion === "exhausted"
                  ? "No connection found."
                  : "No path found within the search limits."}
              </p>
            )}
            {paths.data && !paths.data.shortestPathCertain && (
              <p className="text-xs">
                Search limits prevent confirming the shortest path.
              </p>
            )}
            <Button variant="ghost" size="sm" onClick={clearPath}>
              Clear path
            </Button>
          </>
        )}
      </Stack>
    </details>
  );
}

function graphFrameClasses(fill: boolean) {
  return fill
    ? { outer: "min-h-0 flex-1", grid: "min-h-0 flex-1" }
    : {
        outer: "",
        grid: "h-[max(360px,calc(var(--app-viewport-height,100dvh)-340px))]",
      };
}
