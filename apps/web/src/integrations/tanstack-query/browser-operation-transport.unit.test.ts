import superjson from "superjson";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import type { StartOperationId } from "~/lib/start-operation-observability";

import { dispatchBrowserOperation } from "./browser-operation-transport";

type Sent = { operation?: string; batch?: { operation: string }[] };

// Failures this guards: a page's concurrent reads each opening their own
// Worker request (each a possible cold isolate + Hyperdrive connect), a
// mutation riding a batch, or one batch result landing on the wrong caller.
const ndjson = (lines: unknown[]) =>
  new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });

const stubDispatch = (
  respond: (sent: Sent) => Response = (sent) =>
    sent.batch
      ? ndjson(
          // Reverse order: results route by index, not arrival.
          sent.batch
            .map((item, i) => ({
              i,
              r: superjson.serialize({
                ok: true,
                value: { ok: true, data: item.operation },
              }),
            }))
            .reverse(),
        )
      : Response.json(superjson.serialize({ ok: true, data: sent.operation })),
) => {
  const sent: Sent[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = superjson.deserialize<Sent>(JSON.parse(String(init.body)));
    sent.push(body);
    return respond(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { sent, fetchMock };
};

const transport = () => ({ headers: {} });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser operation transport", () => {
  it("sends queries issued in the same tick as one request", async () => {
    const { sent, fetchMock } = stubDispatch();
    // Each call carries its own operation trace headers, as production does.
    const traced = (operation: StartOperationId) => ({
      headers: {
        "x-cubby-operation": operation,
        "x-cubby-operation-kind": "query",
      },
    });
    const results = await Promise.all([
      dispatchBrowserOperation(
        "entity.connectedRecords",
        {},
        traced("entity.connectedRecords"),
      ),
      dispatchBrowserOperation(
        "entityMedia.displayImages",
        {},
        traced("entityMedia.displayImages"),
      ),
      dispatchBrowserOperation(
        "dashboard.counts",
        {},
        traced("dashboard.counts"),
      ),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(BROWSER_OPERATION_PATH);
    expect(sent[0]!.batch!.map((item) => item.operation)).toEqual([
      "entity.connectedRecords",
      "entityMedia.displayImages",
      "dashboard.counts",
    ]);
    expect(results).toEqual([
      { ok: true, data: "entity.connectedRecords" },
      { ok: true, data: "entityMedia.displayImages" },
      { ok: true, data: "dashboard.counts" },
    ]);
  });

  it("keeps a mutation in its own request", async () => {
    const { sent } = stubDispatch();
    await Promise.all([
      dispatchBrowserOperation(
        "ai.applyFinanceCategorySuggestion",
        {},
        transport(),
      ),
      dispatchBrowserOperation("dashboard.counts", {}, transport()),
    ]);
    expect(sent).toContainEqual(
      expect.objectContaining({
        operation: "ai.applyFinanceCategorySuggestion",
      }),
    );
    expect(sent.find((body) => body.batch)?.batch).toHaveLength(1);
  });

  it("rejects every query in a batch whose request fails", async () => {
    stubDispatch(() => Response.json({ unexpected: true }, { status: 500 }));
    const settled = await Promise.allSettled([
      dispatchBrowserOperation("dashboard.counts", {}, transport()),
      dispatchBrowserOperation("entity.connectedRecords", {}, transport()),
    ]);
    expect(settled.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
  });
});
