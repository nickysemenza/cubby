import { describe, expect, it } from "vitest";

import { getAppErrorDetails } from "~/lib/error-utils";

import { ProgressiveListSession } from "./progressive-list";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const rows = [
  { id: "first", name: "First" },
  { id: "second", name: "Second" },
];

// A late response must not patch another query or refreshed page. A failed
// enrichment must not hide base rows or invent healthy/zero values. New pages
// and newly visible groups must reuse completed groups rather than reread them.
describe("progressive list lifecycle", () => {
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
    const response = deferred<{
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
    const response = deferred<{
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
