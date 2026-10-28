import { afterEach, describe, expect, it, vi } from "vitest";

import { browserOperationPath } from "~/lib/browser-operation-path";
import { StartOperationError } from "~/lib/start-operation-error";
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
  respond: (sent: Sent) => Response | Promise<Response> = (sent) =>
    sent.batch
      ? ndjson(
          // Reverse order: results route by index, not arrival.
          sent.batch
            .map((item, i) => ({
              i,
              r: {
                ok: true,
                value: { ok: true, data: item.operation },
              },
            }))
            .reverse(),
        )
      : Response.json({ ok: true, data: sent.operation }),
) => {
  const sent: Sent[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body: Sent = JSON.parse(String(init.body));
    sent.push(body);
    return respond(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { sent, fetchMock };
};

const transport = () => ({ headers: {} });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser operation transport", () => {
  it("reads a refusal as the bare error under its HTTP status", async () => {
    const { fetchMock } = stubDispatch(() =>
      Response.json(
        { code: "CONFLICT", message: "Synthetic conflict" },
        { status: 409 },
      ),
    );
    await expect(
      dispatchBrowserOperation(
        "ai.applyFinanceCategorySuggestion",
        {},
        transport(),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "CONFLICT", message: "Synthetic conflict" },
    });
    // The browser names its surface instead of a value codec.
    const headers = new Headers(fetchMock.mock.calls[0]?.[1].headers);
    expect(headers.get("x-cubby-surface")).toBe("browser");
  });
  it("keeps a malformed single response's body and HTTP metadata after batch fallback", async () => {
    const { fetchMock } = stubDispatch((body) =>
      body.batch
        ? new Response("Synthetic batch unavailable", { status: 503 })
        : new Response("<html>synthetic malformed response</html>", {
            headers: { "x-request-id": "single-request" },
          }),
    );
    const errors = await Promise.all([
      dispatchBrowserOperation("dashboard.counts", {}, transport()).catch(
        (error) => error,
      ),
      dispatchBrowserOperation("entity.list", {}, transport()).catch(
        (error) => error,
      ),
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(StartOperationError);
      expect(error).toMatchObject({
        data: {
          code: "INVALID_TRANSPORT_RESPONSE",
          requestId: "single-request",
          diagnostics: {
            http: {
              status: 200,
              body: "<html>synthetic malformed response</html>",
            },
          },
        },
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("keeps each singleton's trace headers when the header-group batcher is reused", async () => {
    const { fetchMock } = stubDispatch();
    for (const operation of ["dashboard.counts", "entity.list"] as const) {
      await dispatchBrowserOperation(
        operation,
        {},
        {
          headers: {
            "x-cubby-operation": operation,
            "x-cubby-operation-kind": "query",
            ...(operation === "entity.list"
              ? { "x-cubby-operation-entity": "product" }
              : {}),
          },
        },
      );
    }
    const second = new Headers(fetchMock.mock.calls[1]?.[1].headers);
    expect(second.get("x-cubby-operation")).toBe("entity.list");
    expect(second.get("x-cubby-operation-entity")).toBe("product");
  });
  // Work partitioned for an invocation budget must not be coalesced again by transport.
  it("keeps opted-out reads in separate requests while default reads coalesce", async () => {
    const { sent } = stubDispatch();
    await Promise.all([
      dispatchBrowserOperation(
        "dashboard.counts",
        {},
        { ...transport(), batch: false },
      ),
      dispatchBrowserOperation(
        "dashboard.counts",
        {},
        { ...transport(), batch: false },
      ),
      dispatchBrowserOperation("dashboard.counts", {}, transport()),
      dispatchBrowserOperation("dashboard.counts", {}, transport()),
    ]);
    expect(sent.filter((body) => body.operation)).toHaveLength(2);
    expect(sent.filter((body) => body.batch)).toHaveLength(1);
    expect(sent.find((body) => body.batch)?.batch).toHaveLength(2);
  });

  // The HTTP seam observes actual admission, including separate header groups,
  // singleton reads, and the fallback burst after a failed batch.
  it("bounds singleton and fallback reads across header groups and cancels queued reads", async () => {
    const gate = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    const { sent } = stubDispatch(async (body) => {
      if (body.batch) return new Response("Unavailable", { status: 503 });
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return Response.json({ ok: true, data: body.operation });
    });
    const pending = Array.from({ length: 8 }, () =>
      dispatchBrowserOperation("dashboard.counts", {}, transport()),
    );
    await vi.waitFor(() =>
      expect(sent.filter((body) => !body.batch).length).toBeGreaterThanOrEqual(
        4,
      ),
    );
    const controller = new AbortController();
    const cancelled = dispatchBrowserOperation(
      "entity.connections",
      {},
      {
        headers: { "x-test-group": "separate" },
        signal: controller.signal,
      },
    ).then(
      () => "sent",
      () => "cancelled",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    gate.resolve();
    await Promise.all(pending);
    expect(await cancelled).toBe("cancelled");
    expect(peak).toBeLessThanOrEqual(4);
    expect(sent.some((body) => body.operation === "entity.connections")).toBe(
      false,
    );
  });

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
    expect(fetchMock.mock.calls[0]![0]).toBe(
      browserOperationPath([
        "entity.connectedRecords",
        "entityMedia.displayImages",
        "dashboard.counts",
      ]),
    );
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

  it("sends a mutation, or a query alone in its tick, as a single operation", async () => {
    const { sent } = stubDispatch();
    await dispatchBrowserOperation(
      "ai.applyFinanceCategorySuggestion",
      {},
      transport(),
    );
    await dispatchBrowserOperation("dashboard.counts", {}, transport());
    expect(sent.map((body) => body.operation)).toEqual([
      "ai.applyFinanceCategorySuggestion",
      "dashboard.counts",
    ]);
    expect(sent.some((body) => body.batch)).toBe(false);
  });

  // A Worker stream can end cleanly before answering every item (observed:
  // HTTP 200 NDJSON with an empty body). Only unanswered reads resend alone;
  // streamed values and real per-item errors are kept, never replayed.
  const notFound = {
    ok: false,
    error: { message: "Record not found", code: "NOT_FOUND" },
  };
  it.each([
    {
      stream: "an empty stream",
      answered: [],
      results: [
        { ok: true, data: "dashboard.counts" },
        { ok: true, data: "entity.connectedRecords" },
        { ok: true, data: "entity.connections" },
      ],
      resent: [
        "dashboard.counts",
        "entity.connectedRecords",
        "entity.connections",
      ],
    },
    {
      stream: "a partial stream",
      answered: [0, 1],
      results: [
        { ok: true, data: "streamed" },
        notFound,
        { ok: true, data: "entity.connections" },
      ],
      resent: ["entity.connections"],
    },
  ])(
    "resends only reads $stream left unanswered",
    async ({ answered, results, resent }) => {
      const { sent } = stubDispatch((body) =>
        body.batch
          ? ndjson(
              answered.map((i) => ({
                i,
                r: {
                  ok: true,
                  value: i === 1 ? notFound : { ok: true, data: "streamed" },
                },
              })),
            )
          : Response.json({ ok: true, data: body.operation }),
      );
      expect(
        await Promise.all(
          (
            [
              "dashboard.counts",
              "entity.connectedRecords",
              "entity.connections",
            ] as const
          ).map((operation) =>
            dispatchBrowserOperation(operation, {}, transport()),
          ),
        ),
      ).toEqual(results);
      expect(sent.flatMap((body) => body.operation ?? []).sort()).toEqual(
        resent,
      );
    },
  );

  // Covers an HTTP failure and a server without batch support mid-deploy:
  // each query is resent alone and keeps its single-operation result.
  it("resends each query alone when the batch request fails", async () => {
    const { sent } = stubDispatch((body) =>
      body.batch
        ? new Response("Internal Server Error", { status: 500 })
        : Response.json({ ok: true, data: body.operation }),
    );
    const results = await Promise.all([
      dispatchBrowserOperation("dashboard.counts", {}, transport()),
      dispatchBrowserOperation("entity.connectedRecords", {}, transport()),
    ]);
    expect(results).toEqual([
      { ok: true, data: "dashboard.counts" },
      { ok: true, data: "entity.connectedRecords" },
    ]);
    expect(sent.filter((body) => !body.batch)).toHaveLength(2);
  });
});
