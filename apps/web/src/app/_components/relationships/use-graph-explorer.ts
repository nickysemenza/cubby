import type { EntityRef } from "@cubby/schemas/entity";
import type {
  EntityGraphBranch,
  EntityGraphOutput,
} from "@cubby/schemas/entity-graph";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { entityGraph } from "~/entities/entity-graph.functions";
import { useHydratedLoading } from "~/hooks/useHydrated";

import {
  graphBranchKey,
  graphRefKey,
  GRAPH_NODE_LIMIT,
  GRAPH_EDGE_LIMIT,
  GRAPH_BRANCH_PAGE_SIZE,
  mergeGraphPages,
  moveGraphVisit,
  visitGraphRecord,
} from "./entity-graph-state";
import {
  graphBranchCount,
  parseGraphRecord,
  projectGraphMap,
} from "./graph-map-state";

export type GraphExplorerOperations = Pick<
  typeof entityGraph,
  "explore" | "graph"
> &
  Partial<Pick<typeof entityGraph, "graphPaths" | "connections">>;

interface ExplorerSession {
  cached?: EntityGraphOutput;
  counts: Map<string, number>;
  expanded: Set<string>;
  history: { trail: string[]; cursor: number };
  selected: string;
}

export function useGraphExplorer(
  root: EntityRef,
  operations: GraphExplorerOperations,
  initialSelected?: string,
) {
  const queryClient = useQueryClient();
  const initial = useQuery(operations.explore.queryOptions({ root, depth: 1 }));
  const loading = useHydratedLoading(initial.isPending);
  const rootKey = graphRefKey(root);
  const [restored] = useState(() =>
    queryClient.getQueryData<ExplorerSession>(["graph-workspace", rootKey]),
  );
  const [cached, setCached] = useState(restored?.cached);
  const initialData = useRef(initial.data);
  initialData.current = initial.data;
  const [counts, setCounts] = useState(
    restored?.counts ?? new Map<string, number>(),
  );
  const [pathEdges, setPathEdges] = useState(new Set<string>());
  const applyPath = useCallback((page?: EntityGraphOutput) => {
    if (page)
      setCached((old) =>
        mergeGraphPages([
          ...(initialData.current ? [initialData.current] : []),
          ...(old ? [old] : []),
          page,
        ]),
      );
    setPathEdges(new Set(page?.edges.map((edge) => edge.id)));
  }, []);
  const [expanded, setExpanded] = useState(
    restored?.expanded ?? new Set<string>(),
  );
  const [history, setHistory] = useState(
    restored?.history ?? { trail: [initialSelected ?? rootKey], cursor: 0 },
  );
  const [selected, setSelected] = useState(
    initialSelected ?? restored?.selected ?? rootKey,
  );
  const [busy, setBusy] = useState(new Set<string>());
  const [errors, setErrors] = useState(new Map<string, unknown>());
  const pending = useRef(new Set<string>());
  const generation = useRef(0);
  useEffect(() => {
    const snapshot: ExplorerSession = {
      cached,
      counts,
      expanded,
      history,
      selected,
    };
    queryClient.setQueryData(["graph-workspace", rootKey], snapshot);
    return () => {
      queryClient.setQueryData(["graph-workspace", rootKey], snapshot);
    };
  }, [queryClient, rootKey, cached, counts, expanded, history, selected]);
  const data = useMemo(
    () =>
      mergeGraphPages([
        ...(initial.data ? [initial.data] : []),
        ...(cached ? [cached] : []),
      ]),
    [initial.data, cached],
  );
  const map = useMemo(
    () => projectGraphMap(data, root, counts, pathEdges),
    [data, root, counts, pathEdges],
  );
  const atCapacity =
    data.nodes.length >= GRAPH_NODE_LIMIT ||
    data.edges.length >= GRAPH_EDGE_LIMIT;
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  const select = (key: string) => {
    if (!parseGraphRecord(key)) return;
    setSelected(key);
    setHistory((old) =>
      old.trail[old.cursor] === key ? old : visitGraphRecord(old, key),
    );
  };
  const back = (offset: -1 | 1) => {
    const next = moveGraphVisit(history, offset);
    setHistory(next);
    setSelected(next.trail[next.cursor] ?? rootKey);
  };
  const request = async (
    key: string,
    read: () => Promise<EntityGraphOutput>,
  ) => {
    if (pending.current.has(key)) return undefined;
    pending.current.add(key);
    const version = generation.current;
    setBusy((old) => new Set(old).add(key));
    setErrors((old) => {
      const next = new Map(old);
      next.delete(key);
      return next;
    });
    try {
      const result = await read();
      if (version !== generation.current) return undefined;
      setCached((old) =>
        mergeGraphPages([
          ...(initialData.current ? [initialData.current] : []),
          ...(old ? [old] : []),
          result,
        ]),
      );
      return result;
    } catch (error) {
      if (version === generation.current)
        setErrors((old) => new Map(old).set(key, error));
      return undefined;
    } finally {
      if (version === generation.current) {
        pending.current.delete(key);
        setBusy((old) => {
          const next = new Set(old);
          next.delete(key);
          return next;
        });
      }
    }
  };
  const expand = async (ref: EntityRef) => {
    const version = generation.current;
    const key = graphRefKey(ref);
    if (expanded.has(key) || key === rootKey) return;
    if (atCapacity) return;
    const page = await request(key, () =>
      queryClient.fetchQuery(
        operations.explore.queryOptions({ root: ref, depth: 1 }),
      ),
    );
    if (page && version === generation.current)
      setExpanded((old) => new Set(old).add(key));
  };
  const more = async (branch: EntityGraphBranch) => {
    const version = generation.current;
    const key = graphBranchKey(branch.root, branch.relationshipKey);
    const count = graphBranchCount(branch, counts);
    const desired = Math.min(branch.totalCount, count + GRAPH_BRANCH_PAGE_SIZE);
    if (branch.items.length >= desired || branch.nextOffset === null) {
      setCounts((old) => new Map(old).set(key, desired));
      return;
    }
    if (atCapacity) return;
    const page = await request(key, () =>
      queryClient.fetchQuery(
        operations.graph.queryOptions({
          roots: [branch.root],
          relationshipKeys: [branch.relationshipKey],
          offset: branch.nextOffset ?? 0,
          limit: GRAPH_BRANCH_PAGE_SIZE,
        }),
      ),
    );
    if (page && version === generation.current)
      setCounts((old) => new Map(old).set(key, desired));
  };
  const collapse = (branch: EntityGraphBranch) => {
    const next = new Map(counts).set(
      graphBranchKey(branch.root, branch.relationshipKey),
      0,
    );
    const projection = projectGraphMap(data, root, next, pathEdges);
    if (!projection.nodes.some((node) => graphRefKey(node) === selected))
      setSelected(graphRefKey(branch.root));
    setCounts(next);
  };
  const restart = () => {
    generation.current++;
    pending.current.clear();
    setCached(undefined);
    setCounts(new Map());
    setPathEdges(new Set());
    setExpanded(new Set());
    setHistory({ trail: [rootKey], cursor: 0 });
    setSelected(rootKey);
    setBusy(new Set());
    setErrors(new Map());
  };
  const clearPath = () => {
    setPathEdges(new Set());
    if (
      !projectGraphMap(data, root, counts).nodes.some(
        (node) => graphRefKey(node) === selected,
      )
    )
      select(rootKey);
  };
  return {
    clearPath,
    restart,
    applyPath,
    initial,
    loading,
    data,
    map,
    counts,
    selected,
    select,
    history,
    back,
    expanded,
    busy,
    errors,
    atCapacity,
    expand,
    more,
    collapse,
  };
}
