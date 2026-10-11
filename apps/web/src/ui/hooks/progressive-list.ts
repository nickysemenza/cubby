import { listReadRowSchema, type ListReadRow } from "~/entity/list-read-fields";
import { StartOperationError } from "~/integrations/tanstack-query/start-transport";
import type { PublicStartOperationError } from "~/server/start-operation.contract";

export type ListReadGroup = "media" | "quality" | "relations" | "derived";
export interface DeferredListGroup {
  id: ListReadGroup;
  fields: string[];
}
export type ListGroupState =
  | { state: "pending" | "loading" | "ready" | "missing" }
  | { state: "error"; error: string; cause?: unknown };
export interface ListEnrichmentFailure {
  pageIndex: number;
  group: ListReadGroup;
  state: Extract<ListGroupState, { state: "error" }>;
}
export interface ListEnrichmentResponse {
  groups: (
    | { id: ListReadGroup; state: "ready"; data: ListReadRow[] }
    | { id: ListReadGroup; state: "error"; error: PublicStartOperationError }
  )[];
  missingIds: string[];
}
export type LoadListEnrichment = (
  ids: string[],
  groups: ListReadGroup[],
  signal: AbortSignal,
) => Promise<ListEnrichmentResponse>;

/** One mounted generation; completed groups survive added pages/columns. */
export class ProgressiveListSession<T extends { id: string } = { id: string }> {
  private controller = new AbortController();
  private generation = "";
  private pages: readonly (readonly T[])[] = [];
  private patches = new Map<string, ListReadRow>();
  private states = new Map<string, ListGroupState>();
  private retained = new Set<string>();
  constructor(private readonly publish: () => void) {}

  reset(generation: string) {
    this.controller.abort();
    this.controller = new AbortController();
    this.generation = generation;
    this.patches.clear();
    this.states.clear();
    this.retained.clear();
  }
  /** Same-scope refreshes retain completed values, never in-flight reads. */
  retain(previous: ProgressiveListSession<T>) {
    this.patches = new Map(previous.patches);
    this.retained = new Set(previous.retained);
    for (const [key, state] of previous.states)
      if (state.state === "ready") this.retained.add(key);
  }
  get signal() {
    return this.controller.signal;
  }
  /**
   * Cancels in-flight reads but keeps the session reusable: StrictMode replays
   * effects on the same session without a reset. An aborted `load` returns
   * without touching state, so in-flight rows go back to `pending` here, or
   * the replayed load would skip them as already in flight.
   */
  dispose() {
    this.controller.abort();
    this.controller = new AbortController();
    for (const [key, state] of this.states)
      if (state.state === "loading") this.states.set(key, { state: "pending" });
  }
  setPages(pages: readonly (readonly T[])[]) {
    this.pages = pages;
  }
  state(id: string, group: ListReadGroup): ListGroupState {
    const key = `${id}:${group}`;
    const state = this.states.get(key) ?? { state: "pending" as const };
    return this.retained.has(key) &&
      (state.state === "pending" || state.state === "loading")
      ? { state: "ready" }
      : state;
  }
  rows(): T[] {
    const seen = new Set<string>();
    return this.pages.flatMap((page) =>
      page.flatMap((row) => {
        if (seen.has(row.id)) return [];
        seen.add(row.id);
        return [{ ...row, ...this.patches.get(row.id) }];
      }),
    );
  }
  async load(
    rows: readonly T[],
    requested: readonly ListReadGroup[],
    loader: LoadListEnrichment,
  ) {
    const groups = requested.filter((group) =>
      rows.some((row) => {
        const state = this.states.get(`${row.id}:${group}`);
        return !state || state.state === "pending";
      }),
    );
    if (rows.length === 0 || groups.length === 0) return;
    const generation = this.generation;
    const signal = this.controller.signal;
    const ids = rows.map((row) => row.id);
    for (const id of ids)
      for (const group of groups)
        this.states.set(`${id}:${group}`, { state: "loading" });
    this.publish();
    try {
      const response = await loader(ids, groups, signal);
      if (signal.aborted || generation !== this.generation) return;
      this.applyResponse(ids, groups, response);
    } catch (error) {
      if (signal.aborted || generation !== this.generation) return;
      for (const id of ids)
        for (const group of groups)
          this.states.set(`${id}:${group}`, {
            state: "error",
            error: error instanceof Error ? error.message : String(error),
            cause: error,
          });
    }
    this.publish();
  }
  async retry(
    rows: readonly T[],
    groups: readonly ListReadGroup[],
    loader: LoadListEnrichment,
  ) {
    await Promise.all(
      groups.map((group) => {
        const failed = rows.filter(
          (row) => this.state(row.id, group).state === "error",
        );
        for (const row of failed)
          this.states.set(`${row.id}:${group}`, { state: "pending" });
        return this.load(failed, [group], loader);
      }),
    );
  }
  private applyResponse(
    ids: string[],
    groups: ListReadGroup[],
    response: ListEnrichmentResponse,
  ) {
    const missing = new Set(response.missingIds);
    const allowed = new Set(ids.filter((id) => !missing.has(id)));
    for (const group of groups) {
      const result = response.groups.find((entry) => entry.id === group);
      for (const id of ids) this.retained.delete(`${id}:${group}`);
      for (const id of ids)
        this.states.set(
          `${id}:${group}`,
          missing.has(id)
            ? { state: "missing" }
            : result?.state === "ready"
              ? { state: "ready" }
              : {
                  state: "error",
                  cause:
                    result?.state === "error"
                      ? new StartOperationError(result.error)
                      : undefined,
                  error:
                    result?.state === "error"
                      ? result.error.message
                      : `No ${group} enrichment returned`,
                },
        );
      if (result?.state !== "ready") continue;
      for (const patch of result.data) {
        const identity = listReadRowSchema.safeParse(patch);
        if (!identity.success || !allowed.has(identity.data.id)) continue;
        this.patches.set(identity.data.id, {
          ...this.patches.get(identity.data.id),
          ...identity.data,
        });
      }
    }
  }
}
