import type { z } from "zod";

import type {
  entityListEnrichmentOutputSchema,
  entityListGroupSchema,
} from "~/entity/generated/entity-lists.gen";
import {
  listReadRowSchema,
  type ListReadRow,
} from "~/entity/model/list-read-fields";
import { StartOperationError } from "~/integrations/tanstack-query/start-transport";

export type DeferredListGroup = z.output<typeof entityListGroupSchema>;
export type ListReadGroup = DeferredListGroup["id"];
export type ListGroupState =
  | { state: "pending" | "loading" | "ready" | "missing" }
  | { state: "error"; error: string; cause?: unknown };
export interface ListEnrichmentFailure {
  pageIndex: number;
  group: ListReadGroup;
  state: Extract<ListGroupState, { state: "error" }>;
}
type WireEnrichment = z.output<typeof entityListEnrichmentOutputSchema>;
type WireGroup = WireEnrichment["groups"][number];
export type ListEnrichmentResponse = Pick<WireEnrichment, "missingIds"> & {
  groups: (
    | (Omit<Extract<WireGroup, { state: "ready" }>, "data"> & {
        data: ListReadRow[];
      })
    | Extract<WireGroup, { state: "error" }>
  )[];
};
export type LoadListEnrichment = (
  ids: string[],
  fields: string[],
  signal: AbortSignal,
) => Promise<ListEnrichmentResponse>;

/** One mounted generation; completed fields survive added pages/columns. */
export class ProgressiveListSession<T extends { id: string } = { id: string }> {
  private controller = new AbortController();
  private generation = "";
  private pages: readonly (readonly T[])[] = [];
  private patches = new Map<string, ListReadRow>();
  private states = new Map<string, ListGroupState>();
  private retained = new Set<string>();
  private mergedRows: T[] | undefined;
  private rowViews = new Map<
    string,
    { base: T; patch: ListReadRow | undefined; value: T }
  >();
  constructor(private readonly publish: () => void) {}

