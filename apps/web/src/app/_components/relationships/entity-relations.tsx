import { type Entity, type EntityRef } from "@cubby/schemas/entity";
import {
  entityGraphRootSchema,
  type EntityGraphBranch,
  type EntityGraphEdge,
  type EntityGraphExploreOutput,
  type EntityGraphNode,
  type EntityGraphOutput,
} from "@cubby/schemas/entity-graph";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { ArrowClockwiseIcon as RotateCw } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowLeftIcon as ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ListIcon as List } from "@phosphor-icons/react/dist/csr/List";
import { NetworkIcon as Network } from "@phosphor-icons/react/dist/csr/Network";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { useInventoryPlacementAction } from "~/app/_components/inventory/inventory-placement-suggestion";
import {
  EntityRecommendations,
  type EntityRecommendationOperations,
} from "~/app/_components/relatedness/entity-recommendations";
import { EntityGraphPicker } from "~/app/_components/relationships/entity-graph-picker";
import { PhysicalConnectionsPanel } from "~/app/_components/relationships/physical-connections";
import { inventory } from "~/app/inventory/inventory.functions";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { ChoiceSwitcher, ViewSwitcher } from "~/components/ui/view-switcher";
import {
  entities,
  EntityIcon,
  entityDetailParams,
  entityLabel,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import {
  entityMutationOptionsFactory,
  type EntityMutationOptionsFactory,
} from "~/entities/entity-contracts";
import { entityGraph } from "~/entities/entity-graph.functions";
import { useHydratedLoading } from "~/hooks/useHydrated";
import { formatCurrency } from "~/lib/utils";

import {
  GRAPH_BRANCH_PAGE_SIZE,
  GRAPH_EDGE_LIMIT,
  GRAPH_NEIGHBOR_LIMIT,
  GRAPH_NODE_LIMIT,
  graphBranchKey,
  graphRefKey,
  mergeGraphPages,
  moveGraphVisit,
  visibleNeighborhoodKeys,
  visitGraphRecord,
} from "./entity-graph-state";
import { GraphExplorer } from "./graph-explorer";

const VIEW_OPTIONS = [
  { value: "list", label: "List", icon: List },
  { value: "graph", label: "Graph", icon: Network },
] as const;
export function supportsEntityGraph(entity: Entity) {
  return (
    entityManifest[entity].dbTable !== null &&
    "shortcodePrefix" in entityManifest[entity]
  );
}

export interface EntityRelationsState {
  view?: "list" | "graph";
  layout?: "neighborhood" | "flow";
  query?: string;
  entityType?: Entity;
  relationship?: string;
  selected?: string;
  trail?: string[];
  cursor?: number;
  collapsed?: string[];
  destination?: string;
  depth?: 1 | 2 | 3;
}

const refFromKey = (key?: string): EntityRef | undefined => {
  const split = key?.indexOf(":") ?? -1;
  const entityType = allEntities.find(
    (entity) => entity === key?.slice(0, split),
  );
  return entityGraphRootSchema.safeParse({
    entityType,
    entityId: key?.slice(split + 1),
  }).data;
};
const atCapacity = (data: EntityGraphOutput) =>
  data.nodes.length >= GRAPH_NODE_LIMIT ||
  data.edges.length >= GRAPH_EDGE_LIMIT;

type EntityGraphOperations = {
  explore: typeof entityGraph.explore;
  graph: typeof entityGraph.graph;
  graphPaths?: typeof entityGraph.graphPaths;
  connections?: typeof entityGraph.connections;
};

export interface EntityRecommendationActionOperations {
  expenseUpdate: EntityMutationOptionsFactory<"expense", "update">;
  inventoryMove: typeof inventory.moveEntries;
}

const productionRecommendationActionOperations: EntityRecommendationActionOperations =
  {
    expenseUpdate: entityMutationOptionsFactory("expense", "update"),
    inventoryMove: inventory.moveEntries,
  };

export function EntityRelations({
  entity,
  sourceId,
  state,
  onStateChange,
  operations = entityGraph,
  recommendationOperations,
  recommendationActionOperations = productionRecommendationActionOperations,
}: {
  entity: Entity;
  sourceId: string;
  state?: EntityRelationsState;
  onStateChange?: (state: EntityRelationsState) => void;
  operations?: EntityGraphOperations;
  recommendationOperations?: EntityRecommendationOperations;
  recommendationActionOperations?: EntityRecommendationActionOperations;
}) {
  const [localView, setLocalView] = useState<"list" | "graph">("list");
  const router = useRouter();
  const root = useMemo(
    () => ({ entityType: entity, entityId: sourceId }),
    [entity, sourceId],
  );
  if (!supportsEntityGraph(entity)) return null;
  if ((state?.view ?? localView) === "graph")
    return (
      <GraphExplorer
        key={`${entity}:${sourceId}`}
        root={root}
        initialSelected={state?.selected}
        initialDestination={state?.destination}
        operations={operations}
        onRootChange={(value) =>
          void router.navigate({
            to: "/graph",
            search: { entity: value.entityType, root: value.entityId },
          })
        }
        onNavigationChange={(navigation) =>
          onStateChange?.({ ...state, view: "graph", ...navigation })
        }
        onList={() => {
          setLocalView("list");
          onStateChange?.({ ...state, view: "list" });
        }}
      />
    );
  return (
    <EntityRelationsSession
      key={`${entity}:${sourceId}`}
      root={{ entityType: entity, entityId: sourceId }}
      state={state}
      onStateChange={(next) => {
        setLocalView(next.view ?? "list");
        onStateChange?.(next);
      }}
      operations={operations}
      recommendationOperations={recommendationOperations}
      recommendationActionOperations={recommendationActionOperations}
    />
  );
}

function useEntityRelationsModel({
  root,
  state,
  onStateChange,
  operations,
  recommendationOperations,
  recommendationActionOperations,
}: {
  root: EntityRef;
  state?: EntityRelationsState;
  onStateChange?: (state: EntityRelationsState) => void;
  operations: EntityGraphOperations;
  recommendationOperations?: EntityRecommendationOperations;
  recommendationActionOperations: EntityRecommendationActionOperations;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const rootKey = graphRefKey(root);
  const [local, setLocal] = useState<EntityRelationsState>({
    view: "list",
    selected: rootKey,
    trail: [rootKey],
    cursor: 0,
  });
  const current = state ?? local;
  const trail = current.trail?.length ? current.trail : [rootKey];
  const cursor = Math.max(
    0,
    Math.min(trail.length - 1, current.cursor ?? trail.length - 1),
  );
  const selectedKey = current.selected ?? trail[cursor] ?? rootKey;
  const selectedKeyRef = useRef(selectedKey);
  selectedKeyRef.current = selectedKey;
  const change = (patch: Partial<EntityRelationsState>) => {
    const next = { ...current, ...patch };
    setLocal(next);
    onStateChange?.(next);
  };
  const selectedRef = refFromKey(selectedKey) ?? root;
  const initial = useQuery(
    operations.explore.queryOptions({
      root: selectedRef,
      depth: current.depth ?? 1,
    }),
  );
  const loading = useHydratedLoading(initial.isPending);
  const [pages, setPages] = useState(new Map<string, EntityGraphOutput>());
  const [visibleCounts, setVisibleCounts] = useState(new Map<string, number>());
  const [busy, setBusy] = useState(new Set<string>());
  const [errors, setErrors] = useState(new Map<string, unknown>());
  const pending = useRef(new Set<string>());
  const requestVersion = useRef(new Map<string, number>());
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const data = useMemo(
    () =>
      mergeGraphPages([
        ...(initial.data ? [initial.data] : []),
        ...pages.values(),
      ]),
    [initial.data, pages],
  );
  const selected =
    data.nodes.find((node) => graphRefKey(node) === selectedKey) ??
    data.nodes.find((node) => graphRefKey(node) === rootKey);
  const branches = data.branches.filter(
    (branch) => graphRefKey(branch.root) === selectedKey,
  );
  const collapsed = new Set(current.collapsed ?? []);

  const fetchPage = async (
    key: string,
    input: Parameters<typeof operations.graph.queryOptions>[0],
    branchKey: string,
    fresh = false,
  ) => {
    if (pending.current.has(key) || (!fresh && atCapacity(data)))
      return undefined;
    pending.current.add(key);
    const version = (requestVersion.current.get(key) ?? 0) + 1;
    requestVersion.current.set(key, version);
    setBusy((old) => new Set(old).add(branchKey));
    setErrors((old) => {
      const next = new Map(old);
      next.delete(branchKey);
      return next;
    });
    try {
      const options = operations.graph.queryOptions(input);
      const page = fresh
        ? await queryClient.fetchQuery({ ...options, staleTime: 0 })
        : await queryClient.fetchQuery(options);
      if (requestVersion.current.get(key) !== version) return undefined;
      setPages((old) => new Map(old).set(key, page));
      return page;
    } catch (error) {
      setErrors((old) => new Map(old).set(branchKey, error));
      return undefined;
    } finally {
      pending.current.delete(key);
      setBusy((old) => {
        const next = new Set(old);
        next.delete(branchKey);
        return next;
      });
    }
  };
  const ensureNeighborhood = async (ref: EntityRef) => {
    const refKey = graphRefKey(ref);
    const key = `neighborhood:${refKey}`;
    if (
      (refKey === selectedKey && initial.isPending) ||
      data.branches.some((branch) => graphRefKey(branch.root) === refKey) ||
      pages.has(key)
    )
      return;
    await fetchPage(
      key,
      { roots: [ref], limit: GRAPH_BRANCH_PAGE_SIZE },
      refKey,
    );
  };
  const loadSelected = useEffectEvent(() => {
    const ref = refFromKey(selectedKey);
    if (ref) void ensureNeighborhood(ref);
  });
  useEffect(() => {
    loadSelected();
  }, [selectedKey]);
  const selectRecord = (key: string) => {
    const ref = refFromKey(key);
    if (!ref) return;
    const next = visitGraphRecord({ trail, cursor }, key);
    setSelectedEdgeId(undefined);
    change({ selected: key, trail: next.trail, cursor: next.cursor });
    void ensureNeighborhood(ref);
  };
  const moveHistory = (offset: -1 | 1) => {
    const next = moveGraphVisit({ trail, cursor }, offset);
    const key = next.trail[next.cursor] ?? rootKey;
    change({ selected: key, trail: next.trail, cursor: next.cursor });
    const ref = refFromKey(key);
    if (ref) void ensureNeighborhood(ref);
  };
  const showMore = async (branch: EntityGraphBranch) => {
    const key = graphBranchKey(branch.root, branch.relationshipKey);
    const shown = collapsed.has(key) ? 0 : (visibleCounts.get(key) ?? 12);
    const desired = Math.min(branch.totalCount, shown + 12);
    change({ collapsed: [...collapsed].filter((value) => value !== key) });
    if (branch.items.length >= desired || branch.nextOffset === null)
      setVisibleCounts((old) => new Map(old).set(key, desired));
    else {
      const page = await fetchPage(
        `branch:${key}:${branch.nextOffset}`,
        {
          roots: [branch.root],
          relationshipKeys: [branch.relationshipKey],
          offset: branch.nextOffset,
          limit: 12,
        },
        key,
      );
      if (page && selectedKeyRef.current === graphRefKey(branch.root))
        setVisibleCounts((old) => new Map(old).set(key, desired));
    }
  };
  const reload = async () => {
    const ref = refFromKey(selectedKey);
    if (!ref) return;
    const key = `neighborhood:${selectedKey}`;
    const page = await fetchPage(
      key,
      { roots: [ref], limit: 12 },
      selectedKey,
      true,
    );
    if (page)
      setPages((old) => {
        const next = new Map(
          [...old].filter(
            ([, value]) =>
              !value.branches.some(
                (branch) => graphRefKey(branch.root) === selectedKey,
              ),
          ),
        );
        next.set(key, page);
        return next;
      });
  };

  const { text, neighborhood } = exploredProjection(
    data,
    current,
    branches,
    visibleCounts,
    collapsed,
  );
  const destination = refFromKey(current.destination);
  const paths = useQuery({
    ...(operations.graphPaths ?? entityGraph.graphPaths).queryOptions({
      start: selectedRef,
      destination: destination ?? selectedRef,
    }),
    enabled: Boolean(destination),
  });
  const [pathIndex, setPathIndex] = useState(0);
  const selectedEdge = [...data.edges, ...(paths.data?.edges ?? [])].find(
    (edge) => edge.id === selectedEdgeId,
  );

  return {
    root,
    rootKey,
    router,
    operations,
    current,
    trail,
    cursor,
    selectedKey,
    change,
    initial,
    loading,
    data,
    selected,
    branches,
    collapsed,
    visibleCounts,
    busy,
    errors,
    selectedEdgeId,
    setSelectedEdgeId,
    selectedEdge,
    selectRecord,
    moveHistory,
    ensureNeighborhood,
    showMore,
    reload,
    text,
    neighborhood,
    destination,
    paths,
    pathIndex,
    setPathIndex,
    recommendationOperations,
    recommendationActionOperations,
    selectedRef,
  };
}

function EntityRelationsSession(
  props: Parameters<typeof useEntityRelationsModel>[0],
) {
  return <EntityRelationsContent {...useEntityRelationsModel(props)} />;
}

function RelationshipRecommendations({
  source,
  operations,
  actionOperations,
}: {
  source: EntityRef;
  operations?: EntityRecommendationOperations;
  actionOperations: EntityRecommendationActionOperations;
}) {
  const expenseUpdate = useMutation(actionOperations.expenseUpdate());
  const inventoryPlacement = useInventoryPlacementAction({
    moveOperation: actionOperations.inventoryMove,
  });

  return (
    <EntityRecommendations
      source={source}
      operations={operations}
      pending={expenseUpdate.isPending || inventoryPlacement.isPending}
      onAcceptExpenseProject={async (proposal) => {
        await expenseUpdate.mutateAsync({
          id: proposal.expenseId,
          data: { projectId: proposal.target.id },
        });
      }}
      onAcceptInventoryPlacement={inventoryPlacement.accept}
    />
  );
}

function EntityRelationsContent(
  model: ReturnType<typeof useEntityRelationsModel>,
) {
  const {
    root,
    router,
    operations,
    current,
    trail,
    cursor,
    selectedKey,
    change,
    initial,
    loading,
    data,
    branches,
    collapsed,
    visibleCounts,
    busy,
    errors,
    setSelectedEdgeId,
    selectedEdge,
    selectRecord,
    showMore,
    text,
    neighborhood,
    destination,
    paths,
    pathIndex,
    setPathIndex,
    recommendationOperations,
    recommendationActionOperations,
    selectedRef,
  } = model;
  if (loading)
    return (
      <Stack gap="md">
        <RelationshipRecommendations
          source={selectedRef}
          operations={recommendationOperations}
          actionOperations={recommendationActionOperations}
        />
        <output>Loading relationships…</output>
      </Stack>
    );
  if (initial.isError)
    return (
      <Stack gap="md">
        <RelationshipRecommendations
          source={selectedRef}
          operations={recommendationOperations}
          actionOperations={recommendationActionOperations}
        />
        <ErrorDisplay
          error={initial.error}
          title="relationships"
          onRetry={() => void initial.refetch()}
        />
      </Stack>
    );
  return (
    <Stack gap="md">
      <RelationshipRecommendations
        source={selectedRef}
        operations={recommendationOperations}
        actionOperations={recommendationActionOperations}
      />
      {data.nodes.length === 0 && (
        <p role="alert">
          This record is unavailable or has been deleted. Choose another
          starting record.
        </p>
      )}
      <Row wrap gap="sm" align="center">
        <ViewSwitcher
          options={VIEW_OPTIONS}
          value={current.view ?? "list"}
          onValueChange={(view) => change({ view })}
        />
        <ChoiceSwitcher
          ariaLabel="Declared relationship depth"
          options={[
            { value: "1", label: "1" },
            { value: "2", label: "2" },
            { value: "3", label: "3" },
          ]}
          value={String(current.depth ?? 1)}
          onValueChange={(value: string) => {
            const depth = ([1, 2, 3] as const).find(
              (candidate) => String(candidate) === value,
            );
            if (depth) change({ depth });
          }}
        />
        <span className="text-xs text-muted-foreground">
          Depth counts declared relationship hops.
        </span>
        <Link
          to="/entities"
          search={{
            tab: "explore",
            entity: root.entityType,
            root: root.entityId,
            view: "graph",
            layout: current.layout,
            selected: selectedKey,
            trail,
            cursor,
            collapsed: current.collapsed,
            destination: current.destination,
            depth: current.depth,
          }}
          className="text-sm text-primary hover:underline"
        >
          Open explorer
        </Link>
      </Row>
      <Row wrap gap="sm">
        <Input
          aria-label="Find explored records"
          placeholder="Find in explored records…"
          value={current.query ?? ""}
          onChange={(event) =>
            change({ query: event.target.value || undefined })
          }
          className="min-w-0 flex-1"
        />
        <NativeSelect
          aria-label="Filter entity type"
          value={current.entityType ?? ""}
          onChange={(event) =>
            change({
              entityType: allEntities.find(
                (entity) => entity === event.target.value,
              ),
            })
          }
        >
          <option value="">All entity types</option>
          {allEntities.filter(supportsEntityGraph).map((entity) => (
            <option key={entity} value={entity}>
              {entityLabel(entity)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Filter relationship"
          value={current.relationship ?? ""}
          onChange={(event) =>
            change({ relationship: event.target.value || undefined })
          }
        >
          <option value="">All relationships</option>
          {[
            ...new Map(data.branches.map((b) => [b.relationshipKey, b.label])),
          ].map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </Row>
      <VisitedRecords model={model} />
      <GraphPathPanel
        paths={paths}
        destination={destination}
        pathIndex={pathIndex}
        setPathIndex={setPathIndex}
        change={change}
      />
      <ExplorationCompletion data={initial.data} />
      {(data.truncated || atCapacity(data)) && (
        <output className="text-sm text-muted-foreground">
          Exploration capacity reached. Open a connected record as a new
          starting point to explore further.
        </output>
      )}
      {selectedEdge && (
        <EdgeInspector
          edge={selectedEdge}
          onClose={() => setSelectedEdgeId(undefined)}
        />
      )}
      <RelationshipBranches
        data={data}
        branches={branches}
        current={current}
        query={text}
        counts={visibleCounts}
        collapsed={collapsed}
        busy={busy}
        errors={errors}
        capacity={atCapacity(data)}
        neighborhoodKeys={current.layout !== "flow" ? neighborhood : undefined}
        router={router}
        onSelect={selectRecord}
        onMore={showMore}
        onCollapse={(branch) => {
          const key = graphBranchKey(branch.root, branch.relationshipKey);
          change({ collapsed: [...new Set([...collapsed, key])] });
        }}
      />
      {neighborhood.size >= GRAPH_NEIGHBOR_LIMIT && (
        <p className="text-xs text-muted-foreground">
          The neighborhood shows {GRAPH_NEIGHBOR_LIMIT} connected records,
          shared fairly across relationship branches. Collapse a branch to make
          room for another.
        </p>
      )}
      <PhysicalConnectionsPanel subject={selectedRef} operations={operations} />
    </Stack>
  );
}

function RelationshipBranches({
  data,
  branches,
  current,
  query,
  counts,
  collapsed,
  busy,
  errors,
  capacity,
  neighborhoodKeys,
  router,
  onSelect,
  onMore,
  onCollapse,
}: {
  data: EntityGraphOutput;
  branches: EntityGraphBranch[];
  current: EntityRelationsState;
  query: string;
  counts: ReadonlyMap<string, number>;
  collapsed: ReadonlySet<string>;
  busy: ReadonlySet<string>;
  errors: ReadonlyMap<string, unknown>;
  capacity: boolean;
  neighborhoodKeys?: ReadonlySet<string>;
  router: ReturnType<typeof useRouter>;
  onSelect: (key: string) => void;
  onMore: (branch: EntityGraphBranch) => void;
  onCollapse: (branch: EntityGraphBranch) => void;
}) {
  const [showEmpty, setShowEmpty] = useState(false);
  const shown = branches.filter(
    (b) =>
      (showEmpty || b.totalCount > 0) &&
      (!current.entityType || b.target === current.entityType) &&
      (!current.relationship || b.relationshipKey === current.relationship),
  );
  return (
    <Stack gap="sm">
      <Row gap="sm">
        <span className="text-sm text-muted-foreground">
          {data.nodes.length} explored records
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowEmpty(!showEmpty)}
        >
          {showEmpty ? "Hide empty" : "Show empty"}
        </Button>
      </Row>
      {neighborhoodKeys && neighborhoodKeys.size >= GRAPH_NEIGHBOR_LIMIT && (
        <output className="text-sm text-muted-foreground">
          Showing 60 neighbors. Collapse another branch before showing more.
        </output>
      )}
      {shown.map((branch) => {
        const key = graphBranchKey(branch.root, branch.relationshipKey);
        const requestedVisible = Math.min(
          branch.items.length,
          collapsed.has(key) ? 0 : (counts.get(key) ?? 12),
        );
        const visibleItems = branch.items
          .slice(0, requestedVisible)
          .filter(
            (ref) =>
              !neighborhoodKeys || neighborhoodKeys.has(graphRefKey(ref)),
          );
        const visible = visibleItems.length;
        const refs = new Set(visibleItems.map(graphRefKey));
        const nodes = data.nodes.filter(
          (node) =>
            refs.has(graphRefKey(node)) &&
            (!query ||
              `${node.label} ${node.entityId}`
                .toLocaleLowerCase()
                .includes(query)),
        );
        const remaining = Math.max(0, branch.totalCount - visible);
        return (
          <section key={key} className="border-b border-border pb-3">
            <Row wrap gap="sm" align="center">
              <h3 className="text-sm font-semibold">{branch.label}</h3>
              <span className="text-xs text-muted-foreground tabular-nums">
                {visible} visible · {branch.totalCount} total · {remaining}{" "}
                remaining
              </span>
              {remaining > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    busy.has(key) ||
                    (neighborhoodKeys != null &&
                      neighborhoodKeys.size >= GRAPH_NEIGHBOR_LIMIT) ||
                    (capacity &&
                      branch.items.length <
                        Math.min(branch.totalCount, visible + 12))
                  }
                  onClick={() => void onMore(branch)}
                >
                  {busy.has(key)
                    ? "Loading…"
                    : visible === 0
                      ? `Show ${Math.min(12, remaining)}`
                      : `Show ${Math.min(12, remaining)} more`}
                </Button>
              )}
              {visible > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onCollapse(branch)}
                >
                  Collapse
                </Button>
              )}
            </Row>
            {errors.has(key) && (
              <ErrorDisplay
                error={errors.get(key)}
                title="more records"
                onRetry={() => void onMore(branch)}
              />
            )}
            {current.view !== "graph" && (
              <ul className="mt-1 divide-y divide-border">
                {nodes.map((node) => (
                  <li key={graphRefKey(node)} className="py-2">
                    <Row gap="sm" align="center">
                      <EntityIcon
                        entity={node.entityType}
                        colored
                        className="size-3.5"
                      />
                      <GraphRecordLink
                        node={node}
                        href={hrefFor(node, router)}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Explore ${node.label}`}
                        onClick={() => onSelect(graphRefKey(node))}
                      >
                        Explore
                      </Button>
                    </Row>
                  </li>
                ))}
              </ul>
            )}
            {branch.totalCount === 0 && (
              <p className="text-sm text-muted-foreground">
                No linked records.
              </p>
            )}
            {!neighborhoodKeys &&
              nodes.length === 0 &&
              branch.totalCount > 0 && (
                <p className="text-sm text-muted-foreground">
                  No matching explored records.
                </p>
              )}
          </section>
        );
      })}
      {shown.length === 0 && (current.entityType || current.relationship) && (
        <p className="text-sm text-muted-foreground">
          No relationships match the current filters.
        </p>
      )}
      {branches.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Loading this record’s connections…
        </p>
      )}
    </Stack>
  );
}

function hrefFor(node: EntityRef, router: ReturnType<typeof useRouter>) {
  if (!isBrowserRoutedEntity(node.entityType)) return undefined;
  return node.entityType === "usda-food"
    ? router.buildLocation({ to: "/usda/$id", params: { id: node.entityId } })
        .href
    : router.buildLocation({
        to: entities[node.entityType].routes.detail,
        params: entityDetailParams(node.entityId),
      }).href;
}
function GraphRecordLink({
  node,
  href,
}: {
  node: EntityGraphNode;
  href?: string;
}) {
  const classes =
    "min-w-0 flex-1 truncate text-sm text-primary hover:underline";
  return href ? (
    <a href={href} title={node.label} className={classes}>
      {node.label}
    </a>
  ) : (
    <span title={node.label} className={classes}>
      {node.label}
    </span>
  );
}
function graphFacts(node: EntityGraphNode): string[] {
  const { quantity, unit, ...facts } = node.metadata;
  const values = Object.entries(facts).map(([key, value]) =>
    key === "amount" &&
    node.entityType === "expense" &&
    Number.isFinite(Number(value))
      ? formatCurrency(Number(value))
      : key === "statedTotal" && Number.isFinite(Number(value))
        ? `Order stated total ${formatCurrency(Number(value))}`
        : value,
  );
  return quantity
    ? [`${quantity}${unit ? ` ${unit}` : ""}`, ...values]
    : values;
}
function graphSourceLabel(edge: EntityGraphEdge) {
  const relationship = entityManifest[
    edge.source.entityType
  ].relationships.find((candidate) => candidate.key === edge.relationshipKey);
  return (
    relationship?.sources.find((source) => source.key === edge.sourceKey)
      ?.label ??
    relationship?.label ??
    edge.label
  );
}
function EdgeInspector({
  edge,
  onClose,
}: {
  edge: EntityGraphEdge;
  onClose: () => void;
}) {
  return (
    <aside
      className="rounded-md border border-border p-3"
      aria-label="Connection details"
    >
      <Row gap="sm">
        <h3 className="text-sm font-semibold">{edge.label}</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </Row>
      <p className="text-sm">
        {edge.source.entityId} → {edge.target.entityId}
      </p>
      <p className="text-xs text-muted-foreground">
        Evidence: {graphSourceLabel(edge)}
        {edge.provenance.length ? ` · ${edge.provenance.join(" · ")}` : ""}
      </p>
    </aside>
  );
}
function ExplorationCompletion({
  data,
}: {
  data: EntityGraphExploreOutput | undefined;
}) {
  if (!data) return null;
  const { status, requestedDepth, reachedDepth } = data.completion;
  const routeCount = data.paths.length;
  const suffix =
    routeCount > 0
      ? ` ${routeCount} explanatory route${routeCount === 1 ? "" : "s"} retained.`
      : "";
  if (status === "exhausted") {
    return (
      <p className="text-xs text-muted-foreground">
        Explored every reachable relationship within {reachedDepth} hop
        {reachedDepth === 1 ? "" : "s"}.{suffix}
      </p>
    );
  }
  const reason =
    status === "depth-limit"
      ? `Stopped at the requested ${requestedDepth}-hop depth.`
      : status === "pagination-limit"
        ? "Some relationship branches have more records; use their Show more controls to inspect them."
        : "Exploration capacity was reached before every route could be checked.";
  return (
    <p className="text-xs text-muted-foreground">
      {reason}
      {suffix}
    </p>
  );
}

function GraphPathPanel({
  paths,
  destination,
  pathIndex,
  setPathIndex,
  change,
}: Pick<
  ReturnType<typeof useEntityRelationsModel>,
  "paths" | "destination" | "pathIndex" | "setPathIndex" | "change"
>) {
  return (
    <section
      className="rounded-md border border-border p-3"
      aria-label="Find a path"
    >
      <Stack gap="sm">
        <EntityGraphPicker
          label="Destination"
          placeholder="Find a destination record…"
          onSelect={(value) => {
            setPathIndex(0);
            change({
              destination: graphRefKey({
                entityType: value.entity,
                entityId: value.id,
              }),
              view: "graph",
              layout: "flow",
            });
          }}
        />
        <p className="text-xs text-muted-foreground">
          Path search checks both directions across all records. The filters
          above only affect explored records.
        </p>
        {paths.isFetching && <output>Searching for paths…</output>}
        {paths.isError && (
          <ErrorDisplay
            error={paths.error}
            title="paths"
            onRetry={() => void paths.refetch()}
          />
        )}
        {destination && paths.data?.paths.length === 0 && (
          <p>
            {paths.data.completion === "exhausted"
              ? "No connection exists."
              : paths.data.completion === "depth-limit"
                ? "No connection was found within eight hops."
                : "Search capacity was reached before a connection could be confirmed."}
          </p>
        )}
        {destination &&
          paths.data &&
          !paths.data.shortestPathCertain &&
          paths.data.paths.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Search capacity was reached; these candidate paths may not be the
              shortest.
            </p>
          )}
        {destination && paths.data && paths.data.paths.length > 0 && (
          <Row wrap gap="sm">
            {paths.data.paths.slice(0, 3).map((item, index) => (
              <Button
                key={item.nodeRefs.map(graphRefKey).join("→")}
                size="sm"
                variant={index === pathIndex ? "default" : "outline"}
                onClick={() => setPathIndex(index)}
              >
                Path {index + 1} · {item.edgeIds.length} hops
              </Button>
            ))}
          </Row>
        )}
        {destination && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => change({ destination: undefined })}
          >
            Return to explored records
          </Button>
        )}
      </Stack>
    </section>
  );
}

function exploredProjection(
  data: EntityGraphOutput,
  current: EntityRelationsState,
  branches: EntityGraphBranch[],
  visibleCounts: ReadonlyMap<string, number>,
  collapsed: ReadonlySet<string>,
) {
  const text = current.query?.trim().toLocaleLowerCase() ?? "";
  const filteredBranches = branches.filter(
    (branch) =>
      (!current.entityType || branch.target === current.entityType) &&
      (!current.relationship ||
        branch.relationshipKey === current.relationship),
  );
  const effectiveCounts = new Map(visibleCounts);
  for (const branch of filteredBranches) {
    const key = graphBranchKey(branch.root, branch.relationshipKey);
    effectiveCounts.set(
      key,
      collapsed.has(key) ? 0 : (visibleCounts.get(key) ?? 12),
    );
  }
  const matchingRefs = new Set(
    data.nodes
      .filter((node) =>
        `${node.label} ${node.entityId}`.toLocaleLowerCase().includes(text),
      )
      .map(graphRefKey),
  );
  const neighborhood = visibleNeighborhoodKeys(
    filteredBranches.map((branch) => ({
      ...branch,
      items: branch.items
        .slice(
          0,
          effectiveCounts.get(
            graphBranchKey(branch.root, branch.relationshipKey),
          ),
        )
        .filter((ref) => matchingRefs.has(graphRefKey(ref))),
    })),
    effectiveCounts,
  );
  return { text, neighborhood };
}

function VisitedRecords({
  model,
}: {
  model: ReturnType<typeof useEntityRelationsModel>;
}) {
  const {
    selected,
    cursor,
    trail,
    moveHistory,
    router,
    rootKey,
    selectedKey,
    change,
    ensureNeighborhood,
    root,
    busy,
    reload,
  } = model;
  return (
    <>
      {selected && (
        <section
          className="border-y border-border py-3"
          aria-label="Exploration history"
        >
          <Row wrap gap="sm" align="center">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Previous visited record"
              disabled={cursor === 0}
              onClick={() => moveHistory(-1)}
            >
              <ArrowLeft className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Next visited record"
              disabled={cursor >= trail.length - 1}
              onClick={() => moveHistory(1)}
            >
              <ArrowRight className="size-3.5" />
            </Button>
            <EntityIcon
              entity={selected.entityType}
              colored
              className="size-4"
            />
            <GraphRecordLink node={selected} href={hrefFor(selected, router)} />
            <span className="text-xs text-muted-foreground">
              {entityLabel(selected.entityType)} · visit {cursor + 1} of{" "}
              {trail.length}
            </span>
            {selectedKey !== rootKey && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  change({
                    selected: rootKey,
                    ...(trail.includes(rootKey)
                      ? { cursor: trail.indexOf(rootKey) }
                      : visitGraphRecord({ trail, cursor }, rootKey)),
                  });
                  void ensureNeighborhood(root);
                }}
              >
                Back to start
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy.has(selectedKey)}
              onClick={() => void reload()}
            >
              <RotateCw className="size-3.5" /> Reload neighborhood
            </Button>
          </Row>
          <nav
            aria-label="Visited records"
            className="mt-2 flex flex-wrap gap-1"
          >
            {trail.map((key, index) => (
              <Button
                // oxlint-disable-next-line react/no-array-index-key -- Repeated visits to the same record are distinct ordered history entries.
                key={`${index}:${key}`}
                size="sm"
                variant="ghost"
                aria-current={index === cursor ? "step" : undefined}
                onClick={() => change({ selected: key, cursor: index })}
              >
                {model.data.nodes.find((node) => graphRefKey(node) === key)
                  ?.label ?? key}
              </Button>
            ))}
          </nav>
          <p className="text-xs text-muted-foreground">
            Visit order does not imply a connecting relationship.
          </p>
          {graphFacts(selected).length > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              {graphFacts(selected).join(" · ")}
            </p>
          )}
        </section>
      )}
    </>
  );
}
