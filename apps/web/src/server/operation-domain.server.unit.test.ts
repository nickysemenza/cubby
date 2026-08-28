import { testUserId } from "@cubby/schemas/testing";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { StartOperationHandler } from "~/server/generated/start-operation-handlers.gen";
import { createRequestContext, requireActor } from "~/server/request-context";
import type {
  AuthenticatedStartOperationContext,
  StartOperationRequest,
} from "~/server/start-operation.server";

import {
  implementOperationDomain,
  type OperationExecutionAdapter,
  type OperationExecutionOptions,
} from "./operation-domain.server";

const request: StartOperationRequest = {
  headers: new Headers(),
  signal: new AbortController().signal,
};

const rangeInput = z.object({ start: z.string() });
const rangeOutput = z.object({ days: z.number() });

const domain = {
  range: {
    id: "calendar.range",
    definition: { kind: "query", input: rangeInput, output: rangeOutput },
  },
  rotateFeed: {
    id: "calendar.rotateFeed",
    definition: {
      kind: "mutation",
      input: z.undefined(),
      output: z.string(),
    },
  },
} as const;

interface ExecutionObservation {
  operation: string;
  type: "query" | "mutation";
  input: z.input<z.ZodUnknown>;
  inputSchema: z.ZodType;
  outputSchema: object;
  request: StartOperationRequest;
  readPolicy?: "context" | "strong";
}

function isOutputSchemaResolver<Input, OutputSchema extends z.ZodType>(
  schema: OutputSchema | ((input: Input) => OutputSchema),
): schema is (input: Input) => OutputSchema {
  return typeof schema === "function";
}

class TestOperationExecutionAdapter implements OperationExecutionAdapter {
  context: AuthenticatedStartOperationContext;
  last?: ExecutionObservation;

  constructor(context: AuthenticatedStartOperationContext) {
    this.context = context;
  }

  async execute<Input, OutputSchema extends z.ZodType>(
    options: OperationExecutionOptions<Input, OutputSchema>,
  ) {
    const observation: ExecutionObservation = {
      operation: options.operation,
      type: options.type,
      input: options.input,
      inputSchema: options.inputSchema,
      outputSchema: options.outputSchema,
      request: options.request,
    };
    if (options.readPolicy) observation.readPolicy = options.readPolicy;
    this.last = observation;

    const input = options.inputSchema.parse(options.input);
    const rawOutput = await options.run(this.context, input);
    const outputSchema = isOutputSchemaResolver(options.outputSchema)
      ? options.outputSchema(input)
      : options.outputSchema;
    return { ok: true as const, data: outputSchema.parse(rawOutput) };
  }
}

interface RangeObservation {
  context?: AuthenticatedStartOperationContext & { signal: AbortSignal };
  input?: z.output<typeof rangeInput>;
}

let baseContext: AuthenticatedStartOperationContext;
let adapter: TestOperationExecutionAdapter;

describe("implementOperationDomain", () => {
  beforeAll(async () => {
    baseContext = requireActor(
      await createRequestContext({
        headers: new Headers(),
        actor: {
          userId: testUserId("operation-domain-user"),
          sessionId: null,
          source: "ui",
        },
      }),
    );
  });

  beforeEach(() => {
    adapter = new TestOperationExecutionAdapter(baseContext);
  });

  it("wraps a short-form member with the declared correlated schemas", async () => {
    const seen: RangeObservation = {};
    const handlers = implementOperationDomain(
      domain,
      {
        range: async (context, input) => {
          seen.context = context;
          seen.input = input;
          return { days: 2 };
        },
        rotateFeed: async () => "rotated",
      },
      adapter,
    );

    await expect(
      handlers.operations.range({ data: { start: "2026-08-25" }, request }),
    ).resolves.toEqual({ ok: true, data: { days: 2 } });

    expect(adapter.last).toMatchObject({
      operation: "calendar.range",
      type: "query",
      input: { start: "2026-08-25" },
      request,
    });
    expect(adapter.last?.inputSchema).toBe(rangeInput);
    expect(adapter.last?.outputSchema).toBe(rangeOutput);
    expect(adapter.last).not.toHaveProperty("readPolicy");
    expect(seen.input).toEqual({ start: "2026-08-25" });
    expect(seen.context?.signal).toBe(request.signal);
    expect(seen.context?.db).toBe(baseContext.db);
  });

  it("forwards a long-form readPolicy override", async () => {
    const handlers = implementOperationDomain(
      domain,
      {
        range: {
          readPolicy: "strong",
          run: async () => ({ days: 0 }),
        },
        rotateFeed: async () => "rotated",
      },
      adapter,
    );

    await handlers.operations.range({ data: { start: "x" }, request });
    expect(adapter.last).toMatchObject({
      operation: "calendar.range",
      readPolicy: "strong",
    });
  });

  it("passes equivalent input and derived output schema overrides through", async () => {
    const serverInput = z.object({ start: z.string() }).passthrough();
    const derivedOutput = rangeOutput.describe("derived");
    const outputForInput = (input: { start: string }) =>
      derivedOutput.describe(input.start);
    const handlers = implementOperationDomain(
      domain,
      {
        range: {
          input: serverInput,
          output: outputForInput,
          run: async () => ({ days: 4 }),
        },
        rotateFeed: async () => "rotated",
      },
      adapter,
    );

    await expect(
      handlers.operations.range({
        data: { start: "x", entity: "product" },
        request,
      }),
    ).resolves.toEqual({ ok: true, data: { days: 4 } });
    expect(adapter.last?.inputSchema).toBe(serverInput);
    expect(adapter.last?.outputSchema).toBe(outputForInput);
  });

  it("requires the handler table to be exhaustive and closed", () => {
    expect(() =>
      // @ts-expect-error every declared member must be implemented
      implementOperationDomain(domain, { range: async () => ({ days: 1 }) }),
    ).toThrow("Missing handler for calendar.rotateFeed");

    const handlers = implementOperationDomain(domain, {
      range: async () => ({ days: 1 }),
      rotateFeed: async () => "rotated",
      // @ts-expect-error members outside the domain are rejected
      extra: async () => null,
    });
    expect(Object.keys(handlers.operations)).toEqual(["range", "rotateFeed"]);
  });

  it("returns operations already shaped as StartOperationHandler", async () => {
    const handlers = implementOperationDomain(
      domain,
      {
        range: async () => ({ days: 1 }),
        rotateFeed: async () => "rotated",
      },
      adapter,
    );
    const handler: StartOperationHandler = handlers.operations.rotateFeed;
    await expect(handler({ data: undefined, request })).resolves.toEqual({
      ok: true,
      data: "rotated",
    });
    expect(adapter.last).toMatchObject({
      operation: "calendar.rotateFeed",
      type: "mutation",
    });
  });
});
