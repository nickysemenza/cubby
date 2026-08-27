import superjson from "superjson";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { implementOperationDomain } from "./operation-domain.server";
import { implementSubscriptionDomain } from "./subscription-domain.server";

/**
 * Only the two seams a stream cannot reach in a unit test are mocked — the
 * actor lookup and the tracing span. `workflowStreamResponse` itself is the
 * real thing, so the NDJSON framing and the per-event schema parse below are
 * observed rather than asserted about.
 */
vi.mock("~/server/request-context", () => ({
  createRequestContext: vi.fn(async () => ({ requestOrigin: "ui" })),
  requireActor: vi.fn((context: object) => ({
    ...context,
    db: { handle: "db" },
  })),
}));

vi.mock("~/server/observed-request", () => ({
  observeOperation: vi.fn(
    async (
      _definition: unknown,
      _context: unknown,
      run: (span: unknown) => Promise<unknown>,
    ) => run({ setAttribute: vi.fn(), setAttributes: vi.fn() }),
  ),
}));

const tickInput = z.object({ count: z.number() });
const tickEvent = z.object({ n: z.number() });

const domain = {
  tick: {
    id: "stream.tick",
    definition: { kind: "subscription", input: tickInput, event: tickEvent },
  },
  sweep: {
    id: "stream.sweep",
    definition: {
      kind: "subscription",
      input: z.undefined(),
      event: z.string(),
    },
  },
} as const;

/** Exhaustiveness filler: a member has to exist for the table to be closed. */
async function* noEvents(): AsyncGenerator<never> {}

const streamRequest = (input: unknown, signal?: AbortSignal) =>
  new Request("https://cubby.test/api/workflow-stream/stream.tick", {
    method: "POST",
    body: superjson.stringify(input),
    ...(signal ? { signal } : {}),
  });

type Frame =
  | { kind: "event"; payload: Parameters<typeof superjson.deserialize>[0] }
  | { kind: "error"; error: { code: string; message: string } };

const framesOf = async (response: Response): Promise<Frame[]> =>
  (await response.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Frame);

const eventsOf = async (response: Response) =>
  (await framesOf(response)).map((frame) =>
    frame.kind === "event"
      ? superjson.deserialize(frame.payload)
      : { error: frame.error },
  );

describe("implementSubscriptionDomain", () => {
  beforeEach(() => vi.clearAllMocks());

  it("wraps a member in workflowStreamResponse with the declared schemas", async () => {
    const seen: { context?: { db: unknown }; input?: unknown } = {};
    const handlers = implementSubscriptionDomain(domain, {
      sweep: noEvents,
      tick: async function* (context, input) {
        seen.context = context;
        seen.input = input;
        for (let n = 1; n <= input.count; n++) yield { n };
      },
    });

    const response = await handlers.streams.tick({
      request: streamRequest({ count: 2 }),
    });
    expect(response.headers.get("content-type")).toBe(
      "application/x-ndjson; charset=utf-8",
    );
    expect(await eventsOf(response)).toEqual([{ n: 1 }, { n: 2 }]);
    // The handler sees the PARSED input and the authenticated context.
    expect(seen.input).toEqual({ count: 2 });
    expect(seen.context?.db).toEqual({ handle: "db" });
  });

  it("parses every event against the declared event schema", async () => {
    const handlers = implementSubscriptionDomain(domain, {
      sweep: noEvents,
      tick: async function* () {
        yield { n: 1 };
        yield { n: "not a number" };
        yield { n: 3 };
      },
    });

    const frames = await framesOf(
      await handlers.streams.tick({ request: streamRequest({ count: 3 }) }),
    );
    // The valid event still reaches the browser; the invalid one terminates
    // the stream rather than shipping an unvalidated payload.
    expect(frames.map((frame) => frame.kind)).toEqual(["event", "error"]);
  });

  it("rejects input the declared input schema does not accept", async () => {
    const handlers = implementSubscriptionDomain(domain, {
      sweep: noEvents,
      tick: async function* () {
        yield { n: 1 };
        throw new Error("the handler must not run on invalid input");
      },
    });

    const [frame] = await framesOf(
      await handlers.streams.tick({ request: streamRequest({ count: "two" }) }),
    );
    expect(frame?.kind).toBe("error");
    expect(frame?.kind === "error" && frame.error.code).toBe("BAD_REQUEST");
  });

  it("hands the request's abort signal to the handler", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const handlers = implementSubscriptionDomain(domain, {
      sweep: noEvents,
      tick: async function* (_context, _input, signal) {
        seenSignal = signal;
        yield { n: 1 };
      },
    });

    await handlers.streams
      .tick({ request: streamRequest({ count: 1 }, controller.signal) })
      .then((response) => response.text());
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
    controller.abort();
    expect(seenSignal?.aborted).toBe(true);
  });

  it("requires the handler table to be exhaustive and closed", () => {
    expect(() =>
      // @ts-expect-error every declared member must be implemented
      implementSubscriptionDomain(domain, { tick: noEvents }),
    ).toThrow("Missing handler for stream.sweep");

    const handlers = implementSubscriptionDomain(domain, {
      tick: noEvents,
      sweep: noEvents,
      // @ts-expect-error members outside the domain are rejected
      extra: noEvents,
    });
    expect(Object.keys(handlers.streams)).toEqual(["tick", "sweep"]);
  });

  /**
   * The wall this seam exists to keep. `subscription()` keys its schema `event`
   * and its kind `"subscription"`, so neither implementer can be handed the
   * other's domain — the failure is a typecheck error at the table, not a
   * runtime surprise at the route.
   */
  it("cannot be crossed with implementOperationDomain", () => {
    const unaryDomain = {
      range: {
        id: "calendar.range",
        definition: {
          kind: "query",
          input: z.undefined(),
          output: z.number(),
        },
      },
    } as const;

    expect(() =>
      implementSubscriptionDomain(
        // @ts-expect-error a query domain has `output`, not `event`
        unaryDomain,
        { range: noEvents },
      ),
    ).not.toThrow();

    expect(() =>
      implementOperationDomain(
        // @ts-expect-error a subscription domain has `event`, not `output`
        domain,
        { tick: async () => null, sweep: async () => null },
      ),
    ).not.toThrow();
  });
});
