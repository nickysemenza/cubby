import { describe, expect, it } from "vitest";

import { getAppErrorDetails } from "~/lib/error-utils";

import { ProgressiveListSession } from "./progressive-list";

const rows = [
  { id: "first", name: "First" },
  { id: "second", name: "Second" },
];

// A late response must not patch another query or refreshed page. A failed
// enrichment must not hide base rows or invent healthy/zero values. New pages
// and newly visible groups must reuse completed groups rather than reread them.
describe("progressive list lifecycle", () => {
  it("retains unchanged row views while exposing fresh base and enrichment values", async () => {
    const session = new ProgressiveListSession<(typeof rows)[number]>(() => {});
    session.setPages([rows]);
    const initial = session.rows();
    session.setPages([rows]);
    expect(session.rows()).toBe(initial);
    const response = Promise.withResolvers<{
      groups: {
        id: "derived";
        state: "ready";
        data: { id: string; count: number }[];
      }[];
      missingIds: string[];
    }>();
    const loading = session.load(
      [rows[0]!],
      ["derived"],
      async () => response.promise,
    );
    expect(session.rows()).toBe(initial);
    response.resolve({
      groups: [
        { id: "derived", state: "ready", data: [{ id: "first", count: 1 }] },
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
    session.reset("initial");
    session.setPages([rows]);
    await session.load(rows, ["media", "quality"], async () => ({
      groups: [
        {
          id: "media",
          state: "ready",
          data: [
            { id: "second", images: [] },
            { id: "first", images: ["photo"] },
            { id: "other", images: ["wrong"] },
          ],
        },
        {
          id: "quality",
          state: "error",
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Synthetic upstream failure",
          },
        },
      ],
      missingIds: ["second"],
    }));
    expect(session.rows()).toEqual([
      { ...rows[0], images: ["photo"] },
      rows[1],
    ]);
    expect(session.state("first", "media").state).toBe("ready");
    expect(session.state("second", "media").state).toBe("missing");
    expect(session.state("first", "quality")).toMatchObject({
      state: "error",
      error: "Synthetic upstream failure",
    });
  });

  // Retrying must preserve successful fields, retain the normalized diagnostic
  // payload, and coalesce repeated clicks while a failed group is in flight.
  it("retries only failed groups once while retaining server diagnostics", async () => {
    const session = new ProgressiveListSession(() => {});
    session.setPages([rows]);
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
    await session.load(rows, ["media", "derived"], async () => ({
      groups: [
        {
          id: "media",
          state: "ready",
          data: rows.map((row) => ({ id: row.id, images: [] })),
        },
        { id: "derived", state: "error", error },
      ],
      missingIds: [],
    }));
    const failed = session.state("first", "derived");
    expect(failed.state).toBe("error");
    expect(
      getAppErrorDetails("cause" in failed ? failed.cause : undefined),
    ).toMatchObject(error);
    const response = Promise.withResolvers<{
      groups: {
        id: "derived";
        state: "ready";
        data: { id: string; cost: number }[];
      }[];
      missingIds: string[];
    }>();
    const calls: string[][] = [];
    const loader = async (
      _ids: string[],
      groups: ("media" | "quality" | "relations" | "derived")[],
    ) => {
      calls.push(groups);
      return response.promise;
    };
    const first = session.retry(rows, ["media", "derived"], loader);
    const second = session.retry(rows, ["derived"], loader);
    expect(calls).toEqual([["derived"]]);
    expect(session.state("first", "media").state).toBe("ready");
    response.resolve({
      groups: [
        { id: "derived", state: "ready", data: [{ id: "first", cost: 5 }] },
      ],
      missingIds: [],
    });
    await Promise.all([first, second]);
    expect(session.rows()[0]).toEqual({ ...rows[0], images: [], cost: 5 });
  });

  it("aborts and ignores stale enrichment after filter change or refresh", async () => {
    const session = new ProgressiveListSession(() => {});
    const response = Promise.withResolvers<{
      groups: {
        id: "derived";
        state: "ready";
        data: { id: string; cost: number }[];
      }[];
      missingIds: string[];
    }>();
    let signal: AbortSignal | undefined;
    session.reset("old");
    session.setPages([rows]);
    const old = session.load(
      rows,
      ["derived"],
      async (_ids, _groups, received) => {
        signal = received;
        return response.promise;
      },
    );
    session.reset("new");
    session.setPages([rows]);
    response.resolve({
      groups: [
        { id: "derived", state: "ready", data: [{ id: "first", cost: 999 }] },
      ],
      missingIds: [],
    });
    await old;
    expect(signal?.aborted).toBe(true);
    expect(session.rows()).toEqual(rows);
    expect(session.state("first", "derived").state).toBe("pending");
  });

  it("keeps a confirmed reference when a later base refresh omits it and enrichment fails", async () => {
    const previous = new ProgressiveListSession<{
      id: string;
      name: string;
      project?: string;
    }>(() => {});
    previous.setPages([[{ id: "first", name: "First" }]]);
    await previous.load(rows.slice(0, 1), ["relations"], async () => ({
      groups: [
        {
          id: "relations",
          state: "ready",
          data: [{ id: "first", project: "Old project" }],
        },
      ],
      missingIds: [],
    }));
    previous.setPages([
      [{ id: "first", name: "First", project: "Confirmed project" }],
    ]);
    const refreshed = new ProgressiveListSession<{
      id: string;
      name: string;
      project?: string;
    }>(() => {});
    refreshed.retain(previous, ["project"]);
    refreshed.setPages([[{ id: "first", name: "First" }]]);
    await refreshed.load(rows.slice(0, 1), ["relations"], async () => ({
      groups: [
        {
          id: "relations",
          state: "error",
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Synthetic relation refresh failed",
          },
        },
      ],
      missingIds: [],
    }));
    expect(refreshed.rows()).toEqual([
      { id: "first", name: "First", project: "Confirmed project" },
    ]);
    expect(refreshed.state("first", "relations").state).toBe("error");
  });

  it("batches missing visible groups once per page and reuses ready groups", async () => {
    const session = new ProgressiveListSession(() => {});
    const requests: string[][] = [];
    const load = async (
      _ids: string[],
      groups: ("media" | "quality" | "relations" | "derived")[],
    ) => {
      requests.push(groups);
      return {
        groups: groups.map((id) => ({ id, state: "ready" as const, data: [] })),
        missingIds: [],
      };
    };
    session.reset("initial");
    session.setPages([rows]);
    await session.load(rows, ["media"], load);
    await session.load(rows, ["media", "quality"], load);
    session.setPages([rows, [{ id: "third", name: "Third" }]]);
    await session.load(rows, ["media", "quality"], load);
    expect(requests).toEqual([["media"], ["quality"]]);
    expect(session.rows().map((row) => row.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
