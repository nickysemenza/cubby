import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { StartOperationHandler } from "~/server/generated/start-operation-handlers.gen";
import type {
  AuthenticatedStartOperationContext,
  StartOperationRequest,
} from "~/server/start-operation.server";

import { implementOperationDomain } from "./operation-domain.server";

const { runStartOperationMock } = vi.hoisted(() => ({
  runStartOperationMock: vi.fn(),
}));

vi.mock("~/server/start-operation.server", () => ({
  runStartOperation: runStartOperationMock,
}));

const baseContext = {
  db: { handle: "db" },
  readDb: { handle: "readDb" },
  actorContext: { userId: "user-1" },
} as unknown as AuthenticatedStartOperationContext;

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

const lastOptions = () => {
  const options = runStartOperationMock.mock.lastCall?.[0];
  if (!options) throw new Error("runStartOperation was not called");
  return options;
};

describe("implementOperationDomain", () => {
  beforeEach(() => {
    runStartOperationMock.mockReset();
    runStartOperationMock.mockImplementation(
      async (options: {
        input: unknown;
        inputSchema: z.ZodType;
        run: (context: unknown, input: unknown) => Promise<unknown>;
      }) => ({
        ok: true,
        data: await options.run(
          baseContext,
          options.inputSchema.parse(options.input),
        ),
      }),
    );
  });

  it("wraps a short-form member in runStartOperation with the declared schemas", async () => {
    const seen: {
      context?: { signal: AbortSignal; db: unknown };
      input?: unknown;
    } = {};
    const handlers = implementOperationDomain(domain, {
      range: async (context, input) => {
        seen.context = context;
        seen.input = input;
        return { days: 2 };
      },
      rotateFeed: async () => "rotated",
    });

    await expect(
      handlers.operations.range({ data: { start: "2026-08-25" }, request }),
    ).resolves.toEqual({ ok: true, data: { days: 2 } });

    const options = lastOptions();
    expect(options).toMatchObject({
      operation: "calendar.range",
      type: "query",
      input: { start: "2026-08-25" },
      request,
    });
    expect(options.inputSchema).toBe(rangeInput);
    expect(options.outputSchema).toBe(rangeOutput);
    // The default read policy stays runStartOperation's decision.
    expect(options).not.toHaveProperty("readPolicy");
    // The handler sees the parsed input and the context plus the request's
    // abort signal.
    expect(seen.input).toEqual({ start: "2026-08-25" });
    expect(seen.context?.signal).toBe(request.signal);
    expect(seen.context?.db).toBe(baseContext.db);
  });

  it("forwards a long-form readPolicy override to runStartOperation", async () => {
    const handlers = implementOperationDomain(domain, {
      range: {
        readPolicy: "strong",
        run: async () => ({ days: 0 }),
      },
      rotateFeed: async () => "rotated",
    });

    await handlers.operations.range({ data: { start: "x" }, request });
    expect(lastOptions()).toMatchObject({
      operation: "calendar.range",
      readPolicy: "strong",
    });
  });

  it("passes input and output schema overrides through, including the function form", async () => {
    const serverInput = z.object({ start: z.string(), entity: z.string() });
    const derivedOutput = z.object({ echoed: z.string() });
    const outputForInput = (input: { start: string }) =>
      derivedOutput.describe(input.start);
    const handlers = implementOperationDomain(domain, {
      range: {
        input: serverInput,
        output: outputForInput,
        run: async () => ({ echoed: "yes" }),
      },
      rotateFeed: async () => "rotated",
    });

    await handlers.operations.range({
      data: { start: "x", entity: "product" },
      request,
    });
    const options = lastOptions();
    expect(options.inputSchema).toBe(serverInput);
    expect(options.outputSchema).toBe(outputForInput);
  });

  it("requires the handler table to be exhaustive and closed", () => {
    expect(() =>
      // @ts-expect-error every declared member must be implemented
      implementOperationDomain(domain, {
        range: async () => ({ days: 1 }),
      }),
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
    const handlers = implementOperationDomain(domain, {
      range: async () => ({ days: 1 }),
      rotateFeed: async () => "rotated",
    });
    // Assignable without casts — this is what lets the generated loader drop
    // its `as unknown as StartOperationHandler` erasure.
    const handler: StartOperationHandler = handlers.operations.rotateFeed;
    await expect(handler({ data: undefined, request })).resolves.toEqual({
      ok: true,
      data: "rotated",
    });
    expect(lastOptions()).toMatchObject({
      operation: "calendar.rotateFeed",
      type: "mutation",
    });
  });
});
