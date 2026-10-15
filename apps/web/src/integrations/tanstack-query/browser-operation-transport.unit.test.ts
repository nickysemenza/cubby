import superjson from "superjson";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import type { ErrorDiagnostics } from "~/lib/error-diagnostics";
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const poolFailure = (
  requestId = "synthetic-request",
  cause: ErrorDiagnostics["causes"][number] = {
    name: "error",
    code: "58000",
    message: "Timed out while waiting for an open slot in the pool.",
  },
) => ({
  ok: false,
  error: {
    message: cause.message,
    code: "INTERNAL_SERVER_ERROR",
    requestId,
    diagnostics: {
      origin: "server",
      operation: "entity.connectedRecords",
      stage: "run",
      causes: [cause],
    },
  },
});

describe("browser operation transport", () => {
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
      return Response.json(
        superjson.serialize({ ok: true, data: body.operation }),
      );
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

  it.each(["pool", "pool punctuation", "disconnect", "context disconnect"])(
    "recovers a transient %s failure on a fresh read request",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let attempts = 0;
      const failure = kind.startsWith("pool")
        ? poolFailure()
        : poolFailure("synthetic-request", {
            name: "Error",
            message: "Connection terminated unexpectedly",
          });
      if (kind === "pool punctuation")
        failure.error.diagnostics.causes[0]!.message =
          "Timed out while waiting for an open slot in the pool";
      if (kind === "context disconnect") {
        failure.error.diagnostics.stage = "context";
        failure.error.diagnostics.causes[0]!.code = "08006";
      }
      const { sent } = stubDispatch(() =>
        Response.json(
          superjson.serialize(
            ++attempts === 1 ? failure : { ok: true, data: "recovered" },
          ),
        ),
      );
      const result = dispatchBrowserOperation(
        "entity.connectedRecords",
        {},
        transport(),
      );
      await vi.runAllTimersAsync();
      expect(await result).toEqual({ ok: true, data: "recovered" });
      expect(sent).toHaveLength(2);
    },
  );

  // Independent per-item jitter splits a failed batch into cold singleton
  // requests instead of letting its siblings share their recovery request.
  it("coalesces transiently failed batch siblings on their retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValue(0.99);
    let batches = 0;
    const { sent } = stubDispatch((body) => {
      if (!body.batch)
        return Response.json(
          superjson.serialize({ ok: true, data: "singleton" }),
        );
      batches += 1;
      return ndjson(
        body.batch.map((item, i) => ({
          i,
          r: superjson.serialize({
            ok: true,
            value:
              batches === 1
                ? poolFailure()
                : { ok: true, data: item.operation },
          }),
        })),
      );
    });
    const results = Promise.all([
      dispatchBrowserOperation("dashboard.counts", {}, transport()),
      dispatchBrowserOperation("entity.connectedRecords", {}, transport()),
    ]);
    await vi.runAllTimersAsync();
    expect(await results).toEqual([
      { ok: true, data: "dashboard.counts" },
      { ok: true, data: "entity.connectedRecords" },
    ]);
    expect(sent).toHaveLength(2);
    expect(sent.every((body) => body.batch?.length === 2)).toBe(true);
  });

  it("does not retry hidden authentication causes or thrown transport failures", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const failure = poolFailure();
    failure.error.message = "Unable to complete request";
    failure.error.diagnostics.stage = "context";
    failure.error.diagnostics.causes = [];
    const { fetchMock } = stubDispatch(() =>
      Response.json(superjson.serialize(failure)),
    );
    const hidden = dispatchBrowserOperation(
      "dashboard.counts",
      {},
      transport(),
    );
    await vi.runAllTimersAsync();
    expect(await hidden).toEqual(failure);
    const transportError = new Error("Synthetic transport failure");
    fetchMock.mockRejectedValue(transportError);
    const thrown = dispatchBrowserOperation(
      "dashboard.counts",
      {},
      transport(),
    ).catch((error) => error);
    await vi.runAllTimersAsync();
    expect(await thrown).toBe(transportError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries only a failed streamed read without replaying its successful sibling", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { sent } = stubDispatch((body) =>
      body.batch
        ? ndjson(
            body.batch.map((item, i) => ({
              i,
              r: superjson.serialize({
                ok: true,
                value:
                  item.operation === "entity.connectedRecords"
                    ? poolFailure()
                    : { ok: true, data: "summary" },
              }),
            })),
          )
        : Response.json(superjson.serialize({ ok: true, data: "connections" })),
    );
    const results = Promise.all([
      dispatchBrowserOperation("dashboard.counts", {}, transport()),
      dispatchBrowserOperation("entity.connectedRecords", {}, transport()),
    ]);
    await vi.runAllTimersAsync();
    expect(await results).toEqual([
      { ok: true, data: "summary" },
      { ok: true, data: "connections" },
    ]);
    expect(
      sent.map(
        (body) => body.operation ?? body.batch?.map((item) => item.operation),
      ),
    ).toEqual([
      ["dashboard.counts", "entity.connectedRecords"],
      "entity.connectedRecords",
    ]);
  });

  it("bounds read retries and retains the last raw diagnostics without retrying mutations", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let attempts = 0;
    const { sent } = stubDispatch(() =>
      Response.json(superjson.serialize(poolFailure(`request-${++attempts}`))),
    );
    const result = dispatchBrowserOperation(
      "entity.connectedRecords",
      {},
      transport(),
    );
    await vi.runAllTimersAsync();
    expect(await result).toEqual(poolFailure("request-3"));
    expect(sent).toHaveLength(3);
    await dispatchBrowserOperation(
      "ai.applyFinanceCategorySuggestion",
      {},
      transport(),
    );
    expect(sent).toHaveLength(4);
  });

  it("does not retry unrelated database failures or cancelled retry waits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const failure = poolFailure();
    failure.error.diagnostics.causes[0]!.message = "Unrelated system error";
    const { fetchMock } = stubDispatch(() =>
      Response.json(superjson.serialize(failure)),
    );
    const unrelated = dispatchBrowserOperation(
      "entity.connectedRecords",
      {},
      transport(),
    );
    await vi.runAllTimersAsync();
    expect(await unrelated).toEqual(failure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(async () =>
      Response.json(superjson.serialize(poolFailure())),
    );
    const controller = new AbortController();
    const result = dispatchBrowserOperation(
      "entity.connectedRecords",
      {},
      { headers: {}, signal: controller.signal },
    );
    const observed = result.then(
      () => "returned",
      () => "cancelled",
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.runAllTimersAsync();
    expect(await observed).toBe("cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  // Covers an HTTP failure and a server without batch support mid-deploy:
  // each query is resent alone and keeps its single-operation result.
  it("resends each query alone when the batch request fails", async () => {
    const { sent } = stubDispatch((body) =>
      body.batch
        ? new Response("Internal Server Error", { status: 500 })
        : Response.json(
            superjson.serialize({ ok: true, data: body.operation }),
          ),
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