  reset(generation: string) {
    this.controller.abort();
    this.controller = new AbortController();
    this.generation = generation;
    this.patches.clear();
    this.states.clear();
    this.retained.clear();
    this.rowViews.clear();
    this.mergedRows = undefined;
  }
  /** Same-scope refreshes retain completed values, never in-flight reads. */
  retain(
    previous: ProgressiveListSession<T>,
    deferredFields: readonly string[] = [],
  ) {
    this.patches = new Map(previous.patches);
    this.retained = new Set(previous.retained);
    this.rowViews.clear();
    this.mergedRows = undefined;
    // A confirmed full-record read can publish deferred values into base rows.
    // Carry those forward before a later base response omits deferred keys.
    for (const page of previous.pages) {
      for (const row of page) {
        const canonical = listReadRowSchema.parse(row);
        const patch: ListReadRow = { ...this.patches.get(row.id), id: row.id };
        for (const field of deferredFields) {
          if (field in canonical) {
            patch[field] = canonical[field];
            this.retained.add(`${row.id}:${field}`);
          }
        }
        this.patches.set(row.id, patch);
      }
    }
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
    if (
      pages.length === this.pages.length &&
      pages.every((page, index) => page === this.pages[index])
    )
      return;
    this.pages = pages;
    this.mergedRows = undefined;
  }
  freshState(id: string, field: string): ListGroupState {
    return this.states.get(`${id}:${field}`) ?? { state: "pending" };
  }
  state(id: string, field: string): ListGroupState {
    const key = `${id}:${field}`;
    const state = this.states.get(key) ?? { state: "pending" as const };
    return this.retained.has(key) &&
      (state.state === "pending" || state.state === "loading")
      ? { state: "ready" }
      : state;
  }
  rows(): T[] {
    if (this.mergedRows) return this.mergedRows;
    const seen = new Set<string>();
    const views: typeof this.rowViews = new Map();
    this.mergedRows = this.pages.flatMap((page) =>
      page.flatMap((row) => {
        if (seen.has(row.id)) return [];
        seen.add(row.id);
        // Confirmed core fields must win over retained enrichment from an
        // earlier read. Deferred keys absent from the base still stay visible.
        const patch = this.patches.get(row.id);
        const prior = this.rowViews.get(row.id);
        const value =
          prior?.base === row && prior.patch === patch
            ? prior.value
            : { ...patch, ...row };
        views.set(row.id, { base: row, patch, value });
        return [value];
      }),
    );
    this.rowViews = views;
    return this.mergedRows;
  }
  async load(
    rows: readonly T[],
    requested: readonly DeferredListGroup[],
    loader: LoadListEnrichment,
  ) {
    const owners = new Map<string, ListReadGroup>();
    for (const group of requested)
      for (const field of group.fields) {
        const prior = owners.get(field);
        if (prior && prior !== group.id)
          throw new Error(`Conflicting enrichment owner: ${field}`);
        owners.set(field, group.id);
      }
    const buckets = new Map<string, { fields: string[]; ids: string[] }>();
    for (const row of rows) {
      const fields = [...owners.keys()]
        .filter((field) => this.freshState(row.id, field).state === "pending")
        .sort();
      if (!fields.length) continue;
      const key = JSON.stringify(fields);
      const bucket = buckets.get(key) ?? { fields, ids: [] };
      bucket.ids.push(row.id);
      buckets.set(key, bucket);
      // Claim synchronously, before any request yields to an overlapping load.
      for (const field of fields)
        this.states.set(`${row.id}:${field}`, { state: "loading" });
    }
    if (!buckets.size) return;
    const generation = this.generation;
    const signal = this.controller.signal;
    this.publish();
    await Promise.all(
      [...buckets.values()].flatMap(({ fields, ids }) => {
        const requests: Promise<void>[] = [];
        for (let offset = 0; offset < ids.length; offset += 500) {
          const batch = ids.slice(offset, offset + 500);
          requests.push(
            (async () => {
              try {
                const response = await loader(batch, fields, signal);
                if (signal.aborted || generation !== this.generation) return;
                this.applyResponse(batch, fields, owners, response);
              } catch (error) {
                if (signal.aborted || generation !== this.generation) return;
                for (const id of batch)
                  for (const field of fields)
                    this.states.set(`${id}:${field}`, {
                      state: "error",
                      error:
                        error instanceof Error ? error.message : String(error),
                      cause: error,
                    });
              }
              this.publish();
            })(),
          );
        }
        return requests;
      }),
    );
  }
  async retry(
    rows: readonly T[],
    groups: readonly DeferredListGroup[],
    loader: LoadListEnrichment,
  ) {
    const buckets = new Map<
      string,
      { rows: T[]; groups: DeferredListGroup[] }
    >();
    for (const row of rows) {
      const failed = groups
        .map((group) => ({
          ...group,
          fields: group.fields.filter(
            (field) => this.freshState(row.id, field).state === "error",
          ),
        }))
        .filter((group) => group.fields.length > 0);
      if (!failed.length) continue;
      const key = JSON.stringify(failed);
      const bucket = buckets.get(key) ?? { rows: [], groups: failed };
      bucket.rows.push(row);
      buckets.set(key, bucket);
    }
    await Promise.all(
      [...buckets.values()].map((bucket) => {
        for (const row of bucket.rows)
          for (const field of bucket.groups.flatMap((group) => group.fields))
            this.states.set(`${row.id}:${field}`, { state: "pending" });
        return this.load(bucket.rows, bucket.groups, loader);
      }),
    );
  }
  private applyResponse(
    ids: string[],
    fields: string[],
    owners: ReadonlyMap<string, ListReadGroup>,
    response: ListEnrichmentResponse,
  ) {
    const requested = new Set(fields);
    const allowed = new Set(ids);
    const missing = new Set(response.missingIds);
    for (const id of missing)
      if (!allowed.has(id))
        throw new Error(`Unexpected missing enrichment row: ${id}`);
    const results = new Map<string, ListEnrichmentResponse["groups"][number]>();
    const patches = new Map<ListReadGroup, Map<string, ListReadRow>>();
    // Validate acknowledgements before publishing any part of this response.
    for (const result of response.groups) {
      for (const field of result.fields) {
        if (
          !requested.has(field) ||
          owners.get(field) !== result.id ||
          results.has(field)
        )
          throw new Error(
            `Unexpected enrichment acknowledgement: ${result.id}.${field}`,
          );
        results.set(field, result);
      }
      if (result.state !== "ready") continue;
      if (patches.has(result.id))
        throw new Error(`Duplicate enrichment group: ${result.id}`);
      const rows = new Map<string, ListReadRow>();
      for (const patch of result.data) {
        const row = listReadRowSchema.parse(patch);
        if (!allowed.has(row.id) || missing.has(row.id) || rows.has(row.id))
          throw new Error(`Unexpected enrichment row: ${row.id}`);
        rows.set(row.id, row);
      }
      patches.set(result.id, rows);
    }
    for (const id of ids) {
      const prior = this.patches.get(id);
      const patch: ListReadRow = { ...prior, id };
      let changed = false;
      for (const field of fields) {
        const key = `${id}:${field}`;
        const result = results.get(field);
        const row =
          result?.state === "ready"
            ? patches.get(result.id)?.get(id)
            : undefined;
        this.retained.delete(key);
        this.states.set(
          key,
          missing.has(id)
            ? { state: "missing" }
            : row
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
                      : `No ${field} enrichment returned for ${id}`,
                },
        );
        if (!row) continue;
        if (Object.hasOwn(row, field)) {
          if (
            !Object.hasOwn(patch, field) ||
            !Object.is(patch[field], row[field])
          )
            changed = true;
          patch[field] = row[field];
        } else if (Object.hasOwn(patch, field)) {
          // A successful optional omission supersedes retained display data.
          delete patch[field];
          changed = true;
        }
      }
      if (changed) {
        this.patches.set(id, patch);
        this.mergedRows = undefined;
      }
    }
  }
}
