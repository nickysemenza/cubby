import { testUserId } from "@cubby/schemas/testing";
import superjson from "superjson";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineContract, query, subscription } from "~/contracts/define";

import { implementOperationDomain } from "./operation-domain.server";
import { createRequestContext, requireActor } from "./request-context";
import type { AuthenticatedStartOperationContext } from "./start-operation.server";
import { normalizeStartOperationError } from "./start-operation.server";
import {
  implementSubscriptionDomain,
  type WorkflowStreamExecutionAdapter,
  type WorkflowStreamExecutionOptions,
} from "./subscription-domain.server";

const tickInput = z.object({ count: z.number() });
const tickEvent = z.object({ n: z.number() });

// Member names must be registered subscription ids under one domain; the
// schemas are the test's own.
const domain = defineContract("ai", {
  backfillLocationDescriptions: subscription({
    input: tickInput,
    event: tickEvent,
  }),
  precomputeEnrichmentProposals: subscription({
    input: z.undefined(),
    event: z.string(),
  }),
});

/** Exhaustiveness filler: a member has to exist for the table to be closed. */
async function* noEvents(): AsyncGenerator<never> {}

const streamRequest = <Input>(input: Input, signal?: AbortSignal) => {
  const init: RequestInit = {
    method: "POST",
    body: superjson.stringify(input),
  };
  if (signal) init.signal = signal;
  return new Request(
    "https://cubby.test/api/workflow-stream/ai.backfillLocationDescriptions",
    init,
  );
};

const serializedPayloadSchema =
  z.custom<ReturnType<typeof superjson.serialize>>();
const frameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), payload: serializedPayloadSchema }),
  z.object({
    kind: z.literal("error"),
    error: z.object({ code: z.string(), message: z.string() }).passthrough(),
  }),
]);
type Frame = z.output<typeof frameSchema>;

const framesOf = async (response: Response): Promise<Frame[]> =>
  (await response.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => frameSchema.parse(JSON.parse(line)));

const eventsOf = async (response: Response) =>
  (await framesOf(response)).map((frame) =>
    frame.kind === "event"
      ? superjson.deserialize(frame.payload)
      : { error: frame.error },
  );

interface StreamObservation {
  operation: string;
  inputSchema: z.ZodType;
  eventSchema: z.ZodType;
  request: Request;
}

class TestWorkflowStreamExecutionAdapter implements WorkflowStreamExecutionAdapter {
  context: AuthenticatedStartOperationContext;
  last?: StreamObservation;

  constructor(context: AuthenticatedStartOperationContext) {
    this.context = context;
  }

  async respond<Input, EventSchema extends z.ZodType>(
    options: WorkflowStreamExecutionOptions<Input, EventSchema>,
  ): Promise<Response> {
    this.last = {
      operation: options.operation,
      inputSchema: options.inputSchema,
      eventSchema: options.eventSchema,
      request: options.request,
    };

    const frames: Frame[] = [];
    let stage: "input" | "run" | "output" = "input";
    try {
      const input = options.inputSchema.parse(
        superjson.parse(await options.request.text()),
      );
      stage = "run";
      const events = await options.run(
        this.context,
        input,
        options.request.signal,
      );
      for await (const event of events) {
        stage = "output";
        const parsed = options.eventSchema.parse(event);
        frames.push({ kind: "event", payload: superjson.serialize(parsed) });
        stage = "run";
      }
    } catch (error) {
      frames.push({
        kind: "error",
        error: normalizeStartOperationError(error, stage).publicError,
      });
    }

    return new Response(
      frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""),
      {
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      },
    );
  }
}

interface TickObservation {
  context?: AuthenticatedStartOperationContext;
  input?: z.output<typeof tickInput>;
}

let baseContext: AuthenticatedStartOperationContext;
let adapter: TestWorkflowStreamExecutionAdapter;

