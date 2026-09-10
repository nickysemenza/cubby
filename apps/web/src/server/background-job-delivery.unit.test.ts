import { describe, expect, it } from "vitest";

import { WorkflowCancelledError, workflow } from "~/server/workflow-runtime";

import {
  executeBackgroundJobDelivery,
  inspectBackgroundJobDelivery,
  type BackgroundJobDeliveryDefinition,
} from "./background-job-delivery";

type Context = { events: string[] };
type Status = "succeeded" | "skipped";
type Outcome = "retry" | "failed";

const delivery = (
  payload: BackgroundJobDeliveryDefinition<
    Context,
    undefined,
    Status,
    Outcome
  >["payload"],
  advance: BackgroundJobDeliveryDefinition<
    Context,
    undefined,
    Status,
    Outcome
  >["advance"],
  options: Partial<
    Pick<
      BackgroundJobDeliveryDefinition<Context, undefined, Status, Outcome>,
      "finish" | "failOrRetry" | "failedAdvance"
    >
  > = {},
): BackgroundJobDeliveryDefinition<Context, undefined, Status, Outcome> => ({
  name: "job.delivery",
  payload,
  finish:
    options.finish ??
    workflow<Context, { status: Status }>("job.finish")
      .commit("finish", async ({ context }) => {
        context.events.push("finish");
      })
      .output(() => undefined),
  advance,
  failOrRetry:
    options.failOrRetry ??
    workflow<Context, { error: unknown }>("job.fail")
      .commit("settle", async ({ context }) => {
        context.events.push("settle");
        return "retry" as const;
      })
      .output(({ settle }) => settle),
  failedAdvance:
    options.failedAdvance ??
    workflow<Context, undefined>("job.failedAdvance")
      .call("advance", async ({ context }) => {
        context.events.push("failedAdvance");
      })
      .output(() => undefined),
});

describe("background job delivery", () => {
  it("preserves external failure values at the log and persistence boundaries", async () => {
    const context: Context = { events: [] };
    const failure = { message: "Provider unavailable", retryAfter: 30 };
    const observed: unknown[] = [];
    const definition = delivery(
      workflow<Context, undefined>("job.payload")
        .call("provider", async () => {
          throw failure;
        })
        .output(() => "succeeded" as const),
      workflow<Context, undefined>("job.advance").output(() => undefined),
    );
    const failOrRetry = workflow<Context, { error: unknown }>("job.failure")
      .commit("persistFailure", async (_, { input }) => {
        observed.push(input.error);
        return "retry" as const;
      })
      .output(({ persistFailure }) => persistFailure);

    await expect(
      executeBackgroundJobDelivery(
        { ...definition, failOrRetry },
        {
          context,
          payload: undefined,
          onError: (error) => observed.push(error),
        },
      ),
    ).resolves.toBe("retry");
    expect(observed).toHaveLength(2);
    expect(observed[0]).toBe(failure);
    expect(observed[1]).toBe(failure);
  });

  it("settles ordinary failures after payload writes and exposes every child graph", async () => {
    const context: Context = { events: [] };
    const definition = delivery(
      workflow<Context, undefined>("job.payload")
        .commit("payloadWrite", async ({ context }) => {
          context.events.push("payloadWrite");
        })
        .call("provider", async () => {
          throw new Error("provider failed after write");
        })
        .output(() => "succeeded" as const),
      workflow<Context, undefined>("job.advance")
        .call("advance", async ({ context }) => {
          context.events.push("advance");
        })
        .output(() => undefined),
    );

    await expect(
      executeBackgroundJobDelivery(definition, {
        context,
        payload: undefined,
        onError: () => context.events.push("error"),
      }),
    ).resolves.toBe("retry");
    expect(context.events).toEqual(["payloadWrite", "error", "settle"]);
    expect(inspectBackgroundJobDelivery(definition)).toMatchObject({
      name: "job.delivery",
      payload: { name: "job.payload" },
      finish: { name: "job.finish" },
      advance: { name: "job.advance" },
      failOrRetry: { name: "job.fail" },
      failedAdvance: { name: "job.failedAdvance" },
    });
  });

  it("preserves the legacy retry path when advancement fails after finishing", async () => {
    const context: Context = { events: [] };
    const definition = delivery(
      workflow<Context, undefined>("job.payload")
        .call("complete", async () => "succeeded" as const)
        .output(({ complete }) => complete),
      workflow<Context, undefined>("job.advance")
        .call("advance", async ({ context }) => {
          context.events.push("advance");
          throw new Error("dispatch failed");
        })
        .output(() => undefined),
    );

    await expect(
      executeBackgroundJobDelivery(definition, {
        context,
        payload: undefined,
        onError: () => context.events.push("error"),
      }),
    ).resolves.toBe("retry");
    expect(context.events).toEqual(["finish", "advance", "error", "settle"]);
  });

  it("advances failed deliveries exactly once", async () => {
    const context: Context = { events: [] };
    const definition = delivery(
      workflow<Context, undefined>("job.payload")
        .call("run", async () => {
          throw new Error("payload failed");
        })
        .output(() => "succeeded" as const),
      workflow<Context, undefined>("job.advance").output(() => undefined),
      {
        failOrRetry: workflow<Context, { error: unknown }>("job.fail")
          .call("settle", async ({ context }) => {
            context.events.push("settle");
            return "failed" as const;
          })
          .output(({ settle }) => settle),
      },
    );
    await expect(
      executeBackgroundJobDelivery(definition, {
        context,
        payload: undefined,
        onError: () => context.events.push("error"),
      }),
    ).resolves.toBe("failed");
    expect(context.events).toEqual(["error", "settle", "failedAdvance"]);
  });

  it("bubbles workflow effect failures and cancellation without settlement", async () => {
    const context: Context = { events: [] };
    const definition = delivery(
      workflow<Context, undefined>("job.payload")
        .call("run", async () => {
          throw new Error("ordinary");
        })
        .output(() => "succeeded" as const),
      workflow<Context, undefined>("job.advance").output(() => undefined),
    );
    await expect(
      executeBackgroundJobDelivery(definition, {
        context,
        payload: undefined,
        onError: () => context.events.push("error"),
      }),
    ).resolves.toBe("retry");
    expect(context.events).toEqual(["error", "settle"]);
  });

  it("settles a finish rejection and propagates settlement rejection without failed advance", async () => {
    const context: Context = { events: [] };
    const failingFinish = workflow<Context, { status: Status }>("job.finish")
      .call("finish", async () => {
        throw new Error("finish failed");
      })
      .output(() => undefined);
    const finishDefinition = delivery(
      workflow<Context, undefined>("job.payload").output(
        () => "succeeded" as const,
      ),
      workflow<Context, undefined>("job.advance").output(() => undefined),
      { finish: failingFinish },
    );
    await expect(
      executeBackgroundJobDelivery(finishDefinition, {
        context,
        payload: undefined,
        onError: () => context.events.push("error"),
      }),
    ).resolves.toBe("retry");
    expect(context.events).toEqual(["error", "settle"]);

    const rejectedSettlement = delivery(
      workflow<Context, undefined>("job.payload")
        .call("run", async () => {
          throw new Error("payload failed");
        })
        .output(() => "succeeded" as const),
      workflow<Context, undefined>("job.advance").output(() => undefined),
      {
        failOrRetry: workflow<Context, { error: unknown }>("job.fail")
          .call("settle", async () => {
            throw new Error("settle failed");
          })
          .output(() => "retry" as const),
      },
    );
    await expect(
      executeBackgroundJobDelivery(rejectedSettlement, {
        context,
        payload: undefined,
        onError: () => context.events.push("error"),
      }),
    ).rejects.toThrow("settle failed");
    expect(context.events).toEqual(["error", "settle", "error"]);
  });

  it("propagates cancellation without settlement", async () => {
    const context: Context = { events: [] };
    const failure = new WorkflowCancelledError({
      committed: false,
      effectsPending: false,
    });
    const definition = delivery(
      workflow<Context, undefined>("job.payload")
        .call("run", async () => {
          throw failure;
        })
        .output(() => "succeeded" as const),
      workflow<Context, undefined>("job.advance").output(() => undefined),
    );
    await expect(
      executeBackgroundJobDelivery(definition, {
        context,
        payload: undefined,
        onError: () => context.events.push("error"),
      }),
    ).rejects.toBe(failure);
    expect(context.events).toEqual([]);
  });
});

