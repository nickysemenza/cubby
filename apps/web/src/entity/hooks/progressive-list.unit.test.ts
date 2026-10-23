import { describe, expect, it } from "vitest";

import { getAppErrorDetails } from "~/lib/error-utils";

import {
  ProgressiveListSession,
  type ListEnrichmentResponse,
  type LoadListEnrichment,
} from "./progressive-list";

const rows = [
  { id: "first", name: "First" },
  { id: "second", name: "Second" },
];
const derived = (fields: string[]) => [{ id: "derived" as const, fields }];
const media = [{ id: "media" as const, fields: ["images"] }];
const quality = [{ id: "quality" as const, fields: ["dataQuality"] }];
const error = {
  code: "INTERNAL_SERVER_ERROR",
  message: "Synthetic lookup failure",
  requestId: "synthetic-request",
  diagnostics: {
    origin: "server" as const,
    operation: "entity.listEnrichment",
    stage: "run" as const,
    causes: [
      {
        name: "PostgresError",
        message: "SELECT synthetic_column FROM synthetic_table",
        code: "42703",
      },
    ],
  },
};

describe("progressive list lifecycle", () => {
  it("retains unchanged row views while exposing fresh base and enrichment values", async () => {
    const session = new ProgressiveListSession<(typeof rows)[number]>(() => {});
    session.setPages([rows]);
    const initial = session.rows();
    session.setPages([rows]);
    expect(session.rows()).toBe(initial);
    const response = Promise.withResolvers<ListEnrichmentResponse>();
    const loading = session.load(
      [rows[0]!],
      derived(["count"]),
      async () => response.promise,
    );
    expect(session.rows()).toBe(initial);
    response.resolve({
      groups: [
        {
          id: "derived",
          fields: ["count"],
          state: "ready",
          data: [{ id: "first", count: 1 }],
        },
      ],
      missingIds: [],
    });
    await loading;
    const enriched = session.rows();
    expect(enriched[0]).toEqual({ ...rows[0], count: 1 });
    expect(enriched[0]).not.toBe(initial[0]);
    expect(enriched[1]).toBe(initial[1]);
    expect(session.rows()).toBe(enriched);
    session.setPages([[{ ...rows[0]!, name: "Refreshed" }, rows[1]!]]);
    expect(session.rows()[0]).toEqual({
      id: "first",
      name: "Refreshed",
      count: 1,
    });
    expect(session.rows()[1]).toBe(enriched[1]);
    session.reset("fresh-query");
    expect(session.rows()[0]).toEqual({ id: "first", name: "Refreshed" });
  });

  it("keeps base order and isolates group errors while excluding missing ids", async () => {
    const session = new ProgressiveListSession(() => {});
    session.setPages([rows]);
    await session.load(rows, [...media, ...quality], async () => ({
      groups: [
        {
          id: "media",
          fields: ["images"],
          state: "ready",
          data: [{ id: "first", images: ["photo"] }],
        },
        { id: "quality", fields: ["dataQuality"], state: "error", error },
      ],
      missingIds: ["second"],
    }));
    expect(session.rows()).toEqual([
      { ...rows[0], images: ["photo"] },
      rows[1],
    ]);
    expect(session.state("first", "images").state).toBe("ready");
    expect(session.state("second", "images").state).toBe("missing");
    expect(session.state("first", "dataQuality")).toMatchObject({
      state: "error",
      error: error.message,
    });
  });

  it("retries only failed fields once while retaining server diagnostics", async () => {
    const session = new ProgressiveListSession(() => {});
    session.setPages([rows]);
    await session.load(rows, [...media, ...derived(["cost"])], async () => ({
      groups: [
        {
          id: "media",
          fields: ["images"],
          state: "ready",
          data: rows.map((row) => ({ id: row.id, images: [] })),
        },
        { id: "derived", fields: ["cost"], state: "error", error },
      ],
      missingIds: [],
    }));
    const failed = session.state("first", "cost");
    expect(
      getAppErrorDetails("cause" in failed ? failed.cause : undefined),
    ).toMatchObject(error);
    const response = Promise.withResolvers<ListEnrichmentResponse>();
    const calls: string[][] = [];
    const loader: LoadListEnrichment = async (_ids, fields) => {
      calls.push(fields);
      return response.promise;
    };
    const first = session.retry(
      rows,
      [...media, ...derived(["cost", "unrequested"])],
      loader,
    );
    const second = session.retry(rows, derived(["cost"]), loader);
    expect(calls).toEqual([["cost"]]);
    expect(session.state("first", "images").state).toBe("ready");
    response.resolve({
      groups: [
        {
          id: "derived",
          fields: ["cost"],
          state: "ready",
          data: rows.map((row) => ({ id: row.id, cost: 5 })),
        },
      ],
      missingIds: [],
    });
    await Promise.all([first, second]);
    expect(session.rows()[0]).toEqual({ ...rows[0], images: [], cost: 5 });
    expect(session.freshState("first", "unrequested").state).toBe("pending");
  });

  it("aborts and ignores stale enrichment after filter change or refresh", async () => {
    const session = new ProgressiveListSession(() => {});
    const response = Promise.withResolvers<ListEnrichmentResponse>();
    let signal: AbortSignal | undefined;
    session.reset("old");
    session.setPages([rows]);
    const old = session.load(
      rows,
      derived(["cost"]),
      async (_ids, _fields, received) => {
        signal = received;
        return response.promise;
      },
    );
    session.reset("new");
    response.resolve({
      groups: [
        {
          id: "derived",
          fields: ["cost"],
          state: "ready",
          data: [{ id: "first", cost: 999 }],
        },
      ],
      missingIds: [],
    });
    await old;
    expect(signal?.aborted).toBe(true);
    expect(session.rows()).toEqual(rows);
    expect(session.state("first", "cost").state).toBe("pending");
  });

  it("keeps a confirmed reference while revalidating and clears an optional omission", async () => {
    const previous = new ProgressiveListSession<{
      id: string;
      name: string;
      project?: string;
    }>(() => {});
    previous.setPages([
      [{ id: "first", name: "First", project: "Confirmed project" }],
    ]);
    const refreshed = new ProgressiveListSession<{
      id: string;
      name: string;
      project?: string;
    }>(() => {});
    refreshed.retain(previous, ["project"]);
    refreshed.setPages([[rows[0]!]]);
    const groups = [{ id: "relations" as const, fields: ["project"] }];
    const response = Promise.withResolvers<ListEnrichmentResponse>();
    const loading = refreshed.load(
      [rows[0]!],
      groups,
      async () => response.promise,
    );
    expect(refreshed.rows()[0]).toMatchObject({ project: "Confirmed project" });
    expect(refreshed.freshState("first", "project").state).toBe("loading");
    response.resolve({
      groups: [{ id: "relations", fields: ["project"], state: "error", error }],
      missingIds: [],
    });
    await loading;
    expect(refreshed.rows()[0]).toMatchObject({ project: "Confirmed project" });
    expect(refreshed.state("first", "project").state).toBe("error");
    await refreshed.retry([rows[0]!], groups, async () => ({
      groups: [
        {
          id: "relations",
          fields: ["project"],
          state: "ready",
          data: [{ id: "first" }],
        },
      ],
      missingIds: [],
    }));
    expect(refreshed.rows()[0]).toEqual(rows[0]);
    expect(refreshed.state("first", "project").state).toBe("ready");
  });

  it("fetches newly revealed fields in a ready group and reuses hidden completed fields", async () => {
    const session = new ProgressiveListSession(() => {});
    session.setPages([rows]);
    const requests: { ids: string[]; fields: string[] }[] = [];
    const loader: LoadListEnrichment = async (ids, fields) => {
      requests.push({ ids, fields });
      return {
        groups: [
          {
            id: "derived",
            fields,
            state: "ready",
            data: ids.map((id) => ({
              id,
              ...Object.fromEntries(fields.map((field) => [field, 1])),
            })),
          },
        ],
        missingIds: [],
      };
    };
    await session.load(rows, derived(["count"]), loader);
    await session.load(rows, derived(["count", "cost"]), loader);
    await session.load(rows, derived(["count"]), loader);
    await session.load(rows, derived(["count", "cost"]), loader);
    session.setPages([rows, [{ id: "third", name: "Third" }]]);
    await session.load([{ id: "third" }], derived(["count"]), loader);
    expect(requests).toEqual([
      { ids: ["first", "second"], fields: ["count"] },
      { ids: ["first", "second"], fields: ["cost"] },
      { ids: ["third"], fields: ["count"] },
    ]);
    expect(session.rows().map((row) => row.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("claims overlapping requests synchronously without reloading ready or in-flight pairs", async () => {
    const session = new ProgressiveListSession(() => {});
    session.setPages([rows]);
    const gate = Promise.withResolvers<ListEnrichmentResponse>();
    const calls: { ids: string[]; fields: string[] }[] = [];
    const loader: LoadListEnrichment = async (ids, fields) => {
      calls.push({ ids, fields });
      if (calls.length === 1) return gate.promise;
      return {
        groups: [
          {
            id: "derived",
            fields,
            state: "ready",
            data: ids.map((id) => ({ id, count: 1, cost: 2 })),
          },
        ],
        missingIds: [],
      };
    };
    const first = session.load([rows[0]!], derived(["count"]), loader);
    await session.load(rows, derived(["count", "cost"]), loader);
    expect(calls).toEqual([
      { ids: ["first"], fields: ["count"] },
      { ids: ["first"], fields: ["cost"] },
      { ids: ["second"], fields: ["cost", "count"] },
    ]);
    gate.resolve({
      groups: [
        {
          id: "derived",
          fields: ["count"],
          state: "ready",
          data: [{ id: "first", count: 1, unwanted: "ignored" }],
        },
      ],
      missingIds: [],
    });
    await first;
    expect(session.rows()).toEqual(
      rows.map((row) => ({ ...row, count: 1, cost: 2 })),
    );
  });

  it("never marks an omitted successful row ready", async () => {
    const session = new ProgressiveListSession(() => {});
    await session.load(rows, derived(["count"]), async () => ({
      groups: [
        {
          id: "derived",
          fields: ["count"],
          state: "ready",
          data: [{ id: "first", count: 1 }],
        },
      ],
      missingIds: [],
    }));
    expect(session.state("first", "count").state).toBe("ready");
    expect(session.state("second", "count")).toMatchObject({
      state: "error",
      error: "No count enrichment returned for second",
    });
  });

  it("rejects acknowledgements outside the requested field ownership before applying patches", async () => {
    const session = new ProgressiveListSession(() => {});
    session.setPages([rows]);
    await session.load(rows, derived(["count"]), async () => ({
      groups: [
        {
          id: "media",
          fields: ["count"],
          state: "ready",
          data: [{ id: "first", count: 99 }],
        },
      ],
      missingIds: [],
    }));
    expect(session.rows()).toEqual(rows);
    expect(session.state("first", "count").state).toBe("error");
  });

  it("keeps wire batches bounded independently of page size", async () => {
    const session = new ProgressiveListSession(() => {});
    const records = Array.from({ length: 501 }, (_, index) => ({
      id: `row-${index}`,
    }));
    const sizes: number[] = [];
    await session.load(records, derived(["count"]), async (ids, fields) => {
      sizes.push(ids.length);
      return {
        groups: [
          {
            id: "derived",
            fields,
            state: "ready",
            data: ids.map((id) => ({ id, count: 1 })),
          },
        ],
        missingIds: [],
      };
    });
    expect(sizes).toEqual([500, 1]);
  });
});
