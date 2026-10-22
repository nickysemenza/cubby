import type { EntityRef } from "@cubby/schemas/entity";
import type { EntityGraphNode } from "@cubby/schemas/entity-graph";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import {
  type ComponentProps,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  entities,
  entityDetailParams,
  entityLabel,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { entityGraph } from "~/integrations/tanstack-query/generated/catalog/entityGraph.gen";
import { browserOnlyLazy } from "~/lib/browser-only-lazy";
import { cn } from "~/lib/utils";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useIsMobile } from "~/ui/hooks/use-mobile";
import { Row, Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout/disclosure";
import { Panel } from "~/ui/layout/panel";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "~/ui/primitives/sheet";

import { EntityGraphPicker } from "./entity-graph-picker";
import { graphBranchKey, graphRefKey } from "./entity-graph-state";
import type {
  GraphMapCamera,
  GraphMapCanvas as GraphMapCanvasComponent,
} from "./graph-map-canvas";
import { graphBranchCount, parseGraphRecord } from "./graph-map-state";
import { GraphPathsList, GraphPathExplanation } from "./graph-paths-list";
import { GraphRecordContent, GraphRecordLink } from "./graph-record-content";
import { PhysicalConnectionsPanel } from "./physical-connections";
import {
  useGraphExplorer,
  type GraphExplorerOperations,
} from "./use-graph-explorer";

const GraphLoading = () => <output>Loading graph…</output>;

const RecordProposals = browserOnlyLazy<{ id: string }>(
  import.meta.env.SSR
    ? null
    : () =>
        import("~/entity/suggestions/queue/record-proposals").then(
          (module) => ({ default: module.RecordProposals }),
        ),
);

const GraphMapCanvas = browserOnlyLazy<
  ComponentProps<typeof GraphMapCanvasComponent>
>(
  import.meta.env.SSR
    ? null
    : () =>
        import("./graph-map-canvas").then((module) => ({
          default: module.GraphMapCanvas,
        })),
  GraphLoading,
);

export function GraphExplorer({
  root,
  initialSelected,
  initialDestination,
  initialPathStart,
  onRootChange,
  onNavigationChange,
  onList,
  embedded = false,
  fill = false,
  initialDepth = 1,
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
  /** Drawn inside a detail page: offers the full graph workspace. */
  embedded?: boolean;
  fill?: boolean;
  initialDepth?: 1 | 2 | 3 | 4;
  operations?: GraphExplorerOperations;
}) {
  const [depth, setDepth] = useState<1 | 2 | 3 | 4>(initialDepth);
  const model = useGraphExplorer(root, operations, initialSelected, depth);
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
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const [showList, setShowList] = useState(false);
  const [showInspector, setShowInspector] = useState(false);
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
  const kindOptions = useMemo<PickerOption[]>(
    () => [
      { value: "", label: "All types" },
      ...[...new Set(displayed.nodes.map((node) => node.entityKind))]
        .sort()
        .map((type) => ({ value: type, label: entityLabel(type) })),
    ],
    [displayed.nodes],
  );
  const edge = displayed.edges.find(
    (candidate) => candidate.id === selectedEdge,
  );
  const matches = displayed.nodes.filter(
    (node) =>
      (!kind || node.entityKind === kind) &&
      `${node.label} ${node.entityId}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const select = (key: string, center = false) => {
    model.select(key);
    setSelectedEdge(undefined);
    setInspecting(true);
    setShowInspector(true);
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
  const edgeSource =
    edge &&
    displayed.nodes.find(
      (node) => graphRefKey(node) === graphRefKey(edge.source),
    );
  const edgeTarget =
    edge &&
    displayed.nodes.find(
      (node) => graphRefKey(node) === graphRefKey(edge.target),
    );
  const inspector = (
    <Stack gap="md">
      <GraphRecordInspector
        embedded={embedded}
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
          <Row gap="sm" wrap>
            {edgeSource ? (
              <GraphRecordLink node={edgeSource} />
            ) : (
              edge.source.entityId
            )}
            <span aria-hidden>→</span>
            {edgeTarget ? (
              <GraphRecordLink node={edgeTarget} />
            ) : (
              edge.target.entityId
            )}
          </Row>
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
        <Picker
          mode="choose"
          label="Filter map records"
          className="w-32"
          options={kindOptions}
          value={kind}
          onValueChange={(value) => {
            setKind(value ?? "");
            setShowList(true);
          }}
        />
        {onList || embedded ? (
          <>
            <Link
              to="/graph"
              search={{
                entity: root.entityKind,
                root: root.entityId,
                selected: model.selected,
              }}
              className="text-sm text-primary"
            >
              Open graph
            </Link>
            {onList ? (
              <Button variant="ghost" onClick={onList}>
                Relations list
              </Button>
            ) : null}
          </>
        ) : null}
        <Picker
          mode="choose"
          label="Relationship depth"
          className="w-28"
          value={String(depth)}
          options={[
            { value: "1", label: "1 link" },
            { value: "2", label: "2 links" },
            { value: "3", label: "3 links" },
            { value: "4", label: "4 links" },
          ]}
          onValueChange={(value) => {
            const next = ([1, 2, 3, 4] as const).find(
              (item) => String(item) === value,
            );
            if (next && next !== depth) {
              model.restart();
              setDepth(next);
            }
          }}
        />
        <Button
          variant="outline"
          size="sm"
          aria-pressed={showList}
          onClick={() => setShowList((value) => !value)}
        >
          Paths list
        </Button>
        {!isMobile ? (
          <Button
            variant="outline"
            size="sm"
            aria-pressed={showInspector}
            onClick={() => setShowInspector((value) => !value)}
          >
            Inspector
          </Button>
        ) : null}
        <div ref={setToolbarTarget} className="flex items-center gap-2" />
        <span className="ml-auto text-2xs text-muted-foreground">
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
      {model.errors.size > 0 ? (
        <ErrorDisplay error={model.errors.values().next().value} />
      ) : null}
      {model.atCapacity && (
        <output className="text-sm">
          Map capacity reached: 500 records or 1,000 connections. Start a new
          map from a selected record to continue.
        </output>
      )}
      <div
        className={cn(
          "grid min-w-0 gap-3",
          showInspector && "md:grid-cols-[minmax(0,1fr)_280px]",
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
            <GraphMapCanvas
              key={canvasGeneration}
              camera={camera}
              root={root}
              toolbarTarget={toolbarTarget}
              nodes={displayed.nodes}
              edges={displayed.edges}
              anchors={model.map.anchors}
              branches={model.data.branches}
              counts={model.counts}
              busy={model.busy}
              showSiblings={model.showSiblings}
              onToggleSiblings={model.toggleSiblings}
              onCollapseAll={() => {
                clearPath();
                model.collapseAll();
              }}
              onMoreBranch={(branch) => void model.more(branch)}
              onToggleBranch={(branch) => {
                if (
                  graphBranchCount(
                    branch,
                    model.counts,
                    root,
                    model.showSiblings,
                  )
                )
                  model.collapse(branch);
                else void model.more(branch);
              }}
              selected={model.selected}
              selectedEdge={selectedEdge}
              onSelect={select}
              onSelectEdge={(key) => {
                setSelectedEdge(key);
                setInspecting(true);
                setShowInspector(true);
              }}
              reveal={reveal}
              highlightedEdges={highlightedEdges}
            />
          </div>
          {listing && (
            <Panel
              tone="default"
              flush
              className="absolute inset-0 overflow-auto"
              aria-label="Map records"
            >
              <GraphPathsList
                root={root}
                nodes={displayed.nodes}
                edges={displayed.edges}
                matches={matches}
                onSelect={(key) => {
                  select(key, true);
                  setQuery("");
                  setShowList(false);
                }}
              />
            </Panel>
          )}
        </div>
        {!isMobile && showInspector && (
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
  embedded,
}: {
  model: ReturnType<typeof useGraphExplorer>;
  root: EntityRef;
  embedded: boolean;
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
  const Title = embedded && model.selected === rootKey ? "p" : "h2";
  const branches = model.data.branches.filter(
    (branch) =>
      graphRefKey(branch.root) === model.selected && branch.totalCount > 0,
  );
  const recordLink = (node: EntityGraphNode) =>
    isBrowserRoutedEntity(node.entityKind)
      ? node.entityKind === "usda-food"
        ? router.buildLocation({
            to: "/usda/$id",
            params: { id: node.entityId },
          }).href
        : router.buildLocation({
            to: entities[node.entityKind].routes.detail,
            params: entityDetailParams(node.entityId),
          }).href
      : undefined;
  return (
    <Stack gap="md">
      {selected ? (
        <>
          <Stack gap="sm">
            <span className="text-xs text-muted-foreground">
              {entityLabel(selected.entityKind)} · {selected.entityId}
            </span>
            {/* On its own detail page the root record is already the page heading. */}
            <Title className="sr-only">{selected.label}</Title>
            <GraphRecordContent node={selected} />
            <GraphPathExplanation
              root={root}
              selected={model.selected}
              nodes={model.map.nodes}
              edges={model.map.edges}
            />
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
              const count = graphBranchCount(
                branch,
                model.counts,
                root,
                model.showSiblings,
              );
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
                        disabled={model.busy.has(key)}
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
          <Disclosure summary="Review suggestions" defaultOpen={false}>
            <RecordProposals id={selected.entityId} />
          </Disclosure>
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
    <Disclosure
      summary="Find a path"
      className="border-t border-border pt-3"
      defaultOpen={Boolean(destination)}
    >
      <Stack gap="sm" className="pt-2">
        <EntityGraphPicker
          label="Destination"
          placeholder="Find a destination record…"
          onSelect={(value) => {
            setPathStart(parseGraphRecord(selected) ?? root);
            setDestination({ entityKind: value.entity, entityId: value.id });
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
    </Disclosure>
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
