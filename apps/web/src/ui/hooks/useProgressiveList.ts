import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  ProgressiveListSession,
  type ListGroupState,
  type ListEnrichmentFailure,
  type ListReadGroup,
} from "./progressive-list";
import type { ListQueryPlan, ListQueryResponse } from "./usePaginatedTableCore";

const PENDING_STATE: ListGroupState = { state: "pending" };

export function useProgressiveList<T extends { id: string }>({
  pages,
  scope,
  queryKey,
  plan,
  paused,
  refreshing,
  visibleFields,
}: {
  pages: ListQueryResponse<T>[] | undefined;
  scope: string;
  queryKey: QueryKey;
  plan: ListQueryPlan<T>;
  paused: boolean;
  refreshing: boolean;
  visibleFields?: readonly string[];
}) {
  const [renderVersion, publish] = useReducer((value: number) => value + 1, 0);
  const queryClient = useQueryClient();
  const [readGeneration, retire] = useReducer((value: number) => value + 1, 0);
  const firstPage = pages?.[0];
  const previousSession = useRef<{
    scope: string;
    session: ProgressiveListSession<T>;
  } | null>(null);
  // Structural sharing can preserve the first page after a mutation. Cache
  // invalidation retires the read synchronously, even if fetching is batched.
  const session = useMemo(() => {
    const next = new ProgressiveListSession<T>(publish);
    next.reset(
      `${scope}:${firstPage?.meta.pageIndex}:${refreshing}:${readGeneration}`,
    );
    if (previousSession.current?.scope === scope)
      next.retain(previousSession.current.session);
    previousSession.current = { scope, session: next };
    return next;
  }, [firstPage, scope, refreshing, readGeneration]);
  const activeSession = useRef(session);
  activeSession.current = session;
  useEffect(() => {
    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.query !== query) return;
      const isRefresh =
        event.action.type === "fetch" &&
        event.query.state.data !== undefined &&
        !event.action.meta?.fetchMore;
      const isManualUpdate =
        event.action.type === "success" && event.action.manual;
      if (event.action.type === "invalidate" || isRefresh || isManualUpdate) {
        activeSession.current.dispose();
        retire();
      }
    });
  }, [queryClient, queryKey]);
  session.setPages(pages?.map((page) => page.items) ?? []);
  const [summaryAttempt, retrySummary] = useReducer(
    (value: number) => value + 1,
    0,
  );
  const [summary, setSummary] = useState<{
    scope: string;
    session: ProgressiveListSession<T>;
    state: ListGroupState;
    sums?: Record<string, number>;
  }>();
  const progressive = plan.progressive;
  const planRef = useRef(plan);
  planRef.current = plan;
  const enabled = Boolean(progressive);
  useEffect(() => () => session.dispose(), [session]);
  const visibleKey = JSON.stringify(visibleFields);
  const visibleRef = useRef(visibleFields);
  visibleRef.current = visibleFields;
  useEffect(() => {
    const activePlan = planRef.current.progressive;
    const fields = visibleRef.current;
    if (!activePlan || paused || refreshing || !pages) return;
    for (const page of pages) {
      const groups =
        page.deferredGroups
          ?.filter(
            (group) =>
              fields === undefined ||
              group.fields.some((field) => fields.includes(field)),
          )
          .map((group) => group.id) ?? [];
      // A page may legally contain more ids than the wire enrichment cap.
      for (let offset = 0; offset < page.items.length; offset += 500) {
        void session.load(
          page.items.slice(offset, offset + 500),
          groups,
          activePlan.enrich,
        );
      }
    }
  }, [pages, paused, enabled, refreshing, session, visibleKey]);
  useEffect(() => {
    const activePlan = planRef.current.progressive;
    if (!activePlan || paused || refreshing || !firstPage) return;
    // `dispose` swaps the session's controller, so hold this run's signal.
    const signal = session.signal;
    setSummary((previous) =>
      previous?.scope === scope && previous.state.state === "ready"
        ? { ...previous, session }
        : { scope, session, state: { state: "loading" } },
    );
    void activePlan
      .summary(signal)
      .then((sums) => {
        if (!signal.aborted)
          setSummary({ scope, session, state: { state: "ready" }, sums });
      })
      .catch((error) => {
        if (!signal.aborted)
          setSummary({
            scope,
            session,
            state: {
              state: "error",
              error: error instanceof Error ? error.message : String(error),
              cause: error,
            },
          });
      });
  }, [firstPage, scope, paused, enabled, refreshing, session, summaryAttempt]);
  const stateRef = useRef({ session, pages, enabled });
  stateRef.current = { session, pages, enabled };
  const enrichmentState = useCallback(
    (id: string, field: string): ListGroupState | undefined => {
      const current = stateRef.current;
      if (!current.enabled) return undefined;
      const group = current.pages
        ?.flatMap((page) => page.deferredGroups ?? [])
        .find((entry) => entry.fields.includes(field));
      return group ? current.session.state(id, group.id) : undefined;
    },
    [],
  );
  const enrichmentFailures: ListEnrichmentFailure[] = [];
  for (const [pageIndex, page] of (pages ?? []).entries()) {
    for (const group of page.deferredGroups ?? []) {
      const state = page.items
        .map((row) => session.state(row.id, group.id))
        .find((state) => state.state === "error");
      if (state?.state === "error")
        enrichmentFailures.push({ pageIndex, group: group.id, state });
    }
  }
  const retryEnrichment = useCallback(
    async (pageIndex: number, group: ListReadGroup) => {
      const page = pages?.[pageIndex];
      const activePlan = planRef.current.progressive;
      if (
        !page ||
        !activePlan ||
        paused ||
        refreshing ||
        session.signal.aborted
      )
        return;
      for (let offset = 0; offset < page.items.length; offset += 500) {
        await session.retry(
          page.items.slice(offset, offset + 500),
          [group],
          activePlan.enrich,
        );
      }
    },
    [pages, paused, refreshing, session],
  );
  return {
    enrichmentFailures,
    retryEnrichment,
    retrySummary,
    renderVersion,
    deferredFields:
      firstPage?.deferredGroups?.flatMap((group) => group.fields) ?? [],
    data: session.rows(),
    sums: summary?.scope === scope && !paused ? summary.sums : undefined,
    summaryState:
      summary?.scope === scope && !paused ? summary.state : PENDING_STATE,
    enrichmentState,
  };
}
