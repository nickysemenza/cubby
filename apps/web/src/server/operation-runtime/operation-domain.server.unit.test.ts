import { testUserId } from "@cubby/schemas/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";
import type { StartOperationHandler } from "~/server/generated/start-operation-handlers.gen";
import { systemPrincipal } from "~/server/http/authenticate";
import {
  createRequestContext,
  requireActor,
} from "~/server/http/request-context";
import type {
  AuthenticatedStartOperationContext,
  StartOperationRequest,
} from "~/server/operation-runtime/start-operation.server";

import { implementOperationDomain } from "./operation-domain.server";

const rangeInput = z.object({ start: z.string() });
const rangeOutput = z.object({ days: z.number() });

const domain = defineContract("calendar", {
  range: query({ input: rangeInput, output: rangeOutput }),
  rotateFeed: mutation({ input: z.undefined(), output: z.string() }),
});

interface RangeObservation {
  context?: AuthenticatedStartOperationContext & { signal: AbortSignal };
  input?: unknown;
}

let baseContext: AuthenticatedStartOperationContext;
let request: StartOperationRequest;

// Each handler runs through the production runner under a principal on a
// context that needs no database, so these checks see what the runner hands
// the member: parsed input, the request signal, and validated output.
describe("implementOperationDomain", () => {
  beforeAll(async () => {
    baseContext = requireActor(
      await createRequestContext({
        headers: new Headers(),
        actor: {
          userId: testUserId("operation-domain-user"),
          sessionId: null,
          channel: "web",
        },
      }),
    );
    request = {
      principal: systemPrincipal(baseContext),
      headers: new Headers(),
      signal: new AbortController().signal,
    };
  });

  it("wraps a short-form member with the declared correlated schemas", async () => {
    const seen: RangeObservation = {};
    const handlers = implementOperationDomain(domain, {
      range: async (context, input) => {
        seen.context = context;
        seen.input = input;
        return { days: 2 };
      },
      rotateFeed: async () => "rotated",
    });

    await expect(
      handlers.operations.range({
        data: { start: "2026-08-25", extra: "stripped" },
        request,
      }),
    ).resolves.toEqual({ ok: true, data: { days: 2 } });

    expect(seen.input).toEqual({ start: "2026-08-25" });
    expect(seen.context?.signal).toBe(request.signal);
    expect(seen.context?.db).toBe(baseContext.db);
    expect(seen.context?.currentParty).toEqual(expect.any(Function));
    await expect(
      handlers.operations.range({ data: { start: 3 }, request }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "BAD_REQUEST", reason: "INVALID_INPUT" },
    });
  });

  it("passes equivalent input and derived output schema overrides through", async () => {
    const seen: RangeObservation = {};
    const serverInput = z.object({ start: z.string() }).passthrough();
    const outputForInput = vi.fn((_input: { start: string }) =>
      rangeOutput.extend({ days: z.number().max(3) }),
    );
    const handlers = implementOperationDomain(domain, {
      range: {
        input: serverInput,
        output: outputForInput,
        run: async (_context, input) => {
          seen.input = input;
          return { days: 4 };
        },
      },
      rotateFeed: async () => "rotated",
    });

    await expect(
      handlers.operations.range({
        data: { start: "x", entity: "product" },
        request,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { reason: "INVALID_OUTPUT" },
    });
    expect(seen.input).toEqual({ start: "x", entity: "product" });
    expect(outputForInput).toHaveBeenCalledWith({
      start: "x",
      entity: "product",
    });
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
    const handlers = implementOperationDomain(domain, {
      range: async () => ({ days: 1 }),
      rotateFeed: async () => "rotated",
    });
    const handler: StartOperationHandler = handlers.operations.rotateFeed;
    await expect(handler({ data: undefined, request })).resolves.toEqual({
      ok: true,
      data: "rotated",
    });
  });
});