describe("required delivery effects", () => {
  const verify = async (
    payload: BackgroundJobDeliveryDefinition<
      Context,
      undefined,
      Status,
      Outcome
    >["payload"],
    advance: BackgroundJobDeliveryDefinition<
      Context,
      undefined,
      Status,
      Outcome
    >["advance"],
    context: Context,
    failure: Error,
  ) => {
    const settled: unknown[] = [];
    const definition = delivery(payload, advance, {
      failOrRetry: workflow<Context, { error: unknown }>("job.fail")
        .commit("settle", async ({ context }, { input }) => {
          context.events.push("settle");
          settled.push(input.error);
          return "retry" as const;
        })
        .output(({ settle }) => settle),
    });
    const observed: unknown[] = [];
    await expect(
      executeBackgroundJobDelivery(definition, {
        context,
        payload: undefined,
        onError: (error) => observed.push(error),
      }),
    ).resolves.toBe("retry");
    expect(observed).toEqual([failure]);
    expect(settled).toEqual([failure]);
  };

  it("settles a payload effect cause once", async () => {
    const context: Context = { events: [] };
    const failure = new Error("payload dispatch failed");
    await verify(
      workflow<Context, undefined>("job.payload")
        .commit("write", async ({ context }) => {
          context.events.push("payload:write");
        })
        .effect("dispatch", async () => {
          throw failure;
        })
        .output(() => "succeeded" as const),
      workflow<Context, undefined>("job.advance").output(() => undefined),
      context,
      failure,
    );
    expect(context.events).toEqual(["payload:write", "settle"]);
  });

  it("settles an advance effect cause after finishing", async () => {
    const context: Context = { events: [] };
    const failure = new Error("advance dispatch failed");
    await verify(
      workflow<Context, undefined>("job.payload")
        .call("complete", async () => "succeeded" as const)
        .output(({ complete }) => complete),
      workflow<Context, undefined>("job.advance")
        .commit("write", async ({ context }) => {
          context.events.push("advance:write");
        })
        .effect("dispatch", async () => {
          throw failure;
        })
        .output(() => undefined),
      context,
      failure,
    );
    expect(context.events).toEqual(["finish", "advance:write", "settle"]);
  });
});