describe("implementSubscriptionDomain", () => {
  beforeAll(async () => {
    baseContext = requireActor(
      await createRequestContext({
        headers: new Headers(),
        actor: {
          userId: testUserId("subscription-domain-user"),
          sessionId: null,
          channel: "web",
        },
      }),
    );
  });

  beforeEach(() => {
    adapter = new TestWorkflowStreamExecutionAdapter(baseContext);
  });

  it("keeps each member correlated through the injected stream adapter", async () => {
    const seen: TickObservation = {};
    const handlers = implementSubscriptionDomain(
      domain,
      {
        precomputeEnrichmentProposals: noEvents,
        backfillLocationDescriptions: async function* (context, input) {
          seen.context = context;
          seen.input = input;
          for (let n = 1; n <= input.count; n++) yield { n };
        },
      },
      adapter,
    );

    const request = streamRequest({ count: 2 });
    const response = await handlers.streams.backfillLocationDescriptions({
      request,
    });
    expect(response.headers.get("content-type")).toBe(
      "application/x-ndjson; charset=utf-8",
    );
    expect(await eventsOf(response)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(adapter.last).toMatchObject({
      operation: "ai.backfillLocationDescriptions",
      request,
    });
    expect(adapter.last?.inputSchema).toBe(tickInput);
    expect(adapter.last?.eventSchema).toBe(tickEvent);
    expect(seen.input).toEqual({ count: 2 });
    expect(seen.context?.db).toBe(baseContext.db);
  });

  it("parses every yielded event against the declared event schema", async () => {
    const handlers = implementSubscriptionDomain(
      domain,
      {
        precomputeEnrichmentProposals: noEvents,
        backfillLocationDescriptions: async function* () {
          yield { n: 1 };
          // SAFETY: deliberately malformed runtime data exercises the adapter's
          // event-schema guard; the declared member type is not being widened.
          yield { n: "not-a-number" } as never;
          yield { n: 3 };
        },
      },
      adapter,
    );

    // The valid event is delivered; the invalid event terminates the stream
    // with a protocol error instead of leaking unvalidated payloads.
    const frames = await framesOf(
      await handlers.streams.backfillLocationDescriptions({
        request: streamRequest({ count: 3 }),
      }),
    );
    expect(frames.map((frame) => frame.kind)).toEqual(["event", "error"]);
  });

  it("rejects input before invoking its member", async () => {
    let invoked = false;
    const handlers = implementSubscriptionDomain(
      domain,
      {
        precomputeEnrichmentProposals: noEvents,
        backfillLocationDescriptions: async function* () {
          invoked = true;
          yield { n: 1 };
        },
      },
      adapter,
    );

    const [frame] = await framesOf(
      await handlers.streams.backfillLocationDescriptions({
        request: streamRequest({ count: "two" }),
      }),
    );
    expect(frame?.kind).toBe("error");
    expect(frame?.kind === "error" && frame.error.code).toBe("BAD_REQUEST");
    expect(invoked).toBe(false);
  });

  it("hands the request abort signal to the member", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const handlers = implementSubscriptionDomain(
      domain,
      {
        precomputeEnrichmentProposals: noEvents,
        backfillLocationDescriptions: async function* (
          _context,
          _input,
          signal,
        ) {
          seenSignal = signal;
          yield { n: 1 };
        },
      },
      adapter,
    );

    await handlers.streams
      .backfillLocationDescriptions({
        request: streamRequest({ count: 1 }, controller.signal),
      })
      .then((response) => response.text());
    expect(seenSignal?.aborted).toBe(false);
    controller.abort();
    expect(seenSignal?.aborted).toBe(true);
  });

  it("retains NDJSON error framing and authenticates before parsing input", async () => {
    const handlers = implementSubscriptionDomain(domain, {
      precomputeEnrichmentProposals: noEvents,
      backfillLocationDescriptions: async function* () {
        yield { n: 1 };
      },
    });
    const request = new Request(
      "https://cubby.test/api/workflow-stream/ai.backfillLocationDescriptions",
      { method: "POST", body: "not-superjson" },
    );

    const [frame] = await framesOf(
      await handlers.streams.backfillLocationDescriptions({ request }),
    );
    expect(frame?.kind).toBe("error");
    expect(frame?.kind === "error" && frame.error.code).toBe("UNAUTHORIZED");
  });

  it("requires the handler table to be exhaustive and closed", () => {
    expect(() =>
      implementSubscriptionDomain(
        domain,
        // @ts-expect-error every declared member must be implemented
        { backfillLocationDescriptions: noEvents },
        adapter,
      ),
    ).toThrow("Missing handler for ai.precomputeEnrichmentProposals");

    const handlers = implementSubscriptionDomain(domain, {
      backfillLocationDescriptions: noEvents,
      precomputeEnrichmentProposals: noEvents,
      // @ts-expect-error members outside the domain are rejected
      extra: noEvents,
    });
    expect(Object.keys(handlers.streams)).toEqual([
      "backfillLocationDescriptions",
      "precomputeEnrichmentProposals",
    ]);
  });

  it("skips members of the other implementation table", () => {
    // A contract may mix kinds; each implementer owns only its own kind and
    // the generated registry checks that every member has an implementer.
    const unaryDomain = defineContract("calendar", {
      range: query({ input: z.undefined(), output: z.number() }),
    });

    expect(
      Object.keys(
        implementSubscriptionDomain(unaryDomain, {}, adapter).streams,
      ),
    ).toEqual([]);
    expect(
      Object.keys(implementOperationDomain(domain, {}).operations),
    ).toEqual([]);
  });
});
